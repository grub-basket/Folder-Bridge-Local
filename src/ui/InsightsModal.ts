import { App, Modal, Notice, Setting, TFolder, normalizePath } from 'obsidian';
import type FolderBridgePlugin from '../../main';
import { MountPoint } from '../types';
import { FolderTotals, computeInsights, formatBytes } from '../mountInsights';
import { stripLongPathPrefix } from '../OSHelpers';

/**
 * "What's in this mount?" — totals, the folders that hold most of it, and
 * one-click ways to make the mount smaller (hide a folder, notes only).
 * Everything is read from Obsidian's index: opening this does no disk or
 * network access, and hiding is pruned in memory too.
 */
export class InsightsModal extends Modal {
	constructor(app: App, private readonly plugin: FolderBridgePlugin, private mount: MountPoint) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('folderbridge-insights-modal');
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const mount = this.plugin.settings.mountPoints.find(m => m.id === this.mount.id) ?? this.mount;
		this.mount = mount;
		this.setTitle(`What's in "${this.plugin.displayName(mount)}"`);
		contentEl.createEl('p', { cls: 'setting-item-description', text: stripLongPathPrefix(this.plugin.pathMapper.getEffectiveRealPath(mount)) });

		const root = this.app.vault.getAbstractFileByPath(normalizePath(mount.virtualPath));
		if (!(root instanceof TFolder)) {
			contentEl.createEl('p', { text: 'This mount is not loaded right now (turned off, offline, or still starting).' });
			return;
		}
		const insights = computeInsights(root);
		const total = insights.files + insights.folders;

		const summary = contentEl.createDiv({ cls: 'folderbridge-insights-summary' });
		const stat = (value: string, label: string) => {
			const box = summary.createDiv({ cls: 'folderbridge-insights-stat' });
			box.createDiv({ cls: 'folderbridge-insights-value', text: value });
			box.createDiv({ cls: 'folderbridge-insights-label', text: label });
		};
		stat(insights.files.toLocaleString(), 'files');
		stat(insights.notes.toLocaleString(), 'notes');
		stat(insights.folders.toLocaleString(), 'folders');
		stat(formatBytes(insights.bytes), 'on the drive');

		const scan = this.plugin.lastScan.get(mount.id);
		if (scan) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: `Last full check of the drive: ${(scan.ms / 1000).toFixed(1)} s for ${scan.scanned.toLocaleString()} items, ${new Date(scan.at).toDateString() === new Date().toDateString() ? `at ${new Date(scan.at).toLocaleTimeString()}` : `on ${new Date(scan.at).toLocaleString()}`}. ` +
					`Every launch repeats this check in the background, so fewer items means less waiting on the network.`,
			});
		}

		// Hint: most files are not notes and the mount shows everything.
		const others = insights.files - insights.notes;
		if ((mount.visibleFileFilter ?? 'all') === 'all' && insights.files >= 50 && others / insights.files >= 0.5) {
			new Setting(contentEl)
				.setName(`${others.toLocaleString()} of ${insights.files.toLocaleString()} files are not notes`)
				.setDesc('If your notes and Bases don\'t need to see the spreadsheets, PDFs and other files, "Notes only" hides them and makes every check of the drive faster.')
				.addButton(b => b.setButtonText('Switch to notes only').onClick(async () => {
					b.setDisabled(true);
					const error = await this.plugin.editMount(mount.id, m => ({ ...m, visibleFileFilter: 'markdown-only' }));
					if (error) new Notice(`Folder Bridge: ${error}`);
					this.render();
				}));
		}

		new Setting(contentEl).setName('Biggest folders').setHeading()
			.setDesc('Hiding a folder takes it out of the vault right away and it is never checked again. Undo by removing it from the mount\'s ignore list.');
		if (insights.biggest.length === 0) {
			contentEl.createEl('p', { cls: 'setting-item-description', text: 'No subfolders.' });
			return;
		}
		const table = contentEl.createDiv({ cls: 'folderbridge-insights-table' });
		for (const folder of insights.biggest) this.renderRow(table, folder, total);
	}

	private renderRow(table: HTMLElement, folder: FolderTotals, total: number): void {
		const share = total > 0 ? (folder.files + folder.folders) / total : 0;
		const row = table.createDiv({ cls: 'folderbridge-insights-row' });
		const name = row.createDiv({ cls: 'folderbridge-insights-name' });
		name.createSpan({ text: folder.rel });
		const bar = name.createDiv({ cls: 'folderbridge-insights-bar' });
		bar.createDiv({ cls: 'folderbridge-insights-fill' }).setCssProps({ '--folderbridge-share': `${Math.max(1, Math.round(share * 100))}%` });
		row.createDiv({
			cls: 'folderbridge-insights-numbers',
			text: `${Math.round(share * 100)}% · ${folder.files.toLocaleString()} files${folder.notes ? ` (${folder.notes.toLocaleString()} notes)` : ''} · ${formatBytes(folder.bytes)}`,
		});
		const hide = row.createEl('button', { text: 'Hide' });
		hide.setAttribute('aria-label', `Hide "${folder.rel}" from this mount`);
		hide.addEventListener('click', () => void (async () => {
			hide.disabled = true;
			row.addClass('is-hiding');
			const error = await this.plugin.hideInMount(this.mount.id, folder.rel);
			new Notice(error ? `Folder Bridge: ${error}` : `Folder Bridge: Hid "${folder.rel}".`);
			this.render();
		})());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
