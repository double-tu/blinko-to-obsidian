export interface BlinkoSettings {
	serverUrl: string;
	accessToken: string;
	noteFolder: string;
	notePathTemplate: string;
	attachmentFolder: string;
	dailyNotesToggle: boolean;
	dailyNotesLocation: string;
	dailyNotesFormat: string;
	dailyNotesInsertAfter: string;
	dailyNotesInsertBefore: string;
	dailyNotesEmbedContent: boolean;
	aiTitleEnabled: boolean;
	aiBaseUrl: string;      // 例如 https://api.openai.com/v1
	aiApiKey: string;
	aiModelName: string;    // 例如 gpt-5.1-mini, gpt-4o-mini
	aiSystemPrompt: string; // 自定义提示词
	aiConcurrency: number;  // 并发数
	aiMaxTokens: number;    // 生成最大长度
	lastSyncTime: number;
	autoSyncInterval: number; // minutes, 0 disabled
	debugMode: boolean;
	includeFrontmatterTags: boolean;
	deleteCheckEnabled: boolean;
	deleteCheckInterval: number;
	deleteRecycleBinEnabled: boolean;
	noteAttachmentMap: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: BlinkoSettings = {
	serverUrl: '',
	accessToken: '',
	noteFolder: 'Blinko/Notes',
	notePathTemplate: '{{typeFolder}}/blinko-{{id}}',
	attachmentFolder: 'Blinko/Attachments',
	dailyNotesToggle: false,
	dailyNotesLocation: '/',
	dailyNotesFormat: 'YYYY-MM-DD',
	dailyNotesInsertAfter: '<!-- start of flash-notes -->',
	dailyNotesInsertBefore: '<!-- end of flash-notes -->',
	dailyNotesEmbedContent: false,
	aiTitleEnabled: false,
	aiBaseUrl: 'https://api.openai.com/v1',
	aiApiKey: '',
	aiModelName: 'gpt-5.1-mini',
	aiSystemPrompt: 'You are a professional note title generation assistant. Please generate a concise and highly descriptive title based on the provided note content, tags, and time information. The title should not contain special characters or quotation marks, and its length should be limited to 15 words or less.',
	aiConcurrency: 3,
	aiMaxTokens: 50,
	lastSyncTime: 0,
	autoSyncInterval: 30,
	debugMode: false,
	includeFrontmatterTags: true,
	deleteCheckEnabled: false,
	deleteCheckInterval: 120,
	deleteRecycleBinEnabled: false,
	noteAttachmentMap: {},
};
