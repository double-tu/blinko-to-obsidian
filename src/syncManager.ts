import { BlinkoClient } from './client';
import { BlinkoSettings } from './settings';
import { BlinkoNote, FlashNoteJournalEntry } from './types';
import { VaultAdapter, SavedNoteResult } from './vaultAdapter';
import { isFlashType } from './noteUtils';

type Logger = (message: string, ...values: unknown[]) => void;
type SaveHandler = () => Promise<void>;

interface HandleNoteResult {
	shouldContinue: boolean;
	saveResult?: SavedNoteResult;
}

export interface SyncResult {
	newNotes: number;
	flashNotes: FlashNoteJournalEntry[];
}

export class SyncManager {
	private isSyncing = false;
	private readonly pageSize = 50;

	constructor(
		private settings: BlinkoSettings,
		private client: BlinkoClient,
		private vaultAdapter: VaultAdapter,
		private persistSettings: SaveHandler,
		private log: Logger,
	) {}

	get syncing() {
		return this.isSyncing;
	}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
	}

	async startSync(): Promise<SyncResult> {
		if (this.isSyncing) {
			this.log('Sync already running, skipping new request.');
			return { newNotes: 0, flashNotes: [] };
		}

		if (!this.settings.serverUrl || !this.settings.accessToken) {
			throw new Error('Configure the Blinko server URL and access token in settings before syncing.');
		}

		this.isSyncing = true;
		const syncStartTime = Date.now();
		const lastSyncTime = this.settings.lastSyncTime || 0;
		let page = 1;
		let hasMore = true;
		let newNotes = 0;
		const flashNotes: FlashNoteJournalEntry[] = [];

		try {
			while (hasMore) {
				// eslint-disable-next-line no-await-in-loop
				const notes = await this.client.getNotes(lastSyncTime, page, this.pageSize);
				if (!notes.length) {
					break;
				}

				for (const note of notes) {
					// eslint-disable-next-line no-await-in-loop
					const result = await this.handleNote(note, lastSyncTime);
					if (!result.shouldContinue) {
						hasMore = false;
						break;
					}

					if (result.saveResult) {
						newNotes += 1;
						if (isFlashType(note.type)) {
							flashNotes.push(this.buildFlashSnapshot(note, result.saveResult));
						}
					}
				}

				if (!hasMore || notes.length < this.pageSize) {
					break;
				}

				page += 1;
			}

			this.settings.lastSyncTime = syncStartTime;
			await this.persistSettings();
			return { newNotes, flashNotes };
		} finally {
			this.isSyncing = false;
		}
	}

	private async handleNote(note: BlinkoNote, lastSyncTime: number): Promise<HandleNoteResult> {
		const updatedTime = Date.parse(note.updatedAt);
		if (Number.isFinite(updatedTime) && lastSyncTime && updatedTime <= lastSyncTime) {
			this.log(`Reached notes older than last sync: ${note.id}`);
			return { shouldContinue: false };
		}

		const saveResult = await this.vaultAdapter.saveNote(note);
		if (!this.settings.noteAttachmentMap) {
			this.settings.noteAttachmentMap = {};
		}
		this.settings.noteAttachmentMap[String(note.id)] = saveResult.attachments;
		return { shouldContinue: true, saveResult };
	}

	private buildFlashSnapshot(note: BlinkoNote, result: SavedNoteResult): FlashNoteJournalEntry {
		return {
			id: note.id,
			createdAt: note.createdAt,
			filePath: result.filePath,
			blockId: result.blockId,
			type: note.type,
		};
	}
}
