import { BlinkoClient } from './client';
import { BlinkoSettings } from './settings';
import { BlinkoNote } from './types';
import { VaultAdapter } from './vaultAdapter';

type Logger = (message: string, ...values: unknown[]) => void;
type SaveHandler = () => Promise<void>;

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

	async startSync(): Promise<number> {
		if (this.isSyncing) {
			this.log('Sync already running, skipping new request.');
			return 0;
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

		try {
			while (hasMore) {
				// eslint-disable-next-line no-await-in-loop
				const notes = await this.client.getNotes(lastSyncTime, page, this.pageSize);
				if (!notes.length) {
					break;
				}

				for (const note of notes) {
					const shouldContinue = await this.handleNote(note, lastSyncTime);
					if (!shouldContinue) {
						hasMore = false;
						break;
					}
					newNotes++;
				}

				if (!hasMore || notes.length < this.pageSize) {
					break;
				}

				page += 1;
			}

			this.settings.lastSyncTime = syncStartTime;
			await this.persistSettings();
			return newNotes;
		} finally {
			this.isSyncing = false;
		}
	}

	private async handleNote(note: BlinkoNote, lastSyncTime: number): Promise<boolean> {
		const updatedTime = Date.parse(note.updatedAt);
		if (Number.isFinite(updatedTime) && lastSyncTime && updatedTime <= lastSyncTime) {
			this.log(`Reached notes older than last sync: ${note.id}`);
			return false;
		}

		const attachments = await this.vaultAdapter.saveNote(note);
		if (!this.settings.noteAttachmentMap) {
			this.settings.noteAttachmentMap = {};
		}
		this.settings.noteAttachmentMap[String(note.id)] = attachments;
		return true;
	}
}
