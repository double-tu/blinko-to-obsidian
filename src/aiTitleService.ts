// aiTitleService.ts
import { requestUrl } from 'obsidian';
import { BlinkoSettings, DEFAULT_SETTINGS } from './settings';
import { BlinkoNote } from './types';

type Logger = (message: string, ...values: unknown[]) => void;

interface TemplateContext {
	note: BlinkoNote;
	content: string;
}

/**
 * 简单的异步并发控制器
 */
class ConcurrencyLimiter {
	private activeCount = 0;
	private queue: (() => void)[] = [];

	constructor(private limit: number) {}

	setLimit(limit: number) {
		this.limit = limit;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.activeCount >= this.limit) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}

		this.activeCount++;
		try {
			return await fn();
		} finally {
			this.activeCount--;
			if (this.queue.length > 0) {
				const next = this.queue.shift();
				next?.();
			}
		}
	}
}

const FALLBACK_SYSTEM_PROMPT =
	'你是一个专业的笔记标题生成助手。请根据提供的笔记内容、标签和时间信息，生成一个简洁、概括性强的标题。标题不要包含特殊字符，不要使用引号，长度控制在15字以内。';

export class AiTitleService {
	private limiter: ConcurrencyLimiter;

	constructor(private settings: BlinkoSettings, private log: Logger) {
		this.limiter = new ConcurrencyLimiter(Math.max(1, settings.aiConcurrency || 3));
	}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
		this.limiter.setLimit(Math.max(1, settings.aiConcurrency || 3));
	}

	isEnabled(): boolean {
		return (
			this.settings.aiTitleEnabled &&
			!!this.settings.aiBaseUrl &&
			!!this.settings.aiApiKey
		);
	}

	/**
	 * 获取标题的主入口
	 * 如果未启用或调用失败，返回 null，由调用方决定回退策略
	 */
	async getTitle(note: BlinkoNote, content: string): Promise<string | null> {
		if (!this.isEnabled()) {
			return null;
		}

		// 如果笔记本身已经有标题（Blinko端设置了标题），通常优先使用原标题？
		// 或者根据你的需求，如果是自动生成的空标题，则覆盖。
		// 这里假设只要调用了这个方法，就是希望 AI 生成。

		return this.limiter.run(async () => {
			try {
				return await this.generateTitleFromApi(note, content);
			} catch (error) {
				this.log('AI Title generation failed', error);
				return null;
			}
		});
	}

	private async generateTitleFromApi(note: BlinkoNote, content: string): Promise<string | null> {
		const url = `${this.settings.aiBaseUrl.replace(/\/+$/, '')}/chat/completions`;

		const userPrompt = this.buildUserPrompt(note, content);
		const systemPrompt =
			(this.settings.aiSystemPrompt?.trim() ||
				DEFAULT_SETTINGS.aiSystemPrompt ||
				FALLBACK_SYSTEM_PROMPT).trim();

		const body = {
			model: this.settings.aiModelName || 'gpt-5.1-mini',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: this.settings.aiMaxTokens || 50,
			temperature: 0.7,
		};

		const response = await requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.settings.aiApiKey}`
			},
			body: JSON.stringify(body)
		});

		if (response.status >= 400) {
			throw new Error(`OpenAI API error: ${response.status} ${response.text}`);
		}

		const data = response.json;
		const title = data?.choices?.[0]?.message?.content?.trim();

		if (!title) return null;

		// 清理可能产生的引号或文件名非法字符
		return this.sanitizeTitle(title);
	}

	private sanitizeTitle(title: string): string {
		// 去除首尾引号
		let clean = title.replace(/^["']|["']$/g, '');
		// 替换非法文件字符
		clean = clean.replace(/[\\/:*?"<>|]/g, '-');
		// 移除换行符
		return clean.replace(/[\r\n]/g, ' ').trim();
	}

	private buildUserPrompt(note: BlinkoNote, content: string): string {
		const lines: string[] = [
			`Note ID: ${note.id}`,
			`Type: ${this.describeNoteType(note.type)}`,
		];

		if (note.createdAt) {
			lines.push(`Created at: ${note.createdAt}`);
		}
		if (note.updatedAt && note.updatedAt !== note.createdAt) {
			lines.push(`Updated at: ${note.updatedAt}`);
		}
		if (note.tags?.length) {
			const tags = note.tags
				.map((tag) => tag?.name?.trim())
				.filter((name): name is string => Boolean(name?.length));
			if (tags.length) {
				lines.push(`Tags: ${tags.join(', ')}`);
			}
		}

		lines.push('', 'Content:');
		const normalizedContent = (content ?? '').replace(/\r\n/g, '\n');
		const truncatedContent =
			normalizedContent.length > 3000
				? `${normalizedContent.slice(0, 3000)}...`
				: normalizedContent;
		lines.push(truncatedContent || '(empty)');
		return lines.join('\n');
	}

	private describeNoteType(value?: number): string {
		switch (value) {
			case 1:
				return 'Note';
			case 2:
				return 'Todo';
			default:
				return 'Flash';
		}
	}
}
