import { App, Modal, Notice, Setting, TFolder, normalizePath, parseYaml } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type FolderBridgePlugin from '../../main';
import { MountPoint, MountVisibleFileFilter } from '../types';
import { CASE_INSENSITIVE_FS, PATH_EXAMPLES, stripLongPathPrefix, withTimeout } from '../OSHelpers';
import { FoundBase, MountSuggestion, folderRefsFromYaml, guessShareRoot, suggestMounts, embeddedBaseBlocks } from '../baseFolders';
import { CancelToken, DiskBase, FolderCount, countFolder, findBasesOnDisk } from '../baseScan';
import { formatBytes } from '../mountInsights';
import { IgnoreMatcher } from '../IgnoreMatcher';
import { browseForFolder } from './MountModal';

type Source = 'vault' | 'disk';

interface Row {
	suggestion: MountSuggestion;
	realPath: string;
	/** undefined while checking. */
	exists?: boolean;
	count?: FolderCount | 'counting' | 'failed';
	added?: boolean;
	error?: string;
}

/**
 * "Suggest mounts from Bases": find the Bases in this vault or on a share,
 * read which folders their filters use, and offer to mount exactly those
 * folders at the vault paths the Bases expect.
 */
export class BaseScanModal extends Modal {
	private source: Source;
	private shareRoot: string;
	private readNotes = false;
	private phase: 'setup' | 'scanning' | 'results' = 'setup';
	/** Stops the running scan (Stop button or closing). */
	private cancel: CancelToken = { cancelled: false };
	/** Stops the size counts of the current results (Back, a new scan, or closing). */
	private counts: CancelToken = { cancelled: false };
	/** Bumped per scan, so checks still running from an earlier scan can't touch newer results. */
	private generation = 0;
	/** Ends the wait for a running scan right away (Stop), even if a disk call hangs. */
	private stopWaiting: (() => void) | null = null;
	/** Bases a disk scan has found so far. */
	private diskFound: DiskBase[] = [];
	private progressText = '';
	private bases: FoundBase[] = [];
	private errors: string[] = [];
	private scanCancelled = false;
	private rows: Row[] = [];
	private selected = new Set<string>();
	private fileFilter: MountVisibleFileFilter = 'all';
	private readOnly = false;
	private adding = false;

	constructor(app: App, private readonly plugin: FolderBridgePlugin) {
		super(app);
		const settings = plugin.settings;
		this.source = settings.lastBaseScanSource ?? 'vault';
		this.shareRoot = settings.lastBaseScanRoot
			?? guessShareRoot(settings.mountPoints, CASE_INSENSITIVE_FS)
			?? '';
	}

	onOpen(): void {
		this.modalEl.addClass('folderbridge-bases-modal');
		this.setTitle('Suggest mounts from Bases');
		this.render();
	}

	onClose(): void {
		this.cancel.cancelled = true;
		this.counts.cancelled = true;
		this.stopWaiting?.();
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.phase === 'setup') this.renderSetup(contentEl);
		else if (this.phase === 'scanning') this.renderScanning(contentEl);
		else this.renderResults(contentEl);
	}

	// ------------------------------------------------------------------
	// Setup
	// ------------------------------------------------------------------

	private renderSetup(el: HTMLElement): void {
		el.createEl('p', {
			cls: 'setting-item-description',
			text: 'Finds your Bases, reads which folders their filters use (for example "in folder Finance/Reports"), and suggests mounting just those folders, so the Bases keep working in this smaller vault.',
		});

		new Setting(el)
			.setName('Look for Bases in')
			.addDropdown(d => d
				.addOption('vault', 'This vault')
				.addOption('disk', 'A folder on disk (your old vault)')
				.setValue(this.source)
				.onChange(v => { this.source = v as Source; this.render(); }));

		const disk = this.source === 'disk';
		let rootInput: HTMLInputElement | null = null;
		new Setting(el)
			.setName(disk ? 'Old vault folder' : 'Share folder that matches the vault root')
			.setDesc(disk
				? 'The folder your old vault opened, usually the top of the share. It is searched for Bases, and folders are mounted from inside it.'
				: 'Where the folders your Bases name live. A Base that uses "Finance/Reports" gets that folder from inside this one, mounted at "Finance/Reports".')
			.addText(t => {
				rootInput = t.inputEl;
				// The share example without its last folder, e.g. \\server\share
				t.setPlaceholder(PATH_EXAMPLES.share.replace(/[\\/][^\\/]+$/, '')).setValue(this.shareRoot).onChange(v => { this.shareRoot = v.trim(); });
				t.inputEl.addClass('folderbridge-input-wide');
			})
			.addButton(b => b.setButtonText('Browse').onClick(async () => {
				const picked = await browseForFolder('Choose the share folder', this.shareRoot);
				if (picked && rootInput) {
					this.shareRoot = picked;
					rootInput.value = picked;
				}
			}));

		if (disk) {
			new Setting(el)
				.setName('Also look inside notes')
				.setDesc('Finds Bases embedded in notes too. This reads every note, so it is much slower on a big share.')
				.addToggle(t => t.setValue(this.readNotes).onChange(v => { this.readNotes = v; }));
		}

		new Setting(el)
			.addButton(b => b.setButtonText('Find Bases').setCta().onClick(() => void this.scan()));
	}

	// ------------------------------------------------------------------
	// Scanning
	// ------------------------------------------------------------------

	private renderScanning(el: HTMLElement): void {
		el.createEl('p', { cls: 'folderbridge-bases-progress', text: this.progressText || 'Looking for Bases…' });
		new Setting(el).addButton(b => b.setButtonText('Stop').onClick(() => {
			this.cancel.cancelled = true;
			this.stopWaiting?.();
		}));
	}

	private setProgress(text: string): void {
		this.progressText = text;
		this.contentEl.querySelector('.folderbridge-bases-progress')?.setText(text);
	}

	private async scan(): Promise<void> {
		const root = this.shareRoot.trim();
		if (this.source === 'disk' && !root) { new Notice('Folder Bridge: Choose the old vault folder first.'); return; }
		if (root) {
			const ok = await withTimeout(fs.promises.stat(root).then(s => s.isDirectory(), () => false), 5000, () => false);
			if (!ok) { new Notice(`Folder Bridge: "${root}" is not a folder that can be opened right now.`); return; }
		}
		this.plugin.settings.lastBaseScanSource = this.source;
		if (root) this.plugin.settings.lastBaseScanRoot = root;
		await this.plugin.saveSettings();

		const generation = ++this.generation;
		this.cancel = { cancelled: false };
		this.counts.cancelled = true;
		this.counts = { cancelled: false };
		this.bases = [];
		this.errors = [];
		this.diskFound = [];
		this.phase = 'scanning';
		this.progressText = '';
		this.render();
		const work = (this.source === 'disk' ? this.scanDisk(root) : this.scanVault())
			.catch(e => { this.errors.push((e as Error).message); });
		// Stop shows what was found so far at once; a disk call stuck on an
		// unresponsive share finishes (and is ignored) in the background.
		const stopped = new Promise<void>(resolve => { this.stopWaiting = resolve; });
		await Promise.race([work, stopped]);
		this.stopWaiting = null;
		if (generation !== this.generation || !this.contentEl.isConnected) return; // closed meanwhile
		if (this.source === 'disk') this.bases = this.diskBases();
		this.scanCancelled = this.cancel.cancelled;
		this.buildRows();
		this.phase = 'results';
		this.render();
		void this.checkPaths(generation);
	}

	private async scanVault(): Promise<void> {
		const parse = (yaml: string) => parseYaml(yaml) as unknown;
		const baseFiles = this.app.vault.getFiles().filter(f => f.extension === 'base');
		for (const file of baseFiles) {
			if (this.cancel.cancelled) return;
			try {
				this.bases.push({ source: file.path, refs: folderRefsFromYaml(await this.app.vault.cachedRead(file), parse) });
			} catch (e) {
				this.errors.push(`${file.path}: ${(e as Error).message}`);
			}
		}
		// Only notes with a code block can hold an embedded Base; the cache
		// says which, so other notes (and their network reads) are skipped.
		const notes = this.app.vault.getMarkdownFiles().filter(f =>
			this.app.metadataCache.getFileCache(f)?.sections?.some(s => s.type === 'code'));
		let done = 0;
		for (const note of notes) {
			if (this.cancel.cancelled) return;
			this.setProgress(`Found ${this.bases.length} Bases. Checking notes for embedded Bases: ${++done} of ${notes.length}…`);
			try {
				for (const block of embeddedBaseBlocks(await this.app.vault.cachedRead(note))) {
					this.bases.push({ source: `${note.path} (embedded)`, refs: folderRefsFromYaml(block, parse) });
				}
			} catch (e) {
				this.errors.push(`${note.path}: ${(e as Error).message}`);
			}
		}
	}

	private async scanDisk(root: string): Promise<void> {
		const scanMount: MountPoint = { id: 'base-scan', virtualPath: 'scan', realPath: root, enabled: true, readOnly: true, ignoreList: [] };
		const ignore = new IgnoreMatcher();
		ignore.rebuild(this.plugin.settings.globalIgnorePatterns, [scanMount]);
		const found: DiskBase[] = [];
		this.diskFound = found;
		const result = await findBasesOnDisk(root, {
			collect: found,
			readNotes: this.readNotes,
			skip: name => ignore.isIgnored(name, scanMount),
			cancel: this.cancel,
			onProgress: p => this.setProgress(
				`Searched ${p.folders.toLocaleString()} folders${p.notesRead ? ` and ${p.notesRead.toLocaleString()} notes` : ''}, found ${p.bases} Bases…`),
		});
		if (this.diskFound === found) this.errors.push(...result.errors);
	}

	private diskBases(): FoundBase[] {
		const parse = (yaml: string) => parseYaml(yaml) as unknown;
		return [...this.diskFound]
			.sort((a, b) => a.relPath.localeCompare(b.relPath))
			.map(b => ({ source: b.embedded ? `${b.relPath} (embedded)` : b.relPath, refs: folderRefsFromYaml(b.text, parse) }));
	}

	// ------------------------------------------------------------------
	// Results
	// ------------------------------------------------------------------

	private realPathFor(folder: string): string {
		return path.join(this.shareRoot.trim(), ...folder.split('/'));
	}

	private buildRows(): void {
		const mountFolders = this.plugin.settings.mountPoints.map(m => normalizePath(m.virtualPath));
		const suggestions = suggestMounts(this.bases, {
			mountFolders,
			isLocalFolder: p => this.app.vault.getAbstractFileByPath(normalizePath(p)) instanceof TFolder,
			caseInsensitive: CASE_INSENSITIVE_FS,
		});
		this.rows = suggestions.map(suggestion => ({ suggestion, realPath: this.shareRoot.trim() ? this.realPathFor(suggestion.folder) : '' }));
		this.selected = new Set(this.rows.filter(r => r.suggestion.status === 'new' && r.realPath).map(r => r.suggestion.folder));
	}

	/**
	 * Check that each suggested folder exists on the share; unselect the
	 * missing ones. Only confirmed folders can be added, so a mount is never
	 * saved for a folder that isn't there.
	 */
	private async checkPaths(generation: number): Promise<void> {
		const rows = this.rows;
		const pending = rows.filter(r => r.suggestion.status === 'new' && r.realPath);
		const worker = async (): Promise<void> => {
			for (let row = pending.shift(); row; row = pending.shift()) {
				const exists = await withTimeout(fs.promises.stat(row.realPath).then(s => s.isDirectory(), () => false), 5000, () => false);
				if (generation !== this.generation) return;
				row.exists = exists;
				if (!exists) this.selected.delete(row.suggestion.folder);
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
		if (generation === this.generation && this.phase === 'results' && this.contentEl.isConnected) this.render();
	}

	private renderResults(el: HTMLElement): void {
		const scopedBases = this.bases.filter(b => b.refs.folders.length > 0).length;
		el.createEl('p', {
			cls: 'setting-item-description',
			text: `${this.scanCancelled ? 'Stopped early. ' : ''}Found ${this.bases.length} Base${this.bases.length === 1 ? '' : 's'}; ${scopedBases} of them name folders.`,
		});

		const fresh = this.rows.filter(r => r.suggestion.status === 'new');
		const available = this.rows.filter(r => r.suggestion.status === 'mounted' || r.suggestion.status === 'local');
		const blocked = this.rows.filter(r => r.suggestion.status === 'overlaps');

		new Setting(el).setName('Suggested mounts').setHeading();
		if (fresh.length === 0) {
			el.createEl('p', { cls: 'setting-item-description', text: 'Nothing new to mount: every folder your Bases use is already in this vault.' });
		}
		if (fresh.length > 0 && !this.shareRoot.trim()) {
			el.createDiv({ cls: 'folderbridge-error', text: 'Set the share folder (Back) to mount these.' });
		}
		for (const row of fresh) this.renderRow(el, row);

		if (available.length) {
			new Setting(el).setName('Already in this vault').setHeading();
			for (const row of available) {
				const what = row.suggestion.status === 'mounted' ? 'mounted' : 'a folder in this vault';
				new Setting(el).setName(row.suggestion.folder).setDesc(`${what} · used by ${this.usedBy(row.suggestion)}`);
			}
		}
		if (blocked.length) {
			new Setting(el).setName('Partly mounted').setHeading()
				.setDesc('A mount already sits inside these folders, so they can\'t be mounted as a whole. Mount the other folders inside them one by one, or remove the inner mount first.');
			for (const row of blocked) new Setting(el).setName(row.suggestion.folder).setDesc(`used by ${this.usedBy(row.suggestion)}`);
		}

		const unscoped = this.bases.filter(b => b.refs.unscopedView);
		const relative = this.bases.filter(b => b.refs.relative);
		if (unscoped.length || relative.length) {
			new Setting(el).setName('Bases that don\'t name a folder').setHeading()
				.setDesc('These filter by tag, property or the note they are in, so the folders their notes live in can\'t be read from the Base. Mount those folders by hand.');
			for (const base of unscoped) new Setting(el).setName(base.source).setDesc('At least one view shows notes from anywhere in the vault.');
			for (const base of relative.filter(b => !b.refs.unscopedView)) new Setting(el).setName(base.source).setDesc('Filters on the note that embeds it (this.file), so it depends on where it is shown.');
		}

		if (this.errors.length) {
			const details = el.createEl('details', { cls: 'folderbridge-advanced' });
			details.createEl('summary', { text: `${this.errors.length} item${this.errors.length === 1 ? '' : 's'} couldn't be read` });
			const list = details.createEl('ul');
			for (const error of this.errors.slice(0, 50)) list.createEl('li', { text: error });
			if (this.errors.length > 50) list.createEl('li', { text: `…and ${this.errors.length - 50} more` });
		}

		new Setting(el).setName('New mounts').setHeading();
		new Setting(el)
			.setName('File types')
			.setDesc('"Notes only" is enough for Bases and keeps big folders fast. Pick "All files" if notes embed images or PDFs from these folders.')
			.addDropdown(d => d
				.addOption('all', 'All files')
				.addOption('markdown-only', 'Notes only (Markdown, canvas, Bases)')
				.setValue(this.fileFilter)
				.onChange(v => { this.fileFilter = v as MountVisibleFileFilter; }));
		new Setting(el)
			.setName('Read-only')
			.setDesc('Block every change from Obsidian. Good for folders you only report from.')
			.addToggle(t => t.setValue(this.readOnly).onChange(v => { this.readOnly = v; }));

		const count = this.selectedRows().length;
		const checking = fresh.some(r => r.realPath && r.exists === undefined);
		new Setting(el)
			.addButton(b => b.setButtonText('Back').onClick(() => {
				this.counts.cancelled = true;
				this.phase = 'setup';
				this.render();
			}))
			.addButton(b => b
				.setButtonText(checking ? 'Checking folders…' : count === 0 ? 'Add mounts' : `Add ${count} mount${count === 1 ? '' : 's'}`)
				.setCta()
				.setDisabled(checking || count === 0 || this.adding)
				.onClick(() => void this.addSelected()));
	}

	private usedBy(s: MountSuggestion): string {
		const names = s.usedBy.slice(0, 3).join(', ');
		return s.usedBy.length > 3 ? `${names} and ${s.usedBy.length - 3} more` : names;
	}

	private selectedRows(): Row[] {
		return this.rows.filter(r => r.suggestion.status === 'new' && !r.added && r.exists === true && this.selected.has(r.suggestion.folder));
	}

	private renderRow(el: HTMLElement, row: Row): void {
		const { suggestion } = row;
		const setting = new Setting(el).setName(suggestion.folder);
		setting.settingEl.addClass('folderbridge-bases-row');
		const desc = setting.descEl;
		if (row.realPath) desc.createDiv({ text: `← ${stripLongPathPrefix(row.realPath)}` });
		if (row.added) desc.createDiv({ cls: 'folderbridge-bases-ok', text: 'Added.' });
		else if (row.error) desc.createDiv({ cls: 'folderbridge-error', text: row.error });
		else if (row.realPath && row.exists === undefined) desc.createDiv({ text: 'Checking the folder on the share…' });
		else if (row.exists === false) desc.createDiv({ cls: 'folderbridge-error', text: 'Not found on the share. Check the share folder, or the Base may point to a folder that no longer exists.' });
		desc.createDiv({ text: `Used by ${this.usedBy(suggestion)}` });
		if (suggestion.covers.length) desc.createDiv({ text: `Also covers ${suggestion.covers.join(', ')}` });
		const count = row.count;
		if (count === 'counting') desc.createDiv({ text: 'Counting…' });
		else if (count === 'failed') desc.createDiv({ text: 'Couldn\'t count this folder.' });
		else if (count) {
			const n = (value: number, word: string) => `${value.toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
			desc.createDiv({ text: `${count.capped ? 'More than ' : ''}${n(count.files, 'file')}, ${n(count.folders, 'folder')}, ${formatBytes(count.bytes)}${count.capped ? ' (stopped counting)' : ''}` });
		}

		if (row.added) return;
		setting.addExtraButton(b => b
			.setIcon('bar-chart-2')
			.setTooltip('How big is it?')
			.setDisabled(!row.realPath || row.exists === false || count === 'counting')
			.onClick(() => void this.countRow(row)));
		setting.addToggle(t => t
			.setTooltip('Mount this folder')
			.setValue(this.selected.has(suggestion.folder))
			.setDisabled(!row.realPath)
			.onChange(v => {
				if (v) this.selected.add(suggestion.folder);
				else this.selected.delete(suggestion.folder);
				this.render();
			}));
	}

	private async countRow(row: Row): Promise<void> {
		row.count = 'counting';
		this.render();
		try {
			row.count = await countFolder(row.realPath, { limit: 50_000, cancel: this.counts });
		} catch {
			row.count = 'failed';
		}
		if (this.contentEl.isConnected) this.render();
	}

	private async addSelected(): Promise<void> {
		const rows = this.selectedRows();
		if (rows.length === 0 || this.adding) return;
		this.adding = true;
		this.render();
		let added = 0;
		for (const row of rows) {
			const error = await this.plugin.addMount({
				virtualPath: row.suggestion.folder,
				realPath: row.realPath,
				enabled: true,
				readOnly: this.readOnly,
				ignoreList: [],
				visibleFileFilter: this.fileFilter,
				watchMode: 'native',
			});
			if (error) row.error = error;
			else { row.added = true; added++; }
		}
		this.adding = false;
		const failed = rows.length - added;
		new Notice(`Folder Bridge: Added ${added} mount${added === 1 ? '' : 's'}${failed ? `; ${failed} couldn't be added (see the list)` : ''}.`);
		if (this.contentEl.isConnected) this.render();
	}
}
