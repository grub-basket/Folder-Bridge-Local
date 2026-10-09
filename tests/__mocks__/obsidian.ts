/**
 * Minimal stub of the Obsidian API for unit tests. Only what the source
 * modules use. normalizePath mirrors Obsidian's real behaviour.
 */
export function normalizePath(p: string): string {
	const n = p.replace(/([\\/])+/g, '/').replace(/(^\/+|\/+$)/g, '');
	return n === '' ? '/' : n.normalize('NFC');
}

export class Notice {
	constructor(public message: string, public timeout?: number) { }
	setMessage(message: string): this { this.message = message; return this; }
	hide(): void { }
}

export class Plugin { constructor(public app: unknown, public manifest: unknown) { } }
export class PluginSettingTab { }
export class Modal { }
export class FuzzySuggestModal { }
export class AbstractInputSuggest { }

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
}
export class TFile extends TAbstractFile {
	stat = { ctime: 0, mtime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean { return this.path === '/'; }
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	resourcePathPrefix: 'app://test-id/',
};
