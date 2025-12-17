import { App, Notice, TFile, moment, normalizePath } from 'obsidian';
import { BlinkoSettings } from './settings';
import { FlashNoteJournalEntry } from './types';
import { buildBlinkoBlockId } from './noteUtils';

type Logger = (message: string, ...values: unknown[]) => void;

interface DailyNoteReferenceBlock {
	blockId: string;
	filePath: string;
	createdAt: number;
}

interface DailyNoteReferenceGroup {
	title: string;
	refBlocks: DailyNoteReferenceBlock[];
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

	async insertFlashNotes(targetDate: moment.Moment, newNotes: FlashNoteJournalEntry[]): Promise<void> {
		if (!this.settings.dailyNotesToggle) {
			return;
		}

		const dailyNotePath = this.getDailyNotePath(targetDate);
		if (!dailyNotePath) {
			return;
		}

		try {
			const allNotes = await this.collectFlashNotesForDate(targetDate, newNotes);
			const references = this.buildReferenceGroups(allNotes);
			await this.saveReferences(dailyNotePath, references);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			this.log(`Failed to insert Daily Note references: ${reason}`);
		}
	}

	private async collectFlashNotesForDate(
		targetDate: moment.Moment,
		newNotes: FlashNoteJournalEntry[],
	): Promise<FlashNoteJournalEntry[]> {
		const targetKey = targetDate.format(this.dateKeyFormat);
		const aggregated = new Map<number, FlashNoteJournalEntry>();

		for (const note of newNotes ?? []) {
			const noteKey = this.getMomentKey(note.createdAt);
			if (noteKey !== targetKey) {
				continue;
			}
			aggregated.set(note.id, note);
		}

		const fromVault = await this.loadFlashNotesFromVault(targetDate);
		for (const entry of fromVault) {
			aggregated.set(entry.id, entry);
		}

		return Array.from(aggregated.values()).sort(
			(a, b) => this.getTimestamp(a.createdAt) - this.getTimestamp(b.createdAt),
		);
	}

	private async loadFlashNotesFromVault(targetDate: moment.Moment): Promise<FlashNoteJournalEntry[]> {
		const flashFolderPath = this.getFlashFolderPath();
		if (!flashFolderPath) {
			return [];
		}

		const files = this.app.vault.getFiles();
		const prefix = `${flashFolderPath}/`;
		const targetKey = targetDate.format(this.dateKeyFormat);
		const snapshots: FlashNoteJournalEntry[] = [];
		for (const file of files) {
			if (!file.path.startsWith(prefix)) {
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
				blockId: buildBlinkoBlockId(id),
			});
		}

		return snapshots;
	}

	private buildReferenceGroups(notes: FlashNoteJournalEntry[]): DailyNoteReferenceGroup[] {
		if (!notes.length) {
			return [];
		}

		const blocks: DailyNoteReferenceBlock[] = notes
			.filter((note) => Boolean(note.blockId && note.filePath))
			.map((note) => ({
				blockId: note.blockId,
				filePath: this.toLinkPath(note.filePath),
				createdAt: this.getTimestamp(note.createdAt),
			}))
			.sort((a, b) => a.createdAt - b.createdAt);

		if (!blocks.length) {
			return [];
		}

		return [
			{
				title: 'Flash Notes',
				refBlocks: blocks,
			},
		];
	}

	private async saveReferences(path: string, references: DailyNoteReferenceGroup[]): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Daily Note not found, please create: ${path}`);
			return;
		}

		const content = await this.app.vault.read(file);
		const payload = this.renderReferences(references);
		let updated: string;
		try {
			updated = this.replaceRegion(content, payload);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error ?? '');
			new Notice(reason);
			return;
		}

		if (updated === content) {
			return;
		}

		await this.app.vault.modify(file, updated);
	}

	private renderReferences(groups: DailyNoteReferenceGroup[]): string {
		if (!groups.length) {
			return '';
		}

		const sections = groups.map((group) => {
			const header = `### ${group.title}`;
			const embeds = group.refBlocks.map((block) => `![[${block.filePath}#^${block.blockId}]]`);
			return `${header}\n${embeds.join('\n')}`;
		});

		return `\n${sections.join('\n\n')}\n`;
	}

	private replaceRegion(content: string, payload: string): string {
		const startMarker = (this.settings.dailyNotesInsertAfter || '').trim();
		const endMarker = (this.settings.dailyNotesInsertBefore || '').trim();

		const normalizedStart = startMarker || '<!-- start of flash-notes -->';
		const normalizedEnd = endMarker || '<!-- end of flash-notes -->';

		const lines = content.replace(/\r\n/g, '\n').split('\n');
		const startIndex = lines.findIndex((line) => line.trim() === normalizedStart);
		if (startIndex === -1) {
			throw new Error(`Daily Notes start marker not found: "${normalizedStart}"`);
		}

		const endIndex = lines.slice(startIndex + 1).findIndex((line) => line.trim() === normalizedEnd);
		if (endIndex === -1) {
			throw new Error(`Daily Notes end marker not found: "${normalizedEnd}"`);
		}

		const absoluteEndIndex = startIndex + 1 + endIndex;
		const before = lines.slice(0, startIndex + 1);
		const after = lines.slice(absoluteEndIndex);
		const payloadLines = payload ? payload.replace(/\r\n/g, '\n').split('\n') : [];
		const merged = [...before, ...payloadLines, ...after];
		return merged.join('\n');
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

	private getFlashFolderPath(): string {
		const baseFolder = this.normalizeFolder(this.settings.noteFolder);
		const folder = baseFolder ? `${baseFolder}/Flash` : 'Flash';
		return normalizePath(folder);
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
}
