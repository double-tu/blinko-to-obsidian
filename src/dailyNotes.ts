import { App, Notice, TFile, moment, normalizePath } from 'obsidian';
import { BlinkoSettings } from './settings';
import { FlashNoteJournalEntry } from './types';

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

export class DailyNoteManager {
	private readonly dateKeyFormat = 'YYYYMMDD';

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
			const file = this.getExistingDailyNote(dailyNotePath);
			if (!file) {
				this.log(`Daily Note not found for ${displayDate} at ${dailyNotePath}, skipping.`);
				return;
			}

			this.log('Daily Notes: found existing note at %s.', file.path);
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
		const folders = this.getBlinkoNoteFolders();
		if (!folders.length) {
			return [];
		}

		const files = this.app.vault.getFiles();
		const targetKey = targetDate.format(this.dateKeyFormat);
		const snapshots: FlashNoteJournalEntry[] = [];
		for (const file of files) {
			if (!this.isBlinkoNotePath(file.path, folders)) {
				continue;
			}

			const id = this.parseNoteId(file.name);
			if (id === null) {
				continue;
			}

			const createdAt = this.resolveCreatedAt(file);
			const noteKey = this.getMomentKey(createdAt);
			if (noteKey !== targetKey) {
				continue;
			}

			snapshots.push({
				id,
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
		const startMarker = (this.settings.dailyNotesInsertAfter || '').trim();
		const endMarker = (this.settings.dailyNotesInsertBefore || '').trim();

		const normalizedStart = startMarker || '<!-- start of flash-notes -->';
		const normalizedEnd = endMarker || '<!-- end of flash-notes -->';

		const lines = content.replace(/\r\n/g, '\n').split('\n');
		const startLookup = this.findMarkerIndex(lines, normalizedStart);
		if (!startLookup) {
			this.logMissingMarker(filePath, 'start', normalizedStart, lines, 0);
			throw new Error(`Daily Notes start marker not found: "${normalizedStart}"`);
		}

		this.logMarkerMatch(filePath, 'start', normalizedStart, startLookup.index + 1, startLookup.matchType, lines[startLookup.index]);

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

		this.log(
			'Daily Notes: replacing content between markers (%s -> %s) in %s.',
			`line ${startLookup.index + 1}`,
			`line ${absoluteEndIndex + 1}`,
			filePath,
		);

		const before = lines.slice(0, startLookup.index + 1);
		const after = lines.slice(absoluteEndIndex);
		const payloadLines = payload ? payload.replace(/\r\n/g, '\n').split('\n') : [];
		const merged = [...before, ...payloadLines, ...after];
		return merged.join('\n');
	}

	private getExistingDailyNote(path: string): TFile | null {
		const abstract = this.app.vault.getAbstractFileByPath(path);
		return abstract instanceof TFile ? abstract : null;
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

	private getBlinkoNoteFolders(): string[] {
		const folders = new Set<string>();
		const baseFolder = this.normalizeFolder(this.settings.noteFolder);
		const typeFolders = ['Flash', 'Note', 'Todo'];

		for (const typeFolder of typeFolders) {
			const resolved = baseFolder ? `${baseFolder}/${typeFolder}` : typeFolder;
			const normalized = this.normalizeFolder(resolved);
			if (normalized) {
				folders.add(normalized);
			}
		}

		if (baseFolder) {
			folders.add(baseFolder);
		} else {
			folders.add('');
		}

		return Array.from(folders);
	}

	private isBlinkoNotePath(filePath: string, folders: string[]): boolean {
		return folders.some((folder) => this.pathStartsWithFolder(filePath, folder));
	}

	private pathStartsWithFolder(filePath: string, folder: string): boolean {
		if (!folder) {
			return !filePath.includes('/');
		}
		const normalizedFolder = folder.endsWith('/') ? folder : `${folder}/`;
		return filePath.startsWith(normalizedFolder);
	}

	private normalizeFolder(input?: string): string {
		const trimmed = (input ?? '').trim();
		if (!trimmed || trimmed === '/' || trimmed === '.') {
			return '';
		}
		return normalizePath(trimmed);
	}

	private parseNoteId(filename: string): number | null {
		const match = filename.match(/^blinko-(\d+)\.md$/i);
		if (!match) {
			return null;
		}
		const value = Number(match[1]);
		return Number.isNaN(value) ? null : value;
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
