import { App, Modal, Setting } from 'obsidian';

/**
 * Asked when the user deletes a mount's root folder in Obsidian. The only
 * action offered is to unmount it (no files touched): deleting a whole
 * shared folder is deliberately left to File Explorer.
 */
export class MountRootDeleteModal extends Modal {
	private remember = false;
	private settled = false;

	constructor(
		app: App,
		private readonly mountPath: string,
		private readonly onChoose: (unmount: boolean, remember: boolean) => void,
	) {
		super(app);
	}

	private settle(unmount: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.onChoose(unmount, unmount && this.remember);
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle('Unmount folder?');
		contentEl.createEl('p', { text: `"${this.mountPath}" is a mounted folder. Deleting it here only removes it from this vault; no files on the drive are deleted or moved.` });
		contentEl.createEl('p', { cls: 'setting-item-description', text: 'To delete the real folder, use File Explorer.' });
		new Setting(contentEl)
			.setName("Don't ask again")
			.setDesc('Unmount without asking next time. You can change this in the plugin settings.')
			.addToggle(toggle => toggle.setValue(false).onChange(value => { this.remember = value; }));
		new Setting(contentEl)
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.settle(false)))
			.addButton(b => b.setButtonText('Unmount').setCta().onClick(() => this.settle(true)));
	}

	onClose(): void {
		this.contentEl.empty();
		this.settle(false);
	}
}
