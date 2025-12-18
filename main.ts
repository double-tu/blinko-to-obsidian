import { App, Notice, Plugin, PluginSettingTab, Setting, TFolder } from 'obsidian';
import { BlinkoClient } from './src/client';
import { BlinkoSettings, DEFAULT_SETTINGS } from './src/settings';
import { SyncManager } from './src/syncManager';
import { VaultAdapter } from './src/vaultAdapter';
import { DeletionManager } from './src/deletionManager';
import { DailyNoteManager } from './src/dailyNotes';
import { AiTitleService } from './src/aiTitleService';

export default class BlinkoSyncPlugin extends Plugin {
	settings: BlinkoSettings;

	private client: BlinkoClient | null = null;
	private aiTitleService: AiTitleService | null = null;
	private vaultAdapter: VaultAdapter | null = null;
	private syncManager: SyncManager | null = null;
	private deletionManager: DeletionManager | null = null;
	private dailyNoteManager: DailyNoteManager | null = null;
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
			const { newNotes, flashNotes } = await this.syncManager.startSync();
			this.setStatusIdle(this.settings.lastSyncTime || Date.now());
			if (this.dailyNoteManager) {
				await this.dailyNoteManager.insertFlashNotes(flashNotes);
			}
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
		this.aiTitleService = new AiTitleService(this.settings, this.logDebug);
		this.vaultAdapter = new VaultAdapter(this.app, this.settings, this.client, this.aiTitleService, this.logDebug);
		this.dailyNoteManager = new DailyNoteManager(this.app, this.settings, this.logDebug);
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
			this.dailyNoteManager,
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
		this.aiTitleService?.updateSettings(this.settings);
		this.vaultAdapter?.updateSettings(this.settings);
		this.syncManager?.updateSettings(this.settings);
		this.deletionManager?.updateSettings(this.settings);
		this.dailyNoteManager?.updateSettings(this.settings);
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
			.setName('Note filename template')
			.setDesc(
				'Relative path (without .md) for each note. Use placeholders like {{typeFolder}}, {{type}}, {{id}}, {{title}}, {{created}}, {{created:YYYY/MM/DD}}, or {{updated}}. Slashes create subfolders inside the note folder.',
			)
			.addText((text) =>
				text
					.setPlaceholder('{{typeFolder}}/blinko-{{id}}')
					.setValue(this.plugin.settings.notePathTemplate)
					.onChange(async (value) => {
						const normalized = value.trim() || '{{typeFolder}}/blinko-{{id}}';
						if (!/{{\s*id\s*}}/i.test(normalized)) {
							new Notice('The template must include {{id}} to keep filenames unique.');
							text.setValue(this.plugin.settings.notePathTemplate);
							return;
						}
						this.plugin.settings.notePathTemplate = normalized;
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

		new Setting(containerEl)
			.setName('Include tags in frontmatter')
			.setDesc('When enabled, note tags are written to the YAML frontmatter. Disable to rely on in-body tags only.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeFrontmatterTags).onChange(async (value) => {
					this.plugin.settings.includeFrontmatterTags = value;
					await this.plugin.saveSettings();
				}),
			);

		this.renderAiTitleSettings(containerEl);
		this.renderDailyNoteSettings(containerEl);

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

	private renderAiTitleSettings(containerEl: HTMLElement) {
		containerEl.createEl('h3', { text: 'AI title generation' });

		new Setting(containerEl)
			.setName('Enable AI-generated titles')
			.setDesc('Call an OpenAI-compatible API to suggest semantic titles when notes lack one.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.aiTitleEnabled).onChange(async (value) => {
					this.plugin.settings.aiTitleEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('API base URL')
			.setDesc('Example: https://api.openai.com/v1')
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1')
					.setValue(this.plugin.settings.aiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.aiBaseUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Bearer token used for the AI endpoint')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.aiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.aiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Model name')
			.setDesc('Model identifier, e.g., gpt-5.1-mini or gpt-4o-mini')
			.addText((text) =>
				text
					.setPlaceholder('gpt-5.1-mini')
					.setValue(this.plugin.settings.aiModelName)
					.onChange(async (value) => {
						this.plugin.settings.aiModelName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max tokens')
			.setDesc('Upper bound for the generated title length (tokens).')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text
					.setValue(String(this.plugin.settings.aiMaxTokens || 50))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.aiMaxTokens = Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : 50;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Concurrency limit')
			.setDesc('Maximum simultaneous AI requests when syncing multiple notes.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text
					.setValue(String(this.plugin.settings.aiConcurrency || 3))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.aiConcurrency = Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : 1;
						await this.plugin.saveSettings();
					});
			});

		const promptSetting = new Setting(containerEl)
			.setName('System prompt')
			.setDesc('Customize the instruction sent to the AI model.');
		promptSetting.addTextArea((text) => {
			text.inputEl.rows = 4;
			text.setValue(this.plugin.settings.aiSystemPrompt).onChange(async (value) => {
				this.plugin.settings.aiSystemPrompt = value;
				await this.plugin.saveSettings();
			});
		});
	}

	private renderDailyNoteSettings(containerEl: HTMLElement) {
		containerEl.createEl('h3', { text: 'Daily Notes' });

		new Setting(containerEl)
			.setName('Insert Blinko notes')
			.setDesc(
				'When enabled, each Blinko note (flash, note, todo) is embedded between template markers in the Daily Note for its creation date—if that note already exists.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.dailyNotesToggle).onChange(async (value) => {
					this.plugin.settings.dailyNotesToggle = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (!this.plugin.settings.dailyNotesToggle) {
			const hint = containerEl.createEl('p', {
				text: 'Enable the toggle above to configure the Daily Notes location, filename format, and marker boundaries.',
			});
			hint.addClass('setting-item-description');
			return;
		}

		const folderSetting = new Setting(containerEl)
			.setName('Daily Notes folder')
			.setDesc('Folder that contains your Daily/Periodic Notes. Defaults to the vault root.');
		folderSetting.addDropdown((dropdown) => {
			const folders = this.getFolderOptions();
			const currentValue = this.plugin.settings.dailyNotesLocation || '/';
			for (const folder of folders) {
				const label = folder === '/' ? 'Vault root (/)' : folder;
				dropdown.addOption(folder, label);
			}
			if (!folders.includes(currentValue)) {
				dropdown.addOption(currentValue, currentValue);
			}
			dropdown.setValue(currentValue).onChange(async (value) => {
				this.plugin.settings.dailyNotesLocation = value || '/';
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName('Daily note format')
			.setDesc('Moment.js format used to generate the filename (e.g., YYYY-MM-DD or YYYY/[W]ww/YYYY-MM-DD).')
			.addText((text) =>
				text
					.setPlaceholder('YYYY-MM-DD')
					.setValue(this.plugin.settings.dailyNotesFormat || 'YYYY-MM-DD')
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesFormat = value.trim() || 'YYYY-MM-DD';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Start marker')
			.setDesc('Exact line that marks where Blinko notes begin (will be replaced on each sync).')
			.addText((text) =>
				text
					.setPlaceholder('<!-- start of flash-notes -->')
					.setValue(this.plugin.settings.dailyNotesInsertAfter)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesInsertAfter = value || '<!-- start of flash-notes -->';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('End marker')
			.setDesc('Exact line that marks where Blinko notes end.')
			.addText((text) =>
				text
					.setPlaceholder('<!-- end of flash-notes -->')
					.setValue(this.plugin.settings.dailyNotesInsertBefore)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesInsertBefore = value || '<!-- end of flash-notes -->';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Embed Blinko note content')
			.setDesc('Use ![[...]] to embed Blinko note contents instead of plain [[...]] links.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dailyNotesEmbedContent)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesEmbedContent = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private getFolderOptions(): string[] {
		const root = this.app.vault.getRoot();
		if (!root) {
			return ['/'];
		}

		const folders = new Set<string>(['/']);
		const stack: TFolder[] = [root];
		while (stack.length) {
			const folder = stack.pop();
			if (!folder) {
				continue;
			}
			const normalized = folder.path && folder.path !== '/' ? folder.path : '/';
			folders.add(normalized);

			for (const child of folder.children) {
				if (child instanceof TFolder) {
					stack.push(child);
				}
			}
		}

		return Array.from(folders).sort((a, b) => a.localeCompare(b));
	}

	private getLastSyncDescription() {
		if (!this.plugin.settings.lastSyncTime) {
			return 'Never synced';
		}

		return new Date(this.plugin.settings.lastSyncTime).toLocaleString();
	}
}
