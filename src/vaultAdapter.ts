import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { BlinkoSettings } from './settings';
import { BlinkoNote, BlinkoTag } from './types';
import { BlinkoClient } from './client';
import { buildBlinkoBlockId } from './noteUtils';

type Logger = (message: string, ...values: unknown[]) => void;

export interface SavedNoteResult {
	attachments: string[];
	filePath: string;
	blockId: string;
}

export class VaultAdapter {
	constructor(
		private app: App,
		private settings: BlinkoSettings,
		private client: BlinkoClient,
		private log: Logger,
	) {}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
	}

	async saveNote(note: BlinkoNote): Promise<SavedNoteResult> {
		const { block: attachmentBlock, storedAttachments, content } = await this.processAttachments(note);
		const blockId = buildBlinkoBlockId(note.id);
		const markdown = this.generateMarkdown(note, attachmentBlock, storedAttachments, content, blockId);
		const filePath = this.buildNotePath(note.id, note.type);
		await this.cleanupOtherTypeLocations(note.id, filePath);
		await this.writeOrUpdate(filePath, markdown);
		this.log(`Saved note ${filePath}`);
		return {
			attachments: storedAttachments,
			filePath,
			blockId,
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
		blockId: string,
	) {
		const frontmatterLines = [
			'---',
			`id: ${note.id}`,
			`date: ${note.createdAt}`,
			`updated: ${note.updatedAt}`,
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
		const bodyWithMarker = this.ensureBlockId(composedBody, blockId);
		return `${frontmatter}${bodyWithMarker}`;
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

	private buildNotePath(id: number, type?: number | null) {
		const baseFolder = this.settings.noteFolder?.trim();
		const typeFolder = this.getTypeFolder(type);
		const filename = `blinko-${id}.md`;
		const pathParts = [baseFolder, typeFolder].filter(Boolean);
		const folderPath = pathParts.length ? normalizePath(pathParts.join('/')) : '';
		return folderPath ? normalizePath(`${folderPath}/${filename}`) : normalizePath(filename);
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

	private getAllTypeFolders(): string[] {
		return ['Flash', 'Note', 'Todo'];
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
	private async cleanupOtherTypeLocations(id: number, targetPath: string) {
		const candidates = [
			...this.getAllTypeFolders().map((folder) => this.buildNotePathWithFolder(id, folder)),
			this.buildLegacyNotePath(id),
		].filter(Boolean);

		for (const candidate of candidates) {
			if (!candidate || candidate === targetPath) {
				continue;
			}

			const existing = this.app.vault.getAbstractFileByPath(candidate);
			if (existing instanceof TFile) {
				// eslint-disable-next-line no-await-in-loop
				await this.app.vault.delete(existing);
			}
		}
	}

	private buildNotePathWithFolder(id: number, folderName: string): string {
		const baseFolder = this.settings.noteFolder?.trim();
		const filename = `blinko-${id}.md`;
		const folderPath = baseFolder
			? normalizePath(`${baseFolder}/${folderName}`)
			: normalizePath(folderName);
		return normalizePath(`${folderPath}/${filename}`);
	}

	private buildLegacyNotePath(id: number): string {
		const baseFolder = this.settings.noteFolder?.trim();
		const filename = `blinko-${id}.md`;
		return baseFolder
			? normalizePath(`${baseFolder}/${filename}`)
			: normalizePath(filename);
	}

	private ensureBlockId(content: string, blockId: string): string {
		if (!blockId) {
			return content;
		}

		const marker = `^${blockId}`;
		const normalized = content.replace(/\r\n/g, '\n');
		const trimmed = normalized.trim();
		if (!trimmed.length) {
			return `${marker}\n`;
		}

		if (normalized.includes(marker)) {
			return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
		}

		const lines = normalized.split('\n');
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index];
			if (!line || !line.trim().length) {
				continue;
			}
			lines[index] = `${line} ${marker}`;
			return `${lines.join('\n')}\n`;
		}

		return `${normalized} ${marker}\n`;
	}
}
