import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

export const IS_WINDOWS = typeof process !== 'undefined' && process.platform === 'win32';
export const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin';
/** APFS/HFS+ (default) and NTFS/SMB ignore case in file names; Linux file systems do not. */
export const CASE_INSENSITIVE_FS = IS_WINDOWS || IS_MAC;

/** Example paths shown in the UI, in this computer's own style. */
export const PATH_EXAMPLES = IS_WINDOWS
	? { folder: 'Z:\\Finance\\Reports', share: '\\\\server\\share\\Reports', describe: 'A folder on this PC, a mapped drive (Z:\\Finance\\Reports) or a network share (\\\\server\\share\\Reports).' }
	: IS_MAC
		? { folder: '/Users/you/Documents/Reports', share: '/Volumes/Share/Reports', describe: 'A folder on this Mac, or a mounted network share (/Volumes/Share/Reports).' }
		: { folder: '/home/you/Documents/Reports', share: '/mnt/share/Reports', describe: 'A folder on this computer, or a mounted network share (/mnt/share/Reports).' };

export interface ElectronShell {
	trashItem?(p: string): Promise<void>;
	openPath?(p: string): Promise<string>;
	showItemInFolder?(p: string): void;
}

/** Electron's shell module from Obsidian's renderer, or null outside Obsidian (tests). */
export function getElectronShell(): ElectronShell | null {
	try {
		const req = (globalThis as { require?: (id: string) => unknown }).require;
		const electron = req?.('electron') as { shell?: ElectronShell } | undefined;
		return electron?.shell ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timer. Used for reachability probes: on Windows a
 * disconnected SMB share can make a single fs call hang for a long time, and
 * we would rather report "unreachable" than freeze a settings page.
 *
 * The underlying fs call keeps running (Node cannot cancel it); callers that
 * probe repeatedly must avoid starting a new probe while one is outstanding.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>(resolve => {
		timer = setTimeout(() => resolve(onTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Accessibility checks
// ---------------------------------------------------------------------------

export interface PathAccessResult {
	accessible: boolean;
	readOnly: boolean;
	error?: string;
}

/** How long a reachability probe may take before the path counts as unreachable. */
export const ACCESS_PROBE_TIMEOUT_MS = 5000;

/** Raw probes still running, by path (they can outlive their timeout). */
const probesInFlight = new Map<string, Promise<PathAccessResult>>();

/**
 * Check whether a real filesystem path is an accessible directory, and if so
 * whether it is writable. Never throws; never waits longer than
 * ACCESS_PROBE_TIMEOUT_MS.
 *
 * At most ONE underlying probe per path runs at a time. A call against a dead
 * SMB server can block one of Node's four file-system threads for a minute;
 * starting a fresh probe on every health check would soon block all four,
 * and with them every file operation in Obsidian.
 */
export function checkPathAccessible(realPath: string): Promise<PathAccessResult> {
	const existing = probesInFlight.get(realPath);
	if (existing) {
		return withTimeout(existing, ACCESS_PROBE_TIMEOUT_MS, () => ({
			accessible: false, readOnly: false, error: 'Still waiting for the previous check (network drive offline?).',
		}));
	}
	const probe = (async (): Promise<PathAccessResult> => {
		try {
			const stat = await fs.promises.stat(realPath);
			if (!stat.isDirectory()) return { accessible: false, readOnly: false, error: 'Not a folder.' };
		} catch (e) {
			return { accessible: false, readOnly: false, error: (e as Error).message };
		}
		let readOnly = false;
		try {
			await fs.promises.access(realPath, fs.constants.W_OK);
		} catch {
			readOnly = true;
		}
		return { accessible: true, readOnly };
	})();
	probesInFlight.set(realPath, probe);
	void probe.finally(() => { if (probesInFlight.get(realPath) === probe) probesInFlight.delete(realPath); });
	return withTimeout(probe, ACCESS_PROBE_TIMEOUT_MS, () => ({
		accessible: false,
		readOnly: false,
		error: `No response after ${ACCESS_PROBE_TIMEOUT_MS / 1000} s (network drive offline?).`,
	}));
}

/**
 * Called after a read failed. Returns true when the path still exists on disk,
 * which is the fingerprint of an OneDrive / SharePoint "Files On Demand"
 * online-only placeholder that cannot be hydrated right now.
 */
export async function isCloudPlaceholder(realPath: string): Promise<boolean> {
	try {
		await fs.promises.access(realPath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Resource URLs
// ---------------------------------------------------------------------------

/**
 * file:// URL of a real path. URLs drop "localhost" as a file host, so
 * pathToFileURL('\\\\localhost\\share\\x') gives file:///share/x — a local
 * path. Put the server back so the share is still the one addressed.
 */
export function realPathToFileUrl(realPath: string): string {
	const plain = stripLongPathPrefix(realPath);
	const href = pathToFileURL(plain).href;
	if (IS_WINDOWS && isUNCPath(plain) && href.startsWith('file:///')) {
		return 'file://' + plain.slice(2).split(/[\\/]/)[0] + href.substring(7);
	}
	return href;
}

/**
 * file:// URL for opening a real path with another program ("Open in default
 * app"). Windows reads a file URL whose host is "localhost" as a path on this
 * PC's own disk, so \\localhost\share\x would not be found; 127.0.0.1 names
 * the same machine and is opened as the share.
 */
export function realPathToExternalUrl(realPath: string): string {
	const href = realPathToFileUrl(realPath);
	return IS_WINDOWS ? href.replace(/^file:\/\/localhost\//i, 'file://127.0.0.1/') : href;
}

/**
 * Build the URL Obsidian's renderer uses to display a file (image, PDF,
 * audio, video). This is a copy of Obsidian's own
 * FileSystemAdapter.getResourcePath recipe, so mounted files load through the
 * same `app://` protocol handler as vault files. That handler serves any
 * absolute path, supports streaming, and needs no data: URIs or local server.
 *
 * Windows examples (prefix "app://<id>/"):
 *   C:\Docs\a b.png           → app://<id>/C:/Docs/a%20b.png?<mtime>
 *   \\server\share\x.png      → app://<id>/%5C%5Cserver/share/x.png?<mtime>
 */
export function realPathToResourceUrl(resourcePathPrefix: string, realPath: string, mtime?: number): string {
	let href = realPathToFileUrl(realPath);
	if (href.startsWith('file:///')) href = href.substring(8);
	else if (href.startsWith('file://')) href = '%5C%5C' + href.substring(7);
	return `${resourcePathPrefix}${href}?${mtime || Date.now()}`;
}

// ---------------------------------------------------------------------------
// Windows path utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a path for equality comparison using the candidate's dialect.
 * Windows drive and UNC paths compare case-insensitively on every host;
 * POSIX paths preserve case. Supported extended prefixes compare identically
 * to their ordinary filesystem forms.
 */
export function normalizeForComparison(p: string): string {
	if (isUnsupportedWindowsDevicePath(p)) return p;
	const windowsStyle = /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
	if (windowsStyle || (IS_WINDOWS && !p.startsWith('/'))) {
		const ordinaryPath = p.replace(/\//g, '\\')
			.replace(/^\\\\\?\\([a-zA-Z]:\\)/, '$1')
			.replace(/^\\\\\?\\UNC\\/i, '\\\\');
		const normalized = path.win32.normalize(ordinaryPath);
		const root = path.win32.parse(normalized).root;
		const trimmed = normalized !== root ? normalized.replace(/[\\/]+$/, '') : normalized;
		// Win32 silently drops trailing dots and spaces from each name, so
		// "C:\Windows." opens C:\Windows: compare the names it would open.
		const rest = trimmed.slice(root.length).split('\\').map(seg => seg.replace(/[. ]+$/, '')).join('\\');
		return (root + rest).replace(/\\/g, '/').toLowerCase();
	}

	const normalized = path.posix.normalize(p);
	const root = path.posix.parse(normalized).root;
	return normalized !== root ? normalized.replace(/\/+$/g, '') : normalized;
}

/** True for `\\.\`, `\??\` and malformed `\\?\` paths that address devices, not folders. */
export function isUnsupportedWindowsDevicePath(candidatePath: string): boolean {
	const windowsPath = candidatePath.replace(/\//g, '\\');
	if (/^\\{1,2}\?\?\\/.test(windowsPath) || windowsPath.startsWith('\\\\.\\')) return true;
	if (!windowsPath.startsWith('\\\\?\\')) return false;
	if (/^\\\\\?\\[a-zA-Z]:\\/.test(windowsPath)) return false;
	const unc = windowsPath.match(/^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)(?:\\|$)/i);
	return !unc || unc.slice(1).some(segment => segment === '.' || segment === '..');
}

/** Returns true for UNC network paths (e.g. `\\server\share`). */
export function isUNCPath(p: string): boolean {
	return /^[\\/]{2}[^\\/?.]/.test(p);
}

/**
 * Win32 APIs reject paths of 260+ characters (248+ for folders) unless they
 * carry the `\\?\` (or `\\?\UNC\`) prefix. Apply it when needed on Windows.
 * Deep finance folder trees on network shares hit this regularly.
 */
export function ensureLongPathPrefix(p: string): string {
	if (!IS_WINDOWS) return p;
	if (p.startsWith('\\\\?\\')) return p;
	if (p.length < 248) return p;
	const resolved = path.win32.resolve(p); // \\?\ disables normalization, so normalize first
	if (resolved.startsWith('\\\\')) return '\\\\?\\UNC\\' + resolved.slice(2);
	return '\\\\?\\' + resolved;
}

/** Inverse of ensureLongPathPrefix, for display and URL building. */
export function stripLongPathPrefix(p: string): string {
	if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8);
	if (p.startsWith('\\\\?\\')) return p.slice(4);
	return p;
}

/**
 * Returns true when `name` cannot be created on Windows: reserved device
 * names (CON, NUL, COM1-9, LPT1-9 — even with an extension), characters
 * Windows forbids, or a trailing dot/space (silently stripped by Win32,
 * which would make the file unreachable under the name Obsidian asked for).
 */
export function invalidWindowsNameReason(name: string): string | null {
	if (!IS_WINDOWS) return null;
	const stem = name.split('.')[0];
	if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem.trim())) {
		return `"${name}" is a reserved device name on Windows (CON, NUL, COM1-9, LPT1-9, …).`;
	}
	// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows forbids
	if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
		return `"${name}" contains a character Windows does not allow in file names (< > : " | ? *).`;
	}
	if (/[. ]$/.test(name)) {
		return `"${name}" ends with a dot or space, which Windows does not allow.`;
	}
	return null;
}

/**
 * Translate a Node.js filesystem error code into a user-friendly message
 * with Windows-specific guidance where relevant.
 */
export function translateFsError(err: NodeJS.ErrnoException, op: string): string {
	const p = err.path ? `"${stripLongPathPrefix(err.path)}"` : 'path';
	switch (err.code) {
		case 'EACCES':
		case 'EPERM':
			return `Access denied to ${p}. Check that your account has permission on this folder or share.`;
		case 'ENAMETOOLONG':
			return `Path is too long for Windows. Shorten folder or file names.`;
		case 'EBUSY':
			return `${p} is open in another program (Excel, Word, …). Close it and try again.`;
		case 'ENOENT':
			return `${p} was not found. It may have been moved or deleted.`;
		case 'ENOSPC':
			return `Not enough disk space to complete the operation.`;
		case 'EEXIST':
			return `${p} already exists.`;
		case 'ENOTEMPTY':
			return `${p} is not empty.`;
		case 'ETIMEDOUT':
		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return `The network drive holding ${p} is not responding.`;
		default:
			return `${op}: ${err.message}`;
	}
}
