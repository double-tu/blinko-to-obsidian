import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { BlinkoClient } from './src/client';
import { BlinkoSettings, DEFAULT_SETTINGS } from './src/settings';
import { SyncManager } from './src/syncManager';
import { VaultAdapter } from './src/vaultAdapter';
import { DeletionManager } from './src/deletionManager';

export default class BlinkoSyncPlugin extends Plugin {
	settings: BlinkoSettings;

	private client: BlinkoClient | null = null;
	private vaultAdapter: VaultAdapter | null = null;
	private syncManager: SyncManager | null = null;
	private deletionManager: DeletionManager | null = null;
	private statusBarItem: HTMLElement | null = null;
	private autoSyncHandle: number | null = null;
	private deletionIntervalHandle: number | null = null;

	private logDebug = (message: string, ...values: unknown[]) => {
		if (!this.settings?.debugMode) {
			return;
		}

		console.log('[Blinko Sync]', message, ...values);
	};

	async onload() {
		await this.loadSettings();
		this.initializeServices();
		this.registerInterface();
		this.scheduleAutoSync();
		this.scheduleDeletionCheck();
	}

	onunload() {
		this.clearAutoSync();
		this.clearDeletionInterval();
	}

	async syncNow(manual = true) {
		if (!this.syncManager) {
			return;
		}

		if (this.syncManager.syncing) {
			if (manual) {
				new Notice('Blinko sync already running. Please wait.');
			}
			return;
		}

		this.setStatusSyncing();
		const shouldRunDeletionCheck = this.settings.deleteCheckEnabled;
		try {
			const newNotes = await this.syncManager.startSync();
			this.setStatusIdle(this.settings.lastSyncTime || Date.now());
			new Notice(`Sync complete: ${newNotes} new notes added.`);
			if (shouldRunDeletionCheck) {
				await this.checkDeletedNotes(false);
			}
		} catch (error) {
			this.setStatusIdle();
			const reason = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Blinko Sync] Sync failed', error);
			new Notice(`Sync failed: ${reason}`);
		}
	}

	async checkDeletedNotes(manual = true) {
		if (!this.deletionManager) {
			return;
		}

		if (!this.settings.deleteCheckEnabled && !manual) {
			return;
		}

		if (manual && !this.settings.deleteCheckEnabled) {
			new Notice('Deletion check is currently disabled. Enable it in settings for automatic cleanup.');
		}

		try {
			const removed = await this.deletionManager.reconcileDeletedNotes();
			if (manual) {
				new Notice(removed ? `Removed ${removed} local notes deleted in Blinko.` : 'No deletions detected.');
			} else if (removed) {
				new Notice(`Removed ${removed} local Blinko notes that were deleted remotely.`);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Blinko Sync] Deletion check failed', error);
			if (manual) {
				new Notice(`Deletion check failed: ${reason}`);
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.persistSettingsOnly();
		this.onSettingsUpdated();
	}

	private async persistSettingsOnly() {
		await this.saveData(this.settings);
	}

	private initializeServices() {
		this.client = new BlinkoClient(this.settings);
		this.vaultAdapter = new VaultAdapter(this.app, this.settings, this.client, this.logDebug);
		this.syncManager = new SyncManager(
			this.settings,
			this.client,
			this.vaultAdapter,
			this.persistSettingsOnly.bind(this),
			this.logDebug,
		);
		this.deletionManager = new DeletionManager(
			this.app,
			this.settings,
			this.client,
			this.persistSettingsOnly.bind(this),
			this.logDebug,
		);
	}

	private registerInterface() {
		const ribbon = this.addRibbonIcon('rotate-ccw', 'Sync Blinko', () => {
			void this.syncNow(true);
		});
		ribbon.addClass('blinko-sync-ribbon');

			this.addCommand({
				id: 'blinko-sync-now',
				name: 'Sync Blinko',
				callback: () => {
					void this.syncNow(true);
				},
			});

			this.addCommand({
				id: 'blinko-reconcile-deletions',
				name: 'Blinko: reconcile deletions',
				callback: () => {
					void this.checkDeletedNotes(true);
				},
			});

		this.statusBarItem = this.addStatusBarItem();
		this.setStatusIdle(this.settings.lastSyncTime || undefined);

		this.addSettingTab(new BlinkoSettingTab(this.app, this));
	}

	private scheduleAutoSync() {
		this.clearAutoSync();

		if (!this.settings?.autoSyncInterval || this.settings.autoSyncInterval <= 0) {
			this.logDebug('Auto sync disabled.');
			return;
		}

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
		this.autoSyncHandle = window.setInterval(() => {
			void this.syncNow(false);
		}, intervalMs);
		this.registerInterval(this.autoSyncHandle);
		this.logDebug(`Auto sync scheduled every ${this.settings.autoSyncInterval} minutes.`);
	}

	private clearAutoSync() {
		if (this.autoSyncHandle !== null) {
			window.clearInterval(this.autoSyncHandle);
			this.autoSyncHandle = null;
		}
	}

	private scheduleDeletionCheck() {
		this.clearDeletionInterval();

		if (!this.settings?.deleteCheckEnabled) {
			this.logDebug('Deletion check disabled.');
			return;
		}

		if (!this.settings.deleteCheckInterval || this.settings.deleteCheckInterval <= 0) {
			this.logDebug('Deletion check interval is not configured.');
			return;
		}

		const intervalMs = this.settings.deleteCheckInterval * 60 * 1000;
		this.deletionIntervalHandle = window.setInterval(() => {
			void this.checkDeletedNotes(false);
		}, intervalMs);
		this.registerInterval(this.deletionIntervalHandle);
		this.logDebug(`Deletion check scheduled every ${this.settings.deleteCheckInterval} minutes.`);
	}

	private clearDeletionInterval() {
		if (this.deletionIntervalHandle !== null) {
			window.clearInterval(this.deletionIntervalHandle);
			this.deletionIntervalHandle = null;
		}
	}

	private onSettingsUpdated() {
		this.client?.updateSettings(this.settings);
		this.vaultAdapter?.updateSettings(this.settings);
		this.syncManager?.updateSettings(this.settings);
		this.deletionManager?.updateSettings(this.settings);
		this.scheduleAutoSync();
		this.scheduleDeletionCheck();
		this.setStatusIdle(this.settings.lastSyncTime || undefined);
	}

	private setStatusSyncing() {
		if (this.statusBarItem) {
			this.statusBarItem.setText('Blinko Syncing...');
		}
	}

	private setStatusIdle(lastSynced?: number) {
		if (!this.statusBarItem) {
			return;
		}

		if (lastSynced) {
			const time = new Date(lastSynced).toLocaleTimeString();
			this.statusBarItem.setText(`Blinko: Last sync ${time}`);
		} else {
			this.statusBarItem.setText('Blinko: Idle');
		}
	}
}

class BlinkoSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: BlinkoSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Blinko Sync' });

		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('Example: http://myserver.com:1111')
			.addText((text) =>
				text
					.setPlaceholder('http://localhost:1111')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Access token')
			.setDesc('Blinko API Bearer token')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('token')
					.setValue(this.plugin.settings.accessToken)
					.onChange(async (value) => {
						this.plugin.settings.accessToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Note folder')
			.setDesc('Folder to store synced notes (relative to vault root)')
			.addText((text) =>
				text
					.setPlaceholder('Blinko/Notes')
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Attachment folder')
			.setDesc('Folder to store synced attachments')
			.addText((text) =>
				text
					.setPlaceholder('Blinko/Attachments')
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto sync interval (minutes)')
			.setDesc('Set minutes between automatic sync. Use 0 to disable.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const minutes = Number(value);
						this.plugin.settings.autoSyncInterval = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Log verbose details to the developer console')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl('h3', { text: 'Deletion reconciliation (optional)' });

		new Setting(containerEl)
			.setName('Enable deletion check')
			.setDesc('When enabled, the plugin periodically removes local notes that were deleted in Blinko.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.deleteCheckEnabled).onChange(async (value) => {
					this.plugin.settings.deleteCheckEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Delete notes that are in Blinko recycle bin')
			.setDesc('When enabled, notes moved to the Blinko recycle bin will also be removed locally.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.deleteRecycleBinEnabled).onChange(async (value) => {
					this.plugin.settings.deleteRecycleBinEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Deletion check interval (minutes)')
			.setDesc('How often to run the remote deletion reconciliation. 0 disables scheduling.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text
					.setValue(String(this.plugin.settings.deleteCheckInterval))
					.onChange(async (value) => {
						const minutes = Number(value);
						this.plugin.settings.deleteCheckInterval = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Last sync time')
			.setDesc(this.getLastSyncDescription())
			.addExtraButton((button) =>
				button
					.setIcon('rotate-ccw')
					.setTooltip('Reset last sync time')
					.onClick(async () => {
						this.plugin.settings.lastSyncTime = 0;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('Manual sync')
			.setDesc('Run one sync immediately')
			.addButton((button) =>
				button
					.setButtonText('Sync now')
					.setCta()
					.onClick(() => {
						void this.plugin.syncNow(true);
					}),
			);
	}

	private getLastSyncDescription() {
		if (!this.plugin.settings.lastSyncTime) {
			return 'Never synced';
		}

		return new Date(this.plugin.settings.lastSyncTime).toLocaleString();
	}
}
