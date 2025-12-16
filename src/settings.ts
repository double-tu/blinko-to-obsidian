export interface BlinkoSettings {
	serverUrl: string;
	accessToken: string;
	noteFolder: string;
	attachmentFolder: string;
	lastSyncTime: number;
	autoSyncInterval: number; // minutes, 0 disabled
	debugMode: boolean;
	deleteCheckEnabled: boolean;
	deleteCheckInterval: number;
	deleteRecycleBinEnabled: boolean;
	noteAttachmentMap: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: BlinkoSettings = {
	serverUrl: '',
	accessToken: '',
	noteFolder: 'Blinko/Notes',
	attachmentFolder: 'Blinko/Attachments',
	lastSyncTime: 0,
	autoSyncInterval: 30,
	debugMode: false,
	deleteCheckEnabled: false,
	deleteCheckInterval: 120,
	deleteRecycleBinEnabled: false,
	noteAttachmentMap: {},
};
