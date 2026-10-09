import { AbstractInputSuggest, App, Modal, Notice, Setting, TextComponent, TFolder, normalizePath } from 'obsidian';
import type FolderBridgePlugin from '../../main';
import { MountPoint, MountVisibleFileFilter, MountWatchMode } from '../types';
import { IS_WINDOWS, PATH_EXAMPLES, checkPathAccessible, isUNCPath } from '../OSHelpers';
import { DEFAULT_POLL_INTERVAL_MS } from '../FileWatcher';
import { logger } from '../logger';

type OpenDialogResult = { canceled: boolean; filePaths: string[] };
type ElectronDialog = { showOpenDialog(options: { properties: string[]; title: string; defaultPath?: string }): Promise<OpenDialogResult> };

/** Native "choose folder" dialog, or null when unavailable/cancelled. */
async function browseForFolder(title: string, defaultPath?: string): Promise<string | null> {
	try {
		const req = (globalThis as { require?: (id: string) => unknown }).require;
		const electron = req?.('electron') as { remote?: { dialog?: ElectronDialog }; dialog?: ElectronDialog } | undefined;
		const dialog = electron?.remote?.dialog ?? electron?.dialog;
		if (!dialog?.showOpenDialog) {
			new Notice('The folder picker is unavailable. Type or paste the path instead.');
			return null;
		}
		const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title, defaultPath: defaultPath || undefined });
		return result.canceled || !result.filePaths?.length ? null : result.filePaths[0];
	} catch (error) {
		logger.error('Folder picker failed', error);
		new Notice('The folder picker is unavailable. Type or paste the path instead.');
		return null;
	}
}

/** Suggests existing vault folders while typing the vault folder name. */
class VaultFolderSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private readonly inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	/** Vault folders, collected once per dialog (the vault can hold many mounted files). */
	private folders: string[] | null = null;

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		this.folders ??= this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
			.map(f => f.path + '/');
		return this.folders.filter(p => p.toLowerCase().includes(q)).slice(0, 50);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.inputEl.value = value;
		this.inputEl.trigger('input');
		this.close();
	}
}

/** Add or edit one mount. */
export class MountModal extends Modal {
	private draft: Omit<MountPoint, 'id'>;
	private errorEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private saving = false;
	private virtualPathInput: TextComponent | null = null;
	/** Stop auto-filling the vault folder once the user typed one. */
	private virtualPathTouched: boolean;

	constructor(
		app: App,
		private readonly plugin: FolderBridgePlugin,
		private readonly existing?: MountPoint,
		defaults?: Partial<MountPoint>,
	) {
		super(app);
		const base: Omit<MountPoint, 'id'> = {
			virtualPath: '',
			realPath: '',
			enabled: true,
			readOnly: false,
			ignoreList: [],
			visibleFileFilter: 'all',
			watchMode: 'native',
		};
		const source: Partial<MountPoint> = { ...(existing ?? {}), ...(defaults ?? {}) };
		delete source.id;
		this.draft = { ...base, ...source };
		this.virtualPathTouched = !!existing || !!defaults?.virtualPath;
	}

	onOpen(): void {
		this.setTitle(this.existing ? 'Edit mount' : 'Add mount');
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('folderbridge-modal');

		new Setting(contentEl)
			.setName('Real folder')
			.setDesc(PATH_EXAMPLES.describe)
			.addText(text => {
				text.setPlaceholder(PATH_EXAMPLES.folder).setValue(this.draft.realPath).onChange(v => {
					this.draft.realPath = v.trim();
					this.suggestVirtualPath();
					this.checkPath();
				});
				text.inputEl.addClass('folderbridge-input-wide');
			})
			.addButton(b => b.setButtonText('Browse…').onClick(async () => {
				const picked = await browseForFolder('Choose the folder to mount', this.draft.realPath);
				if (!picked) return;
				this.draft.realPath = picked;
				this.suggestVirtualPath();
				this.render();
				this.checkPath();
			}));

		this.statusEl = contentEl.createDiv({ cls: 'folderbridge-path-status setting-item-description' });

		new Setting(contentEl)
			.setName('Vault folder')
			.setDesc('Where the folder appears in this vault. Must not already exist; it is created by the mount.')
			.addText(text => {
				this.virtualPathInput = text;
				text.setPlaceholder('Finance/Reports').setValue(this.draft.virtualPath).onChange(v => {
					this.draft.virtualPath = v.trim().replace(/\/+$/, '');
					this.virtualPathTouched = this.draft.virtualPath !== '';
				});
				text.inputEl.addClass('folderbridge-input-wide');
				new VaultFolderSuggest(this.app, text.inputEl);
			});

		new Setting(contentEl)
			.setName('Label')
			.setDesc('Optional name shown in settings and notices.')
			.addText(text => text.setValue(this.draft.label ?? '').onChange(v => { this.draft.label = v.trim() || undefined; }));

		new Setting(contentEl)
			.setName('Read-only')
			.setDesc('Block every change from Obsidian (edits, renames, deletes). Recommended for shared finance folders you only report from.')
			.addToggle(t => t.setValue(this.draft.readOnly).onChange(v => { this.draft.readOnly = v; }));

		new Setting(contentEl)
			.setName('File types')
			.setDesc('Show only some files. "Notes only" keeps big shares fast when you just need notes and Bases.')
			.addDropdown(d => d
				.addOption('all', 'All files')
				.addOption('markdown-only', 'Notes only (Markdown, canvas, Bases)')
				.addOption('pdf-only', 'PDF only')
				.setValue(this.draft.visibleFileFilter ?? 'all')
				.onChange(v => { this.draft.visibleFileFilter = v as MountVisibleFileFilter; }));

		new Setting(contentEl)
			.setName('Ignore')
			.setDesc('One per line. A name hides it anywhere (Archive). Starting with / or containing / means a path from the mount root (/Archive, 2019/Old). * is a wildcard (*.tmp). Hidden items are never scanned.')
			.addTextArea(t => {
				t.setPlaceholder('Archive\n2019/Old\n*.bak').setValue((this.draft.ignoreList ?? []).join('\n')).onChange(v => {
					this.draft.ignoreList = v.split('\n').map(s => s.trim()).filter(Boolean);
				});
				t.inputEl.rows = 4;
				t.inputEl.addClass('folderbridge-input-wide');
			});

		const advanced = contentEl.createEl('details', { cls: 'folderbridge-advanced' });
		advanced.createEl('summary', { text: 'Advanced' });

		new Setting(advanced)
			.setName('Fallback path')
			.setDesc(IS_WINDOWS
				? 'Tried when the real folder is unreachable, e.g. the \\\\server\\share form of a mapped drive for PCs where the letter differs.'
				: 'Tried when the real folder is unreachable, e.g. where the same share is mounted on another computer.')
			.addText(text => {
				text.setPlaceholder(PATH_EXAMPLES.share).setValue(this.draft.fallbackRealPath ?? '').onChange(v => {
					this.draft.fallbackRealPath = v.trim() || undefined;
				});
				text.inputEl.addClass('folderbridge-input-wide');
			});

		let pollSetting: Setting | null = null;
		new Setting(advanced)
			.setName('Change detection')
			.setDesc('How edits made outside Obsidian show up. Switch to "check periodically" if a share never updates live.')
			.addDropdown(d => d
				.addOption('native', 'Live (recommended)')
				.addOption('poll', 'Check periodically')
				.addOption('off', 'Off (rescan manually)')
				.setValue(this.draft.watchMode ?? 'native')
				.onChange(v => {
					this.draft.watchMode = v as MountWatchMode;
					pollSetting?.settingEl.toggleClass('folderbridge-hidden', v !== 'poll');
				}));

		pollSetting = new Setting(advanced)
			.setName('Check every (seconds)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '10';
				text.setValue(String(Math.round((this.draft.watcherPollingIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) / 1000)))
					.onChange(v => {
						const seconds = Number(v);
						this.draft.watcherPollingIntervalMs = Number.isFinite(seconds) && seconds >= 10 ? seconds * 1000 : undefined;
					});
			});
		pollSetting.settingEl.toggleClass('folderbridge-hidden', (this.draft.watchMode ?? 'native') !== 'poll');

		new Setting(advanced)
			.setName('Max items')
			.setDesc('Stop indexing after this many files and folders (0 = no limit). A safety net for very large shares.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.setValue(String(this.draft.maxFiles ?? 0)).onChange(v => {
					const n = Math.floor(Number(v));
					this.draft.maxFiles = Number.isFinite(n) && n > 0 ? n : undefined;
				});
			});

		this.errorEl = contentEl.createDiv({ cls: 'folderbridge-error' });

		new Setting(contentEl)
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(b => b.setButtonText(this.existing ? 'Save' : 'Mount').setCta().onClick(() => void this.save()));

		this.checkPath();
	}

	/** Default the vault folder to the real folder's name for new mounts. */
	private suggestVirtualPath(): void {
		if (this.virtualPathTouched) return;
		const name = this.draft.realPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
		this.draft.virtualPath = name && !/^[a-zA-Z]:$/.test(name) ? normalizePath(name) : '';
		this.virtualPathInput?.setValue(this.draft.virtualPath);
	}

	private checkSeq = 0;
	private checkTimer: number | null = null;
	/**
	 * Probe the typed path once typing pauses. Probing every keystroke would
	 * hit the network for "\\s", "\\se", "\\ser"…, and each unknown server
	 * name can hang for a long time.
	 */
	private checkPath(): void {
		const seq = ++this.checkSeq;
		const el = this.statusEl;
		const realPath = this.draft.realPath;
		if (!el) return;
		if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
		if (!realPath) { el.setText(''); return; }
		if (isUNCPath(realPath) && realPath.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean).length < 2) {
			el.setText('Add the share name: \\\\server\\share\\folder');
			return;
		}
		el.setText('Checking…');
		this.checkTimer = window.setTimeout(() => {
			this.checkTimer = null;
			this.runPathCheck(seq, el, realPath);
		}, 700);
	}

	private runPathCheck(seq: number, el: HTMLElement, realPath: string): void {
		void checkPathAccessible(realPath).then(result => {
			if (seq !== this.checkSeq) return;
			if (!result.accessible) el.setText(`⚠ Not reachable right now: ${result.error ?? 'unknown error'}`);
			else el.setText(`✓ Reachable${result.readOnly ? ' (your account cannot write here; mount it read-only)' : ''}${isUNCPath(realPath) ? ' · network share' : ''}`);
		});
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.errorEl?.setText('');
		try {
			const draft = { ...this.draft, virtualPath: normalizePath(this.draft.virtualPath) };
			const error = this.existing
				? await this.plugin.updateMount(this.existing.id, draft)
				: await this.plugin.addMount(draft);
			if (error) {
				this.errorEl?.setText(error);
				return;
			}
			this.close();
		} finally {
			this.saving = false;
		}
	}

	onClose(): void {
		if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
		this.contentEl.empty();
	}
}
