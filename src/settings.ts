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
	lastSyncTime: 0,
	autoSyncInterval: 30,
	debugMode: false,
	includeFrontmatterTags: true,
	deleteCheckEnabled: false,
	deleteCheckInterval: 120,
	deleteRecycleBinEnabled: false,
	noteAttachmentMap: {},
};
