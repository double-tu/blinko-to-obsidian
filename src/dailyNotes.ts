import { App, Notice, TFile, moment, normalizePath } from 'obsidian';
import { BlinkoSettings } from './settings';
import { FlashNoteJournalEntry } from './types';
import { getCachedBlinkoFrontmatter, isBlinkoSourceValue, resolveBlinkoFrontmatter } from './noteMetadata';

type Logger = (message: string, ...values: unknown[]) => void;

interface DailyNoteReferenceBlock {
	filePath: string;
	createdAt: number;
}

interface DailyNoteReferenceGroup {
	title: string;
	refBlocks: DailyNoteReferenceBlock[];
}

type MarkerMatchType = 'exact' | 'whitespace';

interface MarkerSearchResult {
	index: number;
	matchType: MarkerMatchType;
}

interface MarkerBounds {
	startIndex: number;
	endIndex: number;
	normalizedStart: string;
	normalizedEnd: string;
}

interface DailyNoteLookupResult {
	file: TFile;
	created: boolean;
}

interface TemplaterPluginInstance {
	templater?: {
		on_file_creation?: (file: TFile) => Promise<void>;
	};
	settings?: {
		trigger_on_file_creation?: boolean;
	};
}

export class DailyNoteManager {
	private readonly dateKeyFormat = 'YYYYMMDD';
	private templaterMissingNoticeShown = false;
	private templaterTriggerNoticeShown = false;

	constructor(
		private app: App,
		private settings: BlinkoSettings,
		private log: Logger,
	) {}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
	}

	async insertFlashNotes(newNotes: FlashNoteJournalEntry[]): Promise<void> {
		if (!this.settings.dailyNotesToggle) {
			this.log('Daily Notes insertion disabled, skipping Blinko note embedding.');
			return;
		}

		const targets = this.collectTargetDates(newNotes);
		if (!targets.length) {
			this.log('No Blinko notes with valid dates, skipping daily note updates.');
			return;
		}

		this.log(
			'Daily Notes: preparing to insert %d Blinko notes across %d dates.',
			newNotes?.length ?? 0,
			targets.length,
		);

		for (const target of targets) {
			await this.insertFlashNotesForDate(target, newNotes);
		}
	}

	async removeReferenceForFile(file: TFile): Promise<boolean> {
		if (!this.settings.dailyNotesToggle) {
			return false;
		}

		const createdAt = this.resolveCreatedAt(file);
		const createdMoment = moment(createdAt);
		if (!createdMoment.isValid()) {
			return false;
		}

		const targetDate = createdMoment.clone().startOf('day');
		const displayDate = targetDate.format('YYYY-MM-DD');
		const dailyNotePath = this.getDailyNotePath(targetDate);
		if (!dailyNotePath) {
			return false;
		}

		const dailyNote = this.getExistingDailyNote(dailyNotePath);
		if (!dailyNote) {
			this.log(
				'Daily Notes: no existing note found at %s for %s while removing reference to %s.',
				dailyNotePath,
				displayDate,
				file.path,
			);
			return false;
		}

		const content = await this.app.vault.read(dailyNote);
		const { updatedContent, removed } = this.removeReferenceFromContent(dailyNote.path, content, file.path);
		if (!removed) {
			this.log('Daily Notes: reference to %s not found in %s.', file.path, dailyNote.path);
			return false;
		}

		await this.app.vault.modify(dailyNote, updatedContent);
		this.log('Daily Notes: removed reference to %s from %s for %s.', file.path, dailyNote.path, displayDate);
		return true;
	}

	private collectTargetDates(newNotes: FlashNoteJournalEntry[]): moment.Moment[] {
		const unique = new Map<string, moment.Moment>();
		for (const note of newNotes ?? []) {
			const created = moment(note.createdAt);
			if (!created.isValid()) {
				continue;
			}

			const normalized = created.clone().startOf('day');
			const key = normalized.format(this.dateKeyFormat);
			if (!unique.has(key)) {
				unique.set(key, normalized);
			}
		}

		return Array.from(unique.values()).sort((a, b) => a.valueOf() - b.valueOf());
	}

	private async insertFlashNotesForDate(targetDate: moment.Moment, newNotes: FlashNoteJournalEntry[]): Promise<void> {
		const dailyNotePath = this.getDailyNotePath(targetDate);
		if (!dailyNotePath) {
			return;
		}

		const displayDate = targetDate.format('YYYY-MM-DD');
		this.log('Daily Notes: processing %s at %s.', displayDate, dailyNotePath);

		try {
			const lookup = await this.getOrCreateDailyNote(dailyNotePath, displayDate);
			if (!lookup) {
				this.log(`Daily Note not found for ${displayDate} at ${dailyNotePath}, skipping.`);
				return;
			}

			const { file, created } = lookup;
			if (created) {
				await this.waitForTemplateProcessing(file);
				this.log('Daily Notes: created note at %s.', file.path);
			} else {
				this.log('Daily Notes: found existing note at %s.', file.path);
			}

			const allNotes = await this.collectBlinkoNotesForDate(targetDate, newNotes);
			const references = this.buildReferenceGroups(allNotes);
			if (!references.length) {
				this.log(`No Blinko notes to insert for ${displayDate}, skipping daily note update.`);
				return;
			}

			const blockCount = references.reduce((total, group) => total + group.refBlocks.length, 0);
			this.log('Daily Notes: inserting %d references into %s for %s.', blockCount, file.path, displayDate);
			await this.saveReferences(file, references);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			this.log(`Failed to insert Daily Note references: ${reason}`);
		}
	}

	private async collectBlinkoNotesForDate(
		targetDate: moment.Moment,
		newNotes: FlashNoteJournalEntry[],
	): Promise<FlashNoteJournalEntry[]> {
		const targetKey = targetDate.format(this.dateKeyFormat);
		const aggregated = new Map<number, FlashNoteJournalEntry>();
		const displayDate = targetDate.format('YYYY-MM-DD');
		let syncedMatches = 0;

		for (const note of newNotes ?? []) {
			const noteKey = this.getMomentKey(note.createdAt);
			if (noteKey !== targetKey) {
				continue;
			}
			aggregated.set(note.id, note);
			syncedMatches += 1;
		}

		const fromVault = await this.loadBlinkoNotesFromVault(targetDate);
		for (const entry of fromVault) {
			aggregated.set(entry.id, entry);
		}

		this.log(
			'Daily Notes: collected %d Blinko notes for %s (synced: %d, vault snapshots: %d).',
			aggregated.size,
			displayDate,
			syncedMatches,
			fromVault.length,
		);

		return Array.from(aggregated.values()).sort(
			(a, b) => this.getTimestamp(a.createdAt) - this.getTimestamp(b.createdAt),
		);
	}

	private async loadBlinkoNotesFromVault(targetDate: moment.Moment): Promise<FlashNoteJournalEntry[]> {
		const normalizedFolder = this.normalizeFolder(this.settings.noteFolder);
		const files = this.app.vault.getFiles();
		const targetKey = targetDate.format(this.dateKeyFormat);
		const snapshots: FlashNoteJournalEntry[] = [];
		for (const file of files) {
			const cached = getCachedBlinkoFrontmatter(this.app, file);
			const baseCandidate = this.isBlinkoNoteFile(file.path, normalizedFolder, cached?.source ?? null);
			if (!baseCandidate && normalizedFolder) {
				continue;
			}

			let meta = cached;
			if (!baseCandidate && !normalizedFolder) {
				// eslint-disable-next-line no-await-in-loop
				meta = await resolveBlinkoFrontmatter(this.app, file);
			} else if (!meta?.id) {
				// eslint-disable-next-line no-await-in-loop
				meta = await resolveBlinkoFrontmatter(this.app, file);
			}

			if (!meta?.id) {
				continue;
			}

			if (!this.isBlinkoNoteFile(file.path, normalizedFolder, meta.source ?? null)) {
				continue;
			}

			const createdAt = this.resolveCreatedAt(file);
			const noteKey = this.getMomentKey(createdAt);
			if (noteKey !== targetKey) {
				continue;
			}

			snapshots.push({
				id: meta.id,
				createdAt,
				filePath: file.path,
			});
		}

		const label = targetDate.format('YYYY-MM-DD');
		this.log('Daily Notes: located %d existing Blinko notes in vault for %s.', snapshots.length, label);
		return snapshots;
	}

	private buildReferenceGroups(notes: FlashNoteJournalEntry[]): DailyNoteReferenceGroup[] {
		if (!notes.length) {
			return [];
		}

		const blocks: DailyNoteReferenceBlock[] = notes
			.filter((note) => Boolean(note.filePath))
			.map((note) => ({
				filePath: this.toLinkPath(note.filePath),
				createdAt: this.getTimestamp(note.createdAt),
			}))
			.sort((a, b) => a.createdAt - b.createdAt);

		if (!blocks.length) {
			return [];
		}

		return [
			{
				title: 'Blinko Notes',
				refBlocks: blocks,
			},
		];
	}

	private async saveReferences(file: TFile, references: DailyNoteReferenceGroup[]): Promise<void> {
		const content = await this.app.vault.read(file);
		const payload = this.renderReferences(references);
		let updated: string;
		try {
			updated = this.replaceRegion(file.path, content, payload);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			new Notice(reason);
			return;
		}

		if (updated === content) {
			this.log('Daily Notes: no changes detected for %s (markers already contain latest references).', file.path);
			return;
		}

		this.log('Daily Notes: writing updated references into %s.', file.path);
		await this.app.vault.modify(file, updated);
		this.log('Daily Notes: update complete for %s.', file.path);
	}

	private renderReferences(groups: DailyNoteReferenceGroup[]): string {
		if (!groups.length) {
			return '';
		}

		const embedContent = Boolean(this.settings.dailyNotesEmbedContent);
		const sections = groups.map((group) => {
			const header = `### ${group.title}`;
			const references = group.refBlocks.map((block) => this.renderReferenceLine(block, embedContent));
			return `${header}\n${references.join('\n')}`;
		});

		return `\n${sections.join('\n\n')}\n`;
	}

	private renderReferenceLine(block: DailyNoteReferenceBlock, embedContent: boolean): string {
		const linkTarget = block.filePath;
		const link = embedContent ? `![[${linkTarget}]]` : `[[${linkTarget}]]`;
		return `> ${link}`;
	}

	private replaceRegion(filePath: string, content: string, payload: string): string {
		const lines = content.replace(/\r\n/g, '\n').split('\n');
		const bounds = this.resolveMarkerBounds(filePath, lines);
		this.log(
			'Daily Notes: replacing content between markers (%s -> %s) in %s.',
			`line ${bounds.startIndex + 1}`,
			`line ${bounds.endIndex + 1}`,
			filePath,
		);

		const before = lines.slice(0, bounds.startIndex + 1);
		const after = lines.slice(bounds.endIndex);
		const payloadLines = payload ? payload.replace(/\r\n/g, '\n').split('\n') : [];
		const merged = [...before, ...payloadLines, ...after];
		return merged.join('\n');
	}

	private removeReferenceFromContent(
		filePath: string,
		content: string,
		targetFilePath: string,
	): { updatedContent: string; removed: boolean } {
		const lines = content.replace(/\r\n/g, '\n').split('\n');
		let bounds: MarkerBounds;
		try {
			bounds = this.resolveMarkerBounds(filePath, lines);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			this.log('Daily Notes: %s. Skipping reference cleanup for %s.', reason, filePath);
			return { updatedContent: content, removed: false };
		}

		const regionStart = bounds.startIndex + 1;
		const regionEnd = bounds.endIndex;
		if (regionStart >= regionEnd) {
			return { updatedContent: content, removed: false };
		}

		const linkTarget = this.toLinkPath(targetFilePath);
		const referenceRegex = this.buildReferenceRegex(linkTarget);
		let removed = false;
		const regionLines = lines.slice(regionStart, regionEnd);
		const filtered = regionLines.filter((line) => {
			if (!referenceRegex.test(line)) {
				return true;
			}
			removed = true;
			return false;
		});

		if (!removed) {
			return { updatedContent: content, removed: false };
		}

		const hasReferences = filtered.some((line) => line.trim().startsWith('>'));
		const normalizedRegion = hasReferences ? filtered : [];
		const before = lines.slice(0, regionStart);
		const after = lines.slice(regionEnd);
		const updatedLines = [...before, ...normalizedRegion, ...after];
		return { updatedContent: updatedLines.join('\n'), removed: true };
	}

	private resolveMarkerBounds(filePath: string, lines: string[]): MarkerBounds {
		const startMarker = (this.settings.dailyNotesInsertAfter || '').trim();
		const endMarker = (this.settings.dailyNotesInsertBefore || '').trim();

		const normalizedStart = startMarker || '<!-- start of flash-notes -->';
		const normalizedEnd = endMarker || '<!-- end of flash-notes -->';

		const startLookup = this.findMarkerIndex(lines, normalizedStart);
		if (!startLookup) {
			this.logMissingMarker(filePath, 'start', normalizedStart, lines, 0);
			throw new Error(`Daily Notes start marker not found: "${normalizedStart}"`);
		}

		this.logMarkerMatch(
			filePath,
			'start',
			normalizedStart,
			startLookup.index + 1,
			startLookup.matchType,
			lines[startLookup.index],
		);

		const afterStartIndex = startLookup.index + 1;
		const trailingLines = lines.slice(afterStartIndex);
		const endLookup = this.findMarkerIndex(trailingLines, normalizedEnd);
		if (!endLookup) {
			this.logMissingMarker(filePath, 'end', normalizedEnd, trailingLines, afterStartIndex);
			throw new Error(`Daily Notes end marker not found: "${normalizedEnd}"`);
		}

		const absoluteEndIndex = afterStartIndex + endLookup.index;
		this.logMarkerMatch(
			filePath,
			'end',
			normalizedEnd,
			absoluteEndIndex + 1,
			endLookup.matchType,
			lines[absoluteEndIndex],
		);

		return {
			startIndex: startLookup.index,
			endIndex: absoluteEndIndex,
			normalizedStart,
			normalizedEnd,
		};
	}

	private getExistingDailyNote(path: string): TFile | null {
		const abstract = this.app.vault.getAbstractFileByPath(path);
		return abstract instanceof TFile ? abstract : null;
	}

	private async getOrCreateDailyNote(path: string, displayDate: string): Promise<DailyNoteLookupResult | null> {
		const existing = this.getExistingDailyNote(path);
		if (existing) {
			return { file: existing, created: false };
		}

		if (!this.settings.dailyNotesAutoCreate) {
			this.log(
				'Daily Notes: no note found at %s for %s, and auto-creation is disabled. Skipping templated creation.',
				path,
				displayDate,
			);
			return null;
		}

		const file = await this.createDailyNote(path, displayDate);
		return file ? { file, created: true } : null;
	}

	private async createDailyNote(path: string, displayDate: string): Promise<TFile | null> {
		const normalizedPath = normalizePath(path);
		const folder = this.getFolderFromPath(normalizedPath);
		this.log('Daily Notes: auto-creating missing note for %s at %s.', displayDate, normalizedPath);

		try {
			await this.ensureFolderExists(folder);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			this.log('Daily Notes: unable to create folder %s for %s. %s', folder || '<vault root>', normalizedPath, reason);
			new Notice(`Failed to create folder for Daily Note (${folder || 'vault root'}): ${reason}`);
			return null;
		}

		try {
			const file = await this.app.vault.create(normalizedPath, '');
			await this.triggerTemplaterForFile(file, displayDate);
			return file;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			if (/exists/i.test(reason)) {
				this.log('Daily Notes: detected concurrent creation for %s. Reusing existing file.', normalizedPath);
				return this.getExistingDailyNote(normalizedPath);
			}

			this.log('Daily Notes: failed to create %s for %s: %s', normalizedPath, displayDate, reason);
			new Notice(`Failed to create Daily Note (${displayDate}): ${reason}`);
			return null;
		}
	}

	private getFolderFromPath(path: string): string {
		const separatorIndex = path.lastIndexOf('/');
		if (separatorIndex === -1) {
			return '';
		}
		return path.slice(0, separatorIndex);
	}

	private async ensureFolderExists(folder: string): Promise<void> {
		if (!folder) {
			return;
		}

		const normalized = normalizePath(folder);
		const segments = normalized.split('/').filter((segment) => segment.length);
		let current = '';

		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			// eslint-disable-next-line no-await-in-loop
			const exists = await this.app.vault.adapter.exists(current);
			if (exists) {
				continue;
			}

			try {
				// eslint-disable-next-line no-await-in-loop
				await this.app.vault.createFolder(current);
				this.log('Daily Notes: created folder %s for auto-generated notes.', current);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error ?? '');
				if (/exist/i.test(reason)) {
					continue;
				}
				throw error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
			}
		}
	}

	private async triggerTemplaterForFile(file: TFile, displayDate: string): Promise<void> {
		const templater = this.getTemplaterPlugin();
		if (!templater?.templater?.on_file_creation) {
			if (!this.templaterMissingNoticeShown) {
				new Notice(
					'Templater plugin is required to auto-create Daily Notes. Please install and enable templater-obsidian.',
				);
				this.templaterMissingNoticeShown = true;
			}
			this.log(
				'Daily Notes: Templater plugin missing or incompatible while creating %s. Created blank note at %s.',
				displayDate,
				file.path,
			);
			return;
		}

		if (templater.settings && templater.settings.trigger_on_file_creation === false && !this.templaterTriggerNoticeShown) {
			new Notice('Templater setting "Trigger on new file creation" is disabled. Folder templates may not run.');
			this.templaterTriggerNoticeShown = true;
		}

		try {
			await templater.templater.on_file_creation(file);
			this.log('Daily Notes: triggered Templater folder template for %s.', file.path);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			this.log('Daily Notes: Templater failed while processing %s: %s', file.path, reason);
			new Notice(`Templater failed to initialize ${file.basename}: ${reason}`);
		}
	}

	private async waitForTemplateProcessing(file: TFile): Promise<void> {
		const delayMs = Math.max(0, this.settings.dailyNotesTemplateDelayMs || 0);
		if (!delayMs) {
			return;
		}

		this.log('Daily Notes: waiting %dms for template population of %s.', delayMs, file.path);
		await this.delay(delayMs);
	}

	private async delay(ms: number): Promise<void> {
		if (ms <= 0) {
			return;
		}
		await new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	private getTemplaterPlugin(): TemplaterPluginInstance | null {
		const pluginManager = (this.app as App & { plugins?: { getPlugin(id: string): unknown } }).plugins;
		if (!pluginManager) {
			return null;
		}
		const templater = pluginManager.getPlugin('templater-obsidian');
		return templater ? (templater as unknown as TemplaterPluginInstance) : null;
	}

	private getDailyNotePath(targetDate: moment.Moment): string | null {
		const format = this.settings.dailyNotesFormat?.trim() || 'YYYY-MM-DD';
		let fileName: string;
		try {
			fileName = targetDate.format(format);
		} catch (error) {
			new Notice(`Daily Notes format invalid: ${format}`);
			return null;
		}

		fileName = fileName.trim();
		if (!fileName.length) {
			new Notice('Daily Notes format produced an empty file name.');
			return null;
		}

		const folderSetting = this.normalizeFolder(this.settings.dailyNotesLocation);
		const folder = folderSetting ? folderSetting : '';
		const fullPath = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;
		return normalizePath(fullPath);
	}

	private isBlinkoNoteFile(filePath: string, normalizedFolder: string, source?: string | null): boolean {
		if (normalizedFolder && this.pathStartsWithFolder(filePath, normalizedFolder)) {
			return true;
		}
		return isBlinkoSourceValue(source);
	}

	private normalizeFolder(input?: string): string {
		const trimmed = (input ?? '').trim();
		if (!trimmed || trimmed === '/' || trimmed === '.') {
			return '';
		}
		return normalizePath(trimmed);
	}

	private pathStartsWithFolder(filePath: string, folder: string): boolean {
		if (!folder) {
			return true;
		}

		if (filePath === folder) {
			return true;
		}

		return filePath.startsWith(`${folder}/`);
	}

	private resolveCreatedAt(file: TFile): string {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const fromFrontmatter =
			frontmatter?.date ?? frontmatter?.created ?? frontmatter?.createdAt ?? frontmatter?.blinkoCreatedAt;
		if (typeof fromFrontmatter === 'string' && fromFrontmatter.trim().length) {
			return fromFrontmatter.trim();
		}

		if (typeof fromFrontmatter === 'number' && Number.isFinite(fromFrontmatter)) {
			return new Date(fromFrontmatter).toISOString();
		}

		return new Date(file.stat.ctime).toISOString();
	}

	private toLinkPath(filePath: string): string {
		if (filePath.toLowerCase().endsWith('.md')) {
			return filePath.slice(0, -3);
		}
		return filePath;
	}

	private getMomentKey(value: string): string | null {
		const date = moment(value);
		if (!date.isValid()) {
			return null;
		}
		return date.format(this.dateKeyFormat);
	}

	private getTimestamp(value: string): number {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : 0;
	}

	private buildReferenceRegex(linkTarget: string): RegExp {
		const escaped = this.escapeRegExp(linkTarget);
		return new RegExp(`!?\\[\\[${escaped}(?:\\|[^\\]]*)?\\]\\]`);
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private findMarkerIndex(lines: string[], marker: string): MarkerSearchResult | null {
		const normalizedMarker = marker.trim();
		const exactIndex = lines.findIndex((line) => line.trim() === normalizedMarker);
		if (exactIndex !== -1) {
			return { index: exactIndex, matchType: 'exact' };
		}

		const collapsedMarker = this.normalizeMarkerForComparison(normalizedMarker);
		const relaxedIndex = lines.findIndex(
			(line) => this.normalizeMarkerForComparison(line.trim()) === collapsedMarker,
		);
		if (relaxedIndex !== -1) {
			return { index: relaxedIndex, matchType: 'whitespace' };
		}

		return null;
	}

	private normalizeMarkerForComparison(value: string): string {
		return value.replace(/\s+/g, '');
	}

	private logMarkerMatch(
		filePath: string,
		type: 'start' | 'end',
		marker: string,
		lineNumber: number,
		matchType: MarkerMatchType,
		lineValue: string,
	): void {
		const matchDescription = matchType === 'exact' ? 'exact' : 'whitespace-insensitive';
		this.log(
			'Daily Notes: %s marker found in %s on line %d using %s match. Expected "%s", line content "%s".',
			type,
			filePath,
			lineNumber,
			matchDescription,
			marker,
			lineValue.trim(),
		);
	}

	private logMissingMarker(
		filePath: string,
		type: 'start' | 'end',
		marker: string,
		lines: string[],
		lineOffset: number,
	): void {
		const preview = this.buildLinePreview(lines, lineOffset);
		this.log(
			'Daily Notes: %s marker "%s" not found in %s starting at line %d. Preview: %s',
			type,
			marker,
			filePath,
			lineOffset + 1,
			preview || '<no lines>',
		);
	}

	private buildLinePreview(lines: string[], lineOffset: number): string {
		return lines
			.slice(0, 5)
			.map((line, index) => `[${lineOffset + index + 1}] ${line.trim()}`)
			.join(' | ');
	}
}
