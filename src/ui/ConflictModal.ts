import { App, Modal, Notice, Setting } from 'obsidian';
import { MergeRegion, conflictRegions, wordDiff } from '../textFiles';

export interface ConflictInfo {
	/** Vault path of the note. */
	path: string;
	/** The version both sides started from, when known (enables automatic merging). */
	base?: string;
	/** What Obsidian saved (already on disk). */
	mine: string;
	/** What was on the drive (kept as a copy in the trash folder). */
	theirs: string;
	/** Where their version was kept, shown for reassurance. */
	copyName: string;
	/** Label for "you", e.g. the Windows login name. */
	myName: string;
}

type Choice = 'mine' | 'theirs' | 'mine-theirs' | 'theirs-mine' | 'custom';

const CHOICES: { id: Choice; label: string; key: string }[] = [
	{ id: 'mine', label: 'Mine', key: '1' },
	{ id: 'theirs', label: 'Theirs', key: '2' },
	{ id: 'mine-theirs', label: 'Both, mine first', key: '3' },
	{ id: 'theirs-mine', label: 'Both, theirs first', key: '4' },
];

/**
 * Resolve a note that you and someone else changed in the same places.
 * Your version is already saved and theirs is kept as a copy, so closing
 * this dialog loses nothing. Each clash shows both sides with the changed
 * words highlighted; pick a side (or both, or edit), check the live result
 * at the bottom (editable), then apply.
 */
export class ConflictModal extends Modal {
	private regions: MergeRegion[];
	private choices: Choice[] = [];
	private custom: string[] = [];
	private cards: HTMLElement[] = [];
	private focused = 0;
	private preview: HTMLTextAreaElement | null = null;
	private previewEdited = false;
	private done = false;

	constructor(
		app: App,
		private readonly info: ConflictInfo,
		private readonly onApply: (resolved: string) => Promise<string | null>,
		private readonly onUseTheirs: () => Promise<string | null>,
	) {
		super(app);
		this.regions = conflictRegions(info.base, info.mine, info.theirs);
		for (const r of this.regions) {
			if (r.kind !== 'conflict') continue;
			this.choices.push('mine');
			this.custom.push(r.mine.join('\n'));
		}
	}

	private get conflictCount(): number {
		return this.choices.length;
	}

	/** The note text with the current choices applied. */
	private result(): string {
		const out: string[] = [];
		let i = 0;
		for (const r of this.regions) {
			if (r.kind === 'same') { out.push(...r.lines); continue; }
			const choice = this.choices[i];
			if (choice === 'mine') out.push(...r.mine);
			else if (choice === 'theirs') out.push(...r.theirs);
			else if (choice === 'mine-theirs') out.push(...r.mine, ...r.theirs);
			else if (choice === 'theirs-mine') out.push(...r.theirs, ...r.mine);
			else out.push(...this.custom[i].split('\n'));
			i++;
		}
		return out.join('\n');
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('folderbridge-conflict-modal');
		const name = this.info.path.split('/').pop() ?? this.info.path;
		this.setTitle(`Changes to "${name}" clashed`);

		// Did their non-clashing changes get merged in? (Result with every clash on "mine" differs from mine.)
		const autoMerged = this.info.base !== undefined && this.result().replace(/\r\n/g, '\n') !== this.info.mine.replace(/\r\n/g, '\n');
		contentEl.createEl('p', {
			text: `You and someone else changed the same ${this.conflictCount === 1 ? 'part' : `${this.conflictCount} parts`} of this note. ` +
				`Your version is saved, and theirs is kept as "${this.info.copyName}" in the trash folder, so nothing is lost if you close this.`,
		});
		if (autoMerged) {
			contentEl.createEl('p', { cls: 'setting-item-description', text: 'Changes to other lines were combined automatically and are already in the result below.' });
		}

		new Setting(contentEl)
			.setName('Whole note')
			.addButton(b => b.setButtonText('Keep my version').onClick(() => this.close()))
			.addButton(b => b.setButtonText('Use their version').onClick(() => void this.finish(() => this.onUseTheirs())));

		const list = contentEl.createDiv({ cls: 'folderbridge-conflict-list' });
		let index = 0;
		let previousSame: string[] = [];
		for (const region of this.regions) {
			if (region.kind === 'same') { previousSame = region.lines; continue; }
			this.renderCard(list, region, index++, previousSame);
		}

		const previewWrap = contentEl.createEl('details', { cls: 'folderbridge-conflict-preview' });
		previewWrap.open = true;
		previewWrap.createEl('summary', { text: 'Result (you can edit it)' });
		this.preview = previewWrap.createEl('textarea', { cls: 'folderbridge-conflict-result' });
		this.preview.rows = 12;
		this.preview.spellcheck = false;
		this.preview.value = this.result();
		this.preview.addEventListener('input', () => { this.previewEdited = true; });

		contentEl.createEl('p', { cls: 'setting-item-description', text: 'Keys: ↑/↓ move between clashes · 1–4 choose · Ctrl/Cmd+Enter apply · Esc keep mine.' });

		new Setting(contentEl)
			.addButton(b => b.setButtonText('Keep mine').onClick(() => this.close()))
			.addButton(b => b.setButtonText('Apply').setCta().onClick(() => void this.apply()));

		this.scope.register([], 'ArrowDown', () => { this.focus(this.focused + 1); return false; });
		this.scope.register([], 'ArrowUp', () => { this.focus(this.focused - 1); return false; });
		for (const c of CHOICES) {
			this.scope.register([], c.key, (evt) => {
				if (evt.target instanceof HTMLTextAreaElement) return true; // typing in a text box
				this.choose(this.focused, c.id);
				return false;
			});
		}
		this.scope.register(['Mod'], 'Enter', () => { void this.apply(); return false; });
		this.focus(0);
	}

	private renderCard(parent: HTMLElement, region: Extract<MergeRegion, { kind: 'conflict' }>, index: number, context: string[]): void {
		const card = parent.createDiv({ cls: 'folderbridge-conflict-card' });
		card.tabIndex = 0;
		card.addEventListener('focus', () => { this.focused = index; this.highlightFocus(); });
		this.cards.push(card);

		const head = card.createDiv({ cls: 'folderbridge-conflict-head' });
		head.createSpan({ text: `Clash ${index + 1} of ${this.conflictCount}` });
		const lastContext = context.filter(l => l.trim()).slice(-1)[0];
		if (lastContext) head.createSpan({ cls: 'folderbridge-conflict-context', text: `after "${lastContext.trim().slice(0, 60)}"` });

		const grid = card.createDiv({ cls: 'folderbridge-conflict-grid' });
		const mineText = region.mine.join('\n');
		const theirsText = region.theirs.join('\n');
		const parts = wordDiff(mineText, theirsText);
		const column = (title: string, side: 'a' | 'b') => {
			const col = grid.createDiv({ cls: 'folderbridge-conflict-side' });
			col.createDiv({ cls: 'folderbridge-conflict-label', text: title });
			const pre = col.createEl('pre');
			const shown = parts.filter(p => p.side === 'both' || p.side === side);
			if (shown.length === 0 || shown.every(p => p.text === '')) pre.createSpan({ cls: 'folderbridge-conflict-empty', text: '(nothing — removed)' });
			for (const p of shown) {
				if (p.side === 'both') pre.appendText(p.text);
				else pre.createSpan({ cls: side === 'a' ? 'folderbridge-diff-mine' : 'folderbridge-diff-theirs', text: p.text });
			}
		};
		column(`Yours (${this.info.myName})`, 'a');
		column('On the drive', 'b');

		const buttons = card.createDiv({ cls: 'folderbridge-conflict-choices' });
		for (const c of CHOICES) {
			const btn = buttons.createEl('button', { text: `${c.key} · ${c.label}` });
			btn.dataset.choice = c.id;
			btn.addEventListener('click', () => this.choose(index, c.id));
		}
		const editBtn = buttons.createEl('button', { text: 'Edit…' });
		editBtn.dataset.choice = 'custom';
		const editor = card.createEl('textarea', { cls: 'folderbridge-conflict-edit folderbridge-hidden' });
		editor.rows = Math.min(10, Math.max(3, region.mine.length + region.theirs.length));
		editor.value = this.custom[index];
		editor.addEventListener('input', () => {
			this.custom[index] = editor.value;
			this.choose(index, 'custom');
		});
		editBtn.addEventListener('click', () => {
			if (this.choices[index] !== 'custom') {
				editor.value = this.textFor(index, region);
				this.custom[index] = editor.value;
			}
			this.choose(index, 'custom');
			editor.focus();
		});
		this.markChoice(index);
	}

	private textFor(index: number, region: Extract<MergeRegion, { kind: 'conflict' }>): string {
		const c = this.choices[index];
		if (c === 'theirs') return region.theirs.join('\n');
		if (c === 'mine-theirs') return [...region.mine, ...region.theirs].join('\n');
		if (c === 'theirs-mine') return [...region.theirs, ...region.mine].join('\n');
		if (c === 'custom') return this.custom[index];
		return region.mine.join('\n');
	}

	private choose(index: number, choice: Choice): void {
		if (index < 0 || index >= this.conflictCount) return;
		this.choices[index] = choice;
		this.markChoice(index);
		if (this.preview) {
			if (this.previewEdited) new Notice('Folder Bridge: the result was rebuilt from your choices; manual edits to it were replaced.', 4000);
			this.preview.value = this.result();
			this.previewEdited = false;
		}
	}

	private markChoice(index: number): void {
		const card = this.cards[index];
		if (!card) return;
		card.querySelectorAll<HTMLButtonElement>('.folderbridge-conflict-choices button').forEach(b => {
			b.toggleClass('is-active', b.dataset.choice === this.choices[index]);
		});
		card.querySelector('.folderbridge-conflict-edit')?.toggleClass('folderbridge-hidden', this.choices[index] !== 'custom');
	}

	private focus(index: number): void {
		if (this.cards.length === 0) return;
		this.focused = Math.max(0, Math.min(this.cards.length - 1, index));
		this.cards[this.focused].focus();
		this.cards[this.focused].scrollIntoView({ block: 'nearest' });
		this.highlightFocus();
	}

	private highlightFocus(): void {
		this.cards.forEach((c, i) => c.toggleClass('is-focused', i === this.focused));
	}

	private async apply(): Promise<void> {
		const resolved = this.preview?.value ?? this.result();
		await this.finish(() => this.onApply(resolved));
	}

	private async finish(action: () => Promise<string | null>): Promise<void> {
		if (this.done) return;
		this.done = true;
		const error = await action();
		if (error) {
			this.done = false;
			new Notice(`Folder Bridge: ${error}`, 10000);
			return;
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
