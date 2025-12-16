import { App, normalizePath, TFile } from 'obsidian';
import { BlinkoSettings } from './settings';
import { BlinkoClient } from './client';

type Logger = (message: string, ...values: unknown[]) => void;
type SaveHandler = () => Promise<void>;

interface NoteFileEntry {
	id: number;
	file: TFile;
}

export class DeletionManager {
	private isRunning = false;

	constructor(
		private app: App,
		private settings: BlinkoSettings,
		private client: BlinkoClient,
		private persistSettings: SaveHandler,
		private log: Logger,
	) {}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
	}

	async reconcileDeletedNotes(): Promise<number> {
		if (this.isRunning) {
			this.log('Deletion check already running, skipping new request.');
			return 0;
		}

		this.isRunning = true;
			try {
				const entries = this.collectNoteFiles();
				if (!entries.length) {
					return 0;
				}

				const { missingIds, recycledIds } = await this.findMissingAndRecycledNoteIds(
					entries.map((entry) => entry.id),
				);
				const idsToRemove = new Set<number>(missingIds);
				if (this.shouldDeleteRecycledNotes()) {
					for (const id of recycledIds) {
						idsToRemove.add(id);
					}
				}

				if (!idsToRemove.size) {
					return 0;
				}

				const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
				let removedCount = 0;

				for (const id of idsToRemove) {
					const entry = entryMap.get(id);
					if (!entry) {
						continue;
					}
					// eslint-disable-next-line no-await-in-loop
					await this.deleteNote(entry);
					removedCount += 1;
				}

				if (removedCount > 0) {
					await this.persistSettings();
				}

				return removedCount;
			} finally {
				this.isRunning = false;
			}
		}

	private collectNoteFiles(): NoteFileEntry[] {
		const folder = this.settings.noteFolder?.trim();
		const normalizedFolder = folder ? normalizePath(folder) : '';
		const prefix = normalizedFolder ? `${normalizedFolder}/` : '';
		const files = this.app.vault.getFiles();
		const entries: NoteFileEntry[] = [];

		for (const file of files) {
			if (normalizedFolder && !file.path.startsWith(prefix)) {
				continue;
			}

			const match = file.name.match(/^blinko-(\d+)\.md$/);
			if (!match) {
				continue;
			}

			const id = Number(match[1]);
			if (Number.isNaN(id)) {
				continue;
			}

			entries.push({ id, file });
		}

		return entries;
	}

	private async findMissingAndRecycledNoteIds(ids: number[]): Promise<{
		missingIds: number[];
		recycledIds: number[];
	}> {
		const chunkSize = 50;
		const chunks: number[][] = [];
		for (let i = 0; i < ids.length; i += chunkSize) {
			chunks.push(ids.slice(i, i + chunkSize));
		}

		const existingIds = new Set<number>();
		const recycledIds = new Set<number>();
		for (const chunk of chunks) {
			// eslint-disable-next-line no-await-in-loop
			const notes = await this.client.getNotesByIds(chunk);
			for (const note of notes) {
				existingIds.add(note.id);
				if (note.isRecycle) {
					recycledIds.add(note.id);
				}
			}
		}

		return {
			missingIds: ids.filter((id) => !existingIds.has(id)),
			recycledIds: Array.from(recycledIds),
		};
	}

	private async deleteNote(entry: NoteFileEntry) {
		const attachments = await this.getAttachmentsFor(entry);
		this.log(`Removing local note ${entry.file.path} because it no longer exists in Blinko.`);
		await this.app.vault.delete(entry.file);
		await this.deleteAttachments(entry.id, attachments);
	}

	private async deleteAttachments(noteId: number, attachments?: string[]) {
		const key = String(noteId);
		const attachmentMap = this.ensureAttachmentMap();
		const storedAttachments = attachments ?? attachmentMap[key] ?? [];

		if (!storedAttachments.length) {
			delete attachmentMap[key];
			return;
		}

		for (const attachment of storedAttachments) {
			const attachmentPath = this.buildAttachmentPath(attachment);
			try {
				// eslint-disable-next-line no-await-in-loop
				const exists = await this.app.vault.adapter.exists(attachmentPath);
				if (exists) {
					// eslint-disable-next-line no-await-in-loop
					await this.app.vault.adapter.remove(attachmentPath);
				}
			} catch (error) {
				console.error('Failed to delete attachment', attachmentPath, error);
			}
		}

		delete attachmentMap[key];
	}

	private async getAttachmentsFor(entry: NoteFileEntry): Promise<string[]> {
		const key = String(entry.id);
		const attachmentMap = this.ensureAttachmentMap();
		const cached = attachmentMap[key];
		if (cached?.length) {
			return [...cached];
		}

		const fromFrontmatter = await this.extractAttachmentsFromFrontmatter(entry.file);
		if (fromFrontmatter.length) {
			attachmentMap[key] = fromFrontmatter;
			return [...fromFrontmatter];
		}

		const inferred = await this.inferAttachmentsFromContent(entry.file);
		if (inferred.length) {
			attachmentMap[key] = inferred;
			return [...inferred];
		}

		return [];
	}

	private async extractAttachmentsFromFrontmatter(file: TFile): Promise<string[]> {
		const listFromCache = this.extractFromMetadataCache(file);
		if (listFromCache.length) {
			return listFromCache;
		}

		try {
			const content = await this.app.vault.read(file);
			const match = content.match(/^---\s*[\r\n]+([\s\S]*?)\n---/);
			if (!match) {
				return [];
			}
			return this.parseAttachmentLine(match[1]);
		} catch (error) {
			console.error('Failed to read file for attachment metadata', file.path, error);
			return [];
		}
	}

	private extractFromMetadataCache(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		const data = cache?.frontmatter?.blinkoAttachments;
		return this.normalizeAttachmentList(data);
	}

	private parseAttachmentLine(frontmatterBlock: string): string[] {
		const regex = /blinkoAttachments\s*:\s*\[([^\]]*)\]/m;
		const match = regex.exec(frontmatterBlock);
		if (!match) {
			return [];
		}

		const raw = match[1];
		return raw
			.split(',')
			.map((entry) => entry.trim())
			.map((entry) => entry.replace(/^['"]|['"]$/g, ''))
			.map((entry) => entry.replace(/\\"/g, '"'))
			.filter(Boolean);
	}

	private normalizeAttachmentList(value: unknown): string[] {
		if (Array.isArray(value)) {
			return value
				.map((item) => (typeof item === 'string' ? item : String(item ?? '')).trim())
				.filter(Boolean);
		}

		if (typeof value === 'string') {
			return value
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean);
		}

		return [];
	}

	private async inferAttachmentsFromContent(file: TFile): Promise<string[]> {
		try {
			const content = await this.app.vault.read(file);
			const matches = new Set<string>();
			const regex = /!\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g;
			let match: RegExpExecArray | null;
			// eslint-disable-next-line no-cond-assign
			while ((match = regex.exec(content)) !== null) {
				const raw = match[1]?.trim();
				if (raw) {
					const parts = raw.split('/');
					matches.add(parts[parts.length - 1]);
				}
			}

			const attachments: string[] = [];
			for (const candidate of matches) {
				const sanitized = this.sanitizeFilename(candidate);
				if (!sanitized) {
					continue;
				}
				const path = this.buildAttachmentPath(sanitized);
				// eslint-disable-next-line no-await-in-loop
				const exists = await this.app.vault.adapter.exists(path);
				if (exists) {
					attachments.push(sanitized);
				}
			}
			return attachments;
		} catch (error) {
			console.error('Failed to inspect note content for attachments', file.path, error);
			return [];
		}
	}

	private buildAttachmentPath(name: string) {
		const folder = this.settings.attachmentFolder?.trim();
		return folder
			? normalizePath(`${folder}/${name}`)
			: normalizePath(name);
	}

	private ensureAttachmentMap() {
		if (!this.settings.noteAttachmentMap) {
			this.settings.noteAttachmentMap = {};
		}
		return this.settings.noteAttachmentMap;
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, '-');
	}

	private shouldDeleteRecycledNotes(): boolean {
		return Boolean(this.settings.deleteRecycleBinEnabled);
	}
}
