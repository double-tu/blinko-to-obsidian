import { App, normalizePath, TFile, TFolder, moment } from 'obsidian';
import { BlinkoSettings } from './settings';
import { BlinkoNote, BlinkoTag } from './types';
import { BlinkoClient } from './client';
import { AiTitleService } from './aiTitleService';
import { getCachedBlinkoFrontmatter, isBlinkoSourceValue, resolveBlinkoFrontmatter } from './noteMetadata';

type Logger = (message: string, ...values: unknown[]) => void;

export interface SavedNoteResult {
	attachments: string[];
	filePath: string;
}

export class VaultAdapter {
	private notePathIndex: Map<number, string> | null = null;
	private notePathIndexPromise: Promise<Map<number, string>> | null = null;

	constructor(
		private app: App,
		private settings: BlinkoSettings,
		private client: BlinkoClient,
		private aiTitleService: AiTitleService,
		private log: Logger,
	) {}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
		this.aiTitleService.updateSettings(settings);
		this.notePathIndex = null;
		this.notePathIndexPromise = null;
	}

	async saveNote(note: BlinkoNote): Promise<SavedNoteResult> {
		const { block: attachmentBlock, storedAttachments, content } = await this.processAttachments(note);
		const finalTitle = await this.resolveNoteTitle(note, content);
		const markdown = this.generateMarkdown(note, attachmentBlock, storedAttachments, content);
		const filePath = this.buildNotePath(note, content, finalTitle);
		const existingFile = await this.findExistingNoteFile(note.id);
		if (existingFile && existingFile.path !== filePath) {
			await this.ensureFolderForFile(filePath);
			await this.app.vault.rename(existingFile, filePath);
		}
		await this.writeOrUpdate(filePath, markdown);
		this.registerNotePath(note.id, filePath);
		this.log(`Saved note ${filePath}`);
		return {
			attachments: storedAttachments,
			filePath,
		};
	}

	private async processAttachments(note: BlinkoNote): Promise<{ block: string; storedAttachments: string[]; content: string }> {
		const attachments = note.attachments ?? [];
		if (!attachments.length) {
			return { block: '', storedAttachments: [], content: note.content ?? '' };
		}

		const references: string[] = [];
		const storedAttachments: string[] = [];
		let content = note.content ?? '';
		for (const attachment of attachments) {
			const name = this.sanitizeFilename(
				attachment.name || `attachment-${attachment.id}`,
			);
			if (!attachment.path) {
				references.push(`> [!warning] Attachment missing path: ${name}`);
				continue;
			}
			const attachmentPath = this.buildAttachmentPath(name);
			try {
				const exists = await this.app.vault.adapter.exists(attachmentPath);
				if (!exists) {
					const data = await this.client.downloadFile(attachment.path);
					await this.ensureFolderForFile(attachmentPath);
					await this.app.vault.adapter.writeBinary(attachmentPath, data);
					this.log(`Downloaded attachment ${attachmentPath}`);
				} else {
					this.log(`Attachment exists, skipping ${attachmentPath}`);
				}

				const remoteUrl = this.client.resolveUrl(attachment.path, { absoluteFromOrigin: true });
				content = this.replaceAttachmentReference(content, remoteUrl, name);
				content = this.replaceAttachmentReference(content, attachment.path, name);

				storedAttachments.push(name);
				if (!content.includes(name)) {
					references.push(`![[${name}]]`);
				}
			} catch (error) {
				console.error('Failed to download attachment', error);
				references.push(`> [!warning] Attachment download failed: ${name}`);
			}
		}

		const block = references.length ? `\n\n${references.join('\n')}` : '';
		return { block, storedAttachments, content };
	}

	private generateMarkdown(
		note: BlinkoNote,
		attachmentBlock: string,
		attachments: string[],
		content: string,
	) {
		const frontmatterLines = [
			'---',
			`id: ${note.id}`,
			`date: ${this.formatLocalTimestamp(note.createdAt)}`,
			`updated: ${this.formatLocalTimestamp(note.updatedAt)}`,
			'source: blinko',
			`blinkoType: ${this.mapType(note.type)}`,
			`blinkoTypeCode: ${typeof note.type === 'number' ? note.type : 0}`,
			`blinkoAttachments: [${attachments.map(this.quoteAttachment).join(', ')}]`,
		];

		if (this.settings.includeFrontmatterTags) {
			const tags = this.collectTags(note.tags ?? []);
			frontmatterLines.push(`tags: [${tags.map(this.quoteTag).join(', ')}]`);
		}

		frontmatterLines.push('---', '');
		const frontmatter = frontmatterLines.join('\n');

		const body = content ?? '';
		const composedBody = `${body}${attachmentBlock}`;
		const normalizedBody = this.ensureTrailingNewline(composedBody);
		return `${frontmatter}${normalizedBody}`;
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, '-');
	}

	private quoteTag = (tag: string): string => {
		if (!tag.length) {
			return '';
		}

		return /\s/.test(tag) ? `"${tag}"` : tag;
	};

	private quoteAttachment = (name: string): string => {
		if (!name.length) {
			return '';
		}

		return `"${name.replace(/"/g, '\\"')}"`;
	};

	private replaceAttachmentReference(content: string, target: string, localName: string): string {
		if (!target || !content.includes(target)) {
			return content;
		}

		const escaped = this.escapeRegExp(target);
		const embedRegex = new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g');
		const linkRegex = new RegExp(`\\[([^\\]]*)\\]\\(${escaped}\\)`, 'g');

		let result = content.replace(embedRegex, () => `![[${localName}]]`);
		result = result.replace(linkRegex, (_match, label: string) => {
			const alias = (label ?? '').trim();
			return alias ? `[[${localName}|${alias}]]` : `[[${localName}]]`;
		});

		return result;
	}

	private collectTags(rawTags: BlinkoTag[]): string[] {
		const resolved = rawTags
			.map((tag) => tag?.tag ?? tag)
			.filter((tag): tag is BlinkoTag => Boolean(tag));
		const tagMap = new Map<number, BlinkoTag>();
		const parentsWithChildren = new Set<number>();

		for (const tag of resolved) {
			if (tag.id !== undefined) {
				tagMap.set(tag.id, tag);
			}
			const parentId = typeof tag.parent === 'number' ? tag.parent : undefined;
			if (parentId !== undefined) {
				parentsWithChildren.add(parentId);
			}
		}

		const unique = new Set<string>();
		for (const tag of resolved) {
			if (tag.id !== undefined && parentsWithChildren.has(tag.id)) {
				continue;
			}
			const path = this.buildTagPath(tag, tagMap);
			if (path) {
				unique.add(path);
			}
		}

		return Array.from(unique);
	}

	private buildTagPath(tag?: BlinkoTag | null, tagMap?: Map<number, BlinkoTag>): string {
		if (!tag) {
			return '';
		}

		const segments: string[] = [];
		const visited = new Set<number>();
		let current: BlinkoTag | undefined | null = tag;

		while (current) {
			const name = (current.name ?? '').trim();
			if (name) {
				segments.unshift(name);
			}

			const parentId = typeof current.parent === 'number' ? current.parent : undefined;
			if (parentId && tagMap?.has(parentId) && !visited.has(parentId)) {
				visited.add(parentId);
				current = tagMap.get(parentId);
			} else {
				break;
			}
		}

		return segments.join('/');
	}

	private escapeRegExp(input: string) {
		return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private mapType(value?: number): string {
		switch (value) {
			case 1:
				return 'note';
			case 2:
				return 'todo';
			default:
				return 'flash';
		}
	}

	private buildNotePath(note: BlinkoNote, content: string, explicitTitle?: string | null): string {
		const template = (this.settings.notePathTemplate || '{{typeFolder}}/blinko-{{id}}').trim();
		const rendered = this.renderTemplate(template, note, content, explicitTitle);
		const sanitized = this.sanitizeTemplateOutput(rendered, note.id);
		const requiresId = this.templateIncludesId(template);
		const ensured = requiresId ? sanitized : this.appendIdFallback(sanitized, note.id);
		const folder = this.normalizeFolder(this.settings.noteFolder);
		const hasExtension = ensured.toLowerCase().endsWith('.md');
		const relative = hasExtension ? ensured.slice(0, -3) : ensured;
		const fullPath = folder ? `${folder}/${relative}` : relative;
		return normalizePath(`${fullPath}.md`);
	}

	private renderTemplate(template: string, note: BlinkoNote, content: string, explicitTitle?: string | null): string {
		const normalized = template.trim();
		if (!normalized.length) {
			return `blinko-${note.id}`;
		}

		return normalized.replace(/{{\s*([^}]+)\s*}}/g, (_match, token: string) =>
			this.resolveTemplateToken(String(token ?? ''), note, content, explicitTitle),
		);
	}

	private resolveTemplateToken(token: string, note: BlinkoNote, content: string, explicitTitle?: string | null): string {
		const [rawName, rawFormat] = token.split(':', 2);
		const name = (rawName || '').trim();
		const format = (rawFormat || '').trim();

		switch (name) {
			case 'id':
				return String(note.id);
			case 'type':
				return this.mapType(note.type);
			case 'typeFolder':
				return this.getTypeFolder(note.type);
			case 'title':
			case 'aiTitle':
				return this.resolveTemplateTitle(note, content, explicitTitle);
			case 'created':
				return this.formatTemplateDate(note.createdAt, format);
			case 'updated':
				return this.formatTemplateDate(note.updatedAt, format);
			default:
				return '';
		}
	}

	private templateIncludesId(template: string): boolean {
		return /{{\s*id\s*}}/i.test(template);
	}

	private formatTemplateDate(value?: string | null, format?: string): string {
		if (!value) {
			return '';
		}

		const parsed = moment(value);
		if (!parsed.isValid()) {
			return '';
		}

		const pattern = format?.length ? format : 'YYYY-MM-DD';
		return parsed.local().format(pattern);
	}

	private extractNoteTitle(note: BlinkoNote, content: string): string {
		const fromNote = (note.title ?? '').trim();
		if (fromNote.length) {
			return fromNote;
		}

		const normalized = (content ?? '').replace(/\r\n/g, '\n');
		const lines = normalized.split('\n');
		for (const line of lines) {
			const cleaned = line.replace(/^#+\s*/, '').trim();
			if (cleaned.length) {
				return cleaned;
			}
		}

		return '';
	}

	private async resolveNoteTitle(note: BlinkoNote, content: string): Promise<string> {
		const existing = (note.title ?? '').trim();
		if (existing.length) {
			return existing;
		}

		if (this.aiTitleService.isEnabled()) {
			const generated = await this.aiTitleService.getTitle(note, content);
			if (generated?.trim().length) {
				this.log(`AI generated title for note ${note.id}: ${generated}`);
				return generated.trim();
			}
		}

		return this.extractNoteTitle(note, content);
	}

	private resolveTemplateTitle(note: BlinkoNote, content: string, explicitTitle?: string | null): string {
		const resolved = (explicitTitle ?? '').trim();
		if (resolved.length) {
			return resolved;
		}
		return this.extractNoteTitle(note, content);
	}

	private sanitizeTemplateOutput(raw: string, noteId: number): string {
		const trimmed = (raw || '').trim();
		const withoutExt = trimmed.toLowerCase().endsWith('.md') ? trimmed.slice(0, -3) : trimmed;
		const segments = withoutExt
			.split('/')
			.map((segment) => this.sanitizePathSegment(segment))
			.filter(Boolean);

		if (!segments.length) {
			return `blinko-${noteId}`;
		}

		return segments.join('/');
	}

	private sanitizePathSegment(segment: string): string {
		const trimmed = (segment ?? '').trim();
		if (!trimmed.length) {
			return '';
		}

		const sanitized = this.sanitizeFilename(trimmed).replace(/\s+/g, ' ');
		return sanitized.trim();
	}

	private appendIdFallback(path: string, id: number): string {
		const normalized = (path ?? '').trim();
		if (!normalized.length) {
			return `blinko-${id}`;
		}

		const segments = normalized.split('/');
		const last = segments.pop() ?? '';
		const suffix = `blinko-${id}`;
		const nextLast = last ? `${last}-${suffix}` : suffix;
		segments.push(nextLast);
		return segments.join('/');
	}

	private getTypeFolder(value?: number | null): string {
		switch (value) {
			case 1:
				return 'Note';
			case 2:
				return 'Todo';
			default:
				return 'Flash';
		}
	}

	private buildAttachmentPath(name: string) {
		const folder = this.settings.attachmentFolder?.trim();
		return folder
			? normalizePath(`${folder}/${name}`)
			: normalizePath(name);
	}

	private async writeOrUpdate(path: string, data: string) {
		await this.ensureFolderForFile(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, data);
			return;
		}

		if (existing instanceof TFolder) {
			await this.removeConflictingFolder(existing);
		}

		try {
			await this.app.vault.create(path, data);
		} catch (error) {
			const fresh = this.app.vault.getAbstractFileByPath(path);
			if (fresh instanceof TFile) {
				await this.app.vault.modify(fresh, data);
				return;
			}

			if (fresh instanceof TFolder && this.isExistsError(error)) {
				await this.removeConflictingFolder(fresh);
				await this.app.vault.create(path, data);
				return;
			}

			throw error;
		}
	}

	private async ensureFolderForFile(path: string) {
		const idx = path.lastIndexOf('/');
		if (idx === -1) {
			return;
		}

		const folderPath = path.substring(0, idx);
		await this.ensureFolder(folderPath);
	}

	private async ensureFolder(folderPath: string) {
		const normalized = normalizePath(folderPath);
		if (!normalized || normalized === '.') {
			return;
		}

		const segments = normalized.split('/');
		let currentPath = '';
		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			// eslint-disable-next-line no-await-in-loop
			const exists = await this.app.vault.adapter.exists(currentPath);
			if (exists) {
				continue;
			}

			try {
				// eslint-disable-next-line no-await-in-loop
				await this.app.vault.createFolder(currentPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error ?? '');
				if (!/exists/i.test(message)) {
					throw error;
				}
			}
		}
	}

	private isExistsError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error ?? '');
		return /exists/i.test(message);
	}

	private async removeConflictingFolder(folder: TFolder) {
		this.log(`Removing folder that conflicts with Blinko note path: ${folder.path}`);
		await this.app.vault.delete(folder);
	}
	private normalizeFolder(input?: string): string {
		const trimmed = (input ?? '').trim();
		if (!trimmed || trimmed === '/' || trimmed === '.') {
			return '';
		}
		return normalizePath(trimmed);
	}

	private registerNotePath(id: number, path: string) {
		if (!this.notePathIndex) {
			return;
		}
		this.notePathIndex.set(id, path);
	}

	private async findExistingNoteFile(id: number): Promise<TFile | null> {
		const index = await this.ensureNotePathIndex();
		const cachedPath = index.get(id);
		if (cachedPath) {
			const existing = this.app.vault.getAbstractFileByPath(cachedPath);
			if (existing instanceof TFile) {
				return existing;
			}
			index.delete(id);
		}

		const located = await this.scanForNoteFile(id);
		if (located) {
			this.registerNotePath(id, located.path);
		}
		return located;
	}

	private async scanForNoteFile(id: number): Promise<TFile | null> {
		const files = this.app.vault.getFiles();
		for (const file of files) {
			const cached = getCachedBlinkoFrontmatter(this.app, file);
			const source = cached?.source ?? null;
			if (!this.shouldInspectFile(file, source)) {
				continue;
			}

			let meta = cached;
			if (!meta?.id) {
				// eslint-disable-next-line no-await-in-loop
				meta = await resolveBlinkoFrontmatter(this.app, file);
			}
			if (meta?.id === id) {
				return file;
			}
		}
		return null;
	}

	private async ensureNotePathIndex(): Promise<Map<number, string>> {
		if (this.notePathIndex) {
			return this.notePathIndex;
		}

		if (!this.notePathIndexPromise) {
			this.notePathIndexPromise = this.buildNotePathIndex();
		}

		this.notePathIndex = await this.notePathIndexPromise;
		this.notePathIndexPromise = null;
		return this.notePathIndex;
	}

	private async buildNotePathIndex(): Promise<Map<number, string>> {
		const files = this.app.vault.getFiles();
		const map = new Map<number, string>();
		for (const file of files) {
			const cached = getCachedBlinkoFrontmatter(this.app, file);
			const source = cached?.source ?? null;
			if (!this.shouldInspectFile(file, source)) {
				continue;
			}

			let meta = cached;
			if (!meta?.id) {
				// eslint-disable-next-line no-await-in-loop
				meta = await resolveBlinkoFrontmatter(this.app, file);
			}

			if (!meta?.id || map.has(meta.id)) {
				continue;
			}

			map.set(meta.id, file.path);
		}

		return map;
	}

	private shouldInspectFile(file: TFile, source?: string | null): boolean {
		const folder = this.normalizeFolder(this.settings.noteFolder);
		const inFolder = folder ? this.pathWithinFolder(file.path, folder) : false;
		if (inFolder) {
			return true;
		}

		if (source) {
			return isBlinkoSourceValue(source);
		}

		return !folder;
	}

	private pathWithinFolder(filePath: string, folder: string): boolean {
		if (!folder) {
			return true;
		}

		if (filePath === folder) {
			return true;
		}

		return filePath.startsWith(`${folder}/`);
	}

	private formatLocalTimestamp(value?: string | null): string {
		if (!value) {
			return '';
		}

		const parsed = moment(value);
		if (!parsed.isValid()) {
			this.log('Blinko note timestamp invalid, skipping conversion: %s', value);
			return value;
		}

		return parsed.local().format('YYYY-MM-DDTHH:mm:ssZ');
	}

	private ensureTrailingNewline(content: string): string {
		const normalized = (content ?? '').replace(/\r\n/g, '\n');
		if (!normalized.trim().length) {
			return '\n';
		}

		return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
	}
}
