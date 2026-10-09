import { App, PluginSettingTab, Setting } from 'obsidian';
import type FolderBridgePlugin from '../../main';
import { ConflictMode, DEFAULT_SETTINGS, MountPoint } from '../types';
import { stripLongPathPrefix } from '../OSHelpers';

export class FolderBridgeSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FolderBridgePlugin) {
		super(app, plugin);
	}

	display(): void {
		this.render();
	}

	/** Rebuild the tab (also called after changes made from this tab). */
	render(): void {
		const { containerEl } = this;
		containerEl.empty();
		const { settings } = this.plugin;

		new Setting(containerEl)
			.setName('Mounts')
			.setDesc('Folders from this PC or the network, shown inside this vault. Removing a mount never deletes files.')
			.setHeading()
			.addButton(b => b.setButtonText('Add mount').setCta().onClick(() => this.plugin.openMountModal()));

		if (settings.mountPoints.length === 0) {
			containerEl.createEl('p', { cls: 'setting-item-description', text: 'No mounts yet. Use "add mount" or right-click a folder in the file explorer.' });
		}
		for (const mount of settings.mountPoints) this.renderMount(containerEl, mount);

		new Setting(containerEl).setName('Behavior').setHeading();

		new Setting(containerEl)
			.setName('When a mount folder is deleted in Obsidian')
			.setDesc('Deleting a mount folder in Obsidian only unmounts it; files on the drive are never deleted that way.')
			.addDropdown(d => d
				.addOption('ask', 'Ask before unmounting')
				.addOption('unmount', 'Unmount without asking')
				.setValue(settings.mountRootDeletionBehavior)
				.onChange(async v => {
					settings.mountRootDeletionBehavior = v as typeof settings.mountRootDeletionBehavior;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('When a note changed on the drive while you edit it')
			.setDesc('A colleague saved the same note before Obsidian noticed. Merge combines both sets of changes and keeps a copy of their version only when you both changed the same lines.')
			.addDropdown(d => d
				.addOption('merge', 'Merge both versions (recommended)')
				.addOption('copy', 'Keep their version as a copy, save mine')
				.addOption('overwrite', 'Save mine, discard theirs')
				.setValue(settings.conflictMode)
				.onChange(async v => {
					settings.conflictMode = v as ConflictMode;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Status bar')
			.setDesc('Show the mount count and offline warnings in the status bar.')
			.addToggle(t => t.setValue(settings.showStatusBar).onChange(async v => {
				settings.showStatusBar = v;
				await this.plugin.saveSettings();
				if (v) this.plugin.createStatusBar();
				else this.plugin.removeStatusBar();
			}));

		let pending = settings.globalIgnorePatterns.join('\n');
		new Setting(containerEl)
			.setName('Ignore in every mount')
			.setDesc('One per line: a name, a path, or a pattern with *. Applied to all mounts.')
			.addTextArea(t => {
				t.setValue(pending).onChange(v => { pending = v; });
				t.inputEl.rows = 6;
				t.inputEl.addClass('folderbridge-input-wide');
			})
			.addButton(b => b.setButtonText('Apply').onClick(async () => {
				await this.plugin.setGlobalIgnorePatterns(pending.split('\n').map(s => s.trim()).filter(Boolean));
				this.render();
			}))
			.addExtraButton(b => b.setIcon('reset').setTooltip('Restore defaults').onClick(async () => {
				await this.plugin.setGlobalIgnorePatterns([...DEFAULT_SETTINGS.globalIgnorePatterns]);
				this.render();
			}));
	}

	private renderMount(containerEl: HTMLElement, mount: MountPoint): void {
		const health = this.plugin.health.get(mount.id);
		const effective = stripLongPathPrefix(this.plugin.pathMapper.getEffectiveRealPath(mount));
		const parts = [`${mount.virtualPath}  ←  ${effective}`];
		if (effective !== mount.realPath) parts.push('(using fallback path)');
		if (mount.readOnly) parts.push('· read-only');
		if (mount.watchMode === 'poll') parts.push('· checks periodically');
		if (mount.watchMode === 'off') parts.push('· change detection off');

		const row = new Setting(containerEl)
			.setName(`${health === 'unreachable' ? '⚠ ' : ''}${this.plugin.displayName(mount)}`)
			.setDesc(parts.join(' '));
		row.settingEl.addClass('folderbridge-mount-row');
		const syncReason = this.plugin.syncBlocked.get(mount.id);
		if (syncReason) row.descEl.createDiv({ cls: 'folderbridge-error', text: `Not mounted: ${syncReason}` });
		if (health === 'unreachable') {
			const what = this.plugin.missing.has(mount.id) ? 'Folder not found' : 'Offline';
			row.descEl.createDiv({ cls: 'folderbridge-error', text: `${what}: ${this.plugin.healthError.get(mount.id) ?? 'not reachable'}` });
		}
		row
			.addToggle(t => t.setTooltip(mount.enabled ? 'Turn off' : 'Turn on').setValue(mount.enabled).onChange(async v => {
				await this.plugin.setMountEnabled(mount.id, v);
				this.render();
			}))
			.addExtraButton(b => b.setIcon('refresh-cw').setTooltip('Rescan').setDisabled(!mount.enabled).onClick(async () => {
				await this.plugin.rescanMount(mount);
				this.render();
			}))
			.addExtraButton(b => b.setIcon('bar-chart-2').setTooltip("What's in this mount?").setDisabled(!mount.enabled).onClick(() => this.plugin.openInsights(mount)))
			.addExtraButton(b => b.setIcon('pencil').setTooltip('Edit').onClick(() => this.plugin.openMountModal(mount)))
			.addExtraButton(b => b.setIcon('trash').setTooltip('Remove mount (files are kept)').onClick(async () => {
				await this.plugin.removeMount(mount.id);
				this.render();
			}));
	}
}
