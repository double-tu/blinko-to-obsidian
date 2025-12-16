import { App, normalizePath, TFile } from 'obsidian';
import { BlinkoSettings } from './settings';
import { BlinkoNote, BlinkoTag } from './types';
import { BlinkoClient } from './client';

type Logger = (message: string, ...values: unknown[]) => void;

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

	async saveNote(note: BlinkoNote): Promise<string[]> {
		const { block: attachmentBlock, storedAttachments, content } = await this.processAttachments(note);
		const markdown = this.generateMarkdown(note, attachmentBlock, storedAttachments, content);
		const filePath = this.buildNotePath(note.id);
		await this.writeOrUpdate(filePath, markdown);
		this.log(`Saved note ${filePath}`);
		return storedAttachments;
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

	private generateMarkdown(note: BlinkoNote, attachmentBlock: string, attachments: string[], content: string) {
		const tags = (note.tags ?? [])
			.map((tag: BlinkoTag) => this.formatTag(tag?.name ?? ''))
			.filter(Boolean);

		const frontmatter = [
			'---',
			`id: ${note.id}`,
			`date: ${note.createdAt}`,
			`updated: ${note.updatedAt}`,
			'source: blinko',
			`blinkoType: ${this.mapType(note.type)}`,
			`blinkoTypeCode: ${typeof note.type === 'number' ? note.type : 0}`,
			`blinkoAttachments: [${attachments.map(this.quoteAttachment).join(', ')}]`,
			`tags: [${tags.map(this.quoteTag).join(', ')}]`,
			'---',
			'',
		].join('\n');

		const body = content ?? '';
		return `${frontmatter}${body}${attachmentBlock}`;
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, '-');
	}

	private formatTag(name: string): string {
		if (!name) {
			return '';
		}

		return name.trim().replace(/\s*>\s*/g, '/');
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

	private buildNotePath(id: number) {
		const folder = this.settings.noteFolder?.trim();
		const filename = `blinko-${id}.md`;
		return folder
			? normalizePath(`${folder}/${filename}`)
			: normalizePath(filename);
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
		} else {
			await this.app.vault.create(path, data);
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
			if (!exists) {
				// eslint-disable-next-line no-await-in-loop
				await this.app.vault.createFolder(currentPath);
			}
		}
	}
}
