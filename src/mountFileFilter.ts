import { MountPoint } from './types';

export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.canvas', '.mdx']);
export const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf']);

/**
 * File types that run code when opened. They are never shown from a mount:
 * on a shared drive anyone could drop "invoice.exe" or a .lnk next to the
 * notes, and Obsidian opens unknown types with the default app on click.
 * Intranet and mapped-drive paths carry no Mark-of-the-Web warning.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.exe', '.com', '.bat', '.cmd', '.scr', '.pif', '.cpl', '.msc', '.msi', '.msp',
	'.lnk', '.url', '.appref-ms', '.library-ms', '.searchconnector-ms', '.settingcontent-ms',
	'.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.reg', '.inf', '.application',
]);

function getLowercaseExtension(filePath: string): string {
	const leaf = filePath.split('/').pop() ?? filePath;
	const dotIndex = leaf.lastIndexOf('.');
	return dotIndex > 0 ? leaf.slice(dotIndex).toLowerCase() : '';
}

export function isVisibleFileInMount(filePath: string, mount: Pick<MountPoint, 'visibleFileFilter'>): boolean {
	const extension = getLowercaseExtension(filePath);
	if (EXECUTABLE_EXTENSIONS.has(extension)) return false;
	const filter = mount.visibleFileFilter ?? 'all';
	if (filter === 'all') return true;
	if (!extension) return false;
	if (filter === 'markdown-only') return MARKDOWN_EXTENSIONS.has(extension);
	if (filter === 'pdf-only') return PDF_EXTENSIONS.has(extension);
	return true;
}
