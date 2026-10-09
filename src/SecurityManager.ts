import { normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint } from './types';
import { IS_WINDOWS, PATH_EXAMPLES, normalizeForComparison, isUNCPath, isUnsupportedWindowsDevicePath } from './OSHelpers';

/** Folder names that hold credentials; a path containing one of these segments is never mountable. */
const CREDENTIAL_FOLDERS: ReadonlySet<string> = new Set(['.ssh', '.gnupg']);

/** Exact folders that contain a protected one (macOS keeps the real /etc and /var under /private). */
const PROTECTED_PARENTS: ReadonlySet<string> = new Set(['/private']);

const DANGEROUS_PATHS = [
	'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
	'/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var',
	'/private/etc', '/private/var', '/System', '/lib', '/lib32', '/lib64', '/libx32',
].map(normalizeForComparison);

/**
 * SecurityManager enforces an allowlist of real filesystem paths. The
 * allowlist is derived from the configured mounts (realPath + fallback), so a
 * mounted path is reachable and nothing else is. On Windows, comparisons are
 * case-insensitive to match NTFS/SMB semantics.
 */
export class SecurityManager {
	private allowlist: string[] = [];

	/** Replace the entire allowlist (call after settings change). */
	setAllowlist(paths: string[]): void {
		this.allowlist = Array.from(new Set(paths.filter(Boolean).map(p => normalizeForComparison(p))));
	}

	/**
	 * True when realPath equals an allowlisted path or is inside one. The
	 * check is separator-aware ("/foo" must not match "/foobar").
	 */
	isAllowed(realPath: string): boolean {
		if (isUnsupportedWindowsDevicePath(realPath)) return false;
		const normalized = normalizeForComparison(realPath);
		return this.allowlist.some(allowed =>
			normalized === allowed || normalized.startsWith(allowed.endsWith('/') ? allowed : allowed + '/'));
	}

	/** Returns an error message when the path may not be mounted, else null. */
	validateLocalPath(candidatePath: string | undefined, fieldLabel: string): string | null {
		const trimmedPath = candidatePath?.trim();
		if (!trimmedPath) return `${fieldLabel} cannot be empty.`;
		if (isUnsupportedWindowsDevicePath(trimmedPath)) return `${fieldLabel} uses an unsupported Windows device path.`;
		if (!path.posix.isAbsolute(trimmedPath) && !path.win32.isAbsolute(trimmedPath)) {
			return `${fieldLabel} must be a full path, such as ${PATH_EXAMPLES.folder}.`;
		}
		// "C:folder" (drive-relative) and "\folder" (root of the current drive) are
		// "absolute" to path.win32 but depend on the working directory.
		if (IS_WINDOWS && !/^[a-zA-Z]:[\\/]/.test(trimmedPath) && !isUNCPath(trimmedPath) && !trimmedPath.startsWith('\\\\?\\')) {
			return `${fieldLabel} must start with a drive letter (Z:\\…) or a server name (\\\\server\\share\\…).`;
		}
		if (isUNCPath(trimmedPath) && trimmedPath.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean).length < 2) {
			return `${fieldLabel} must include the share name, e.g. \\\\server\\share.`;
		}

		const comparisonPaths = [normalizeForComparison(trimmedPath)];
		if (!IS_WINDOWS && path.posix.isAbsolute(trimmedPath)) comparisonPaths.push(path.posix.normalize(trimmedPath));

		const protectedMessage = `"${trimmedPath}" is a protected system path and cannot be mounted.`;
		for (const dangerousNorm of DANGEROUS_PATHS) {
			if (comparisonPaths.some(norm => norm === dangerousNorm || (dangerousNorm !== '/' && norm.startsWith(dangerousNorm + '/')))) {
				return protectedMessage;
			}
		}
		if (comparisonPaths.some(norm => PROTECTED_PARENTS.has(norm))) return protectedMessage;
		// Windows can be installed on any drive letter. A whole non-C: drive root
		// (D:\) stays mountable on purpose so external/data drives work.
		if (comparisonPaths.some(norm => /^[a-z]:\/(windows|program files( \(x86\))?|programdata)(\/|$)/.test(norm))) {
			return protectedMessage;
		}
		if (comparisonPaths.some(norm => norm.split('/').some(segment => CREDENTIAL_FOLDERS.has(segment)))) {
			return `"${trimmedPath}" is a protected path (it can hold credentials) and cannot be mounted.`;
		}
		return null;
	}

	/**
	 * Validates a candidate mount. `vaultBasePath` is the vault's own folder:
	 * mounting the vault (or a folder containing it) into itself would loop.
	 * Returns an error string on failure, or null on success.
	 */
	validateMount(mount: Omit<MountPoint, 'id'>, existingMounts: MountPoint[], vaultBasePath?: string): string | null {
		const virtualNorm = normalizePath(mount.virtualPath?.trim() ?? '');
		if (!virtualNorm || virtualNorm === '/') return 'Vault folder cannot be empty.';
		if (virtualNorm.split('/').some(s => s === '..' || s === '.')) return 'Vault folder cannot contain "." or ".." segments.';
		if (virtualNorm.startsWith('.')) return 'Vault folder cannot be hidden (start with ".").';

		const realPathError = this.validateLocalPath(mount.realPath, 'Folder path');
		if (realPathError) return realPathError;
		if (mount.fallbackRealPath?.trim()) {
			const fallbackPathError = this.validateLocalPath(mount.fallbackRealPath, 'Fallback path');
			if (fallbackPathError) return fallbackPathError;
		}

		if (vaultBasePath) {
			const vaultNorm = normalizeForComparison(vaultBasePath);
			for (const candidate of [mount.realPath, mount.fallbackRealPath]) {
				if (!candidate?.trim()) continue;
				const norm = normalizeForComparison(candidate.trim());
				if (norm === vaultNorm || norm.startsWith(vaultNorm + '/') || vaultNorm.startsWith(norm.endsWith('/') ? norm : norm + '/')) {
					return `"${candidate.trim()}" is this vault's own folder, inside it, or contains it. Mount a folder outside the vault.`;
				}
			}
		}

		for (const m of existingMounts) {
			const existingVirtualNorm = normalizePath((m.virtualPath || '').trim());
			if (!existingVirtualNorm || existingVirtualNorm === '/') continue;
			if (existingVirtualNorm === virtualNorm) return `Vault folder "${virtualNorm}" is already used by another mount.`;
			if (virtualNorm.startsWith(existingVirtualNorm + '/') || existingVirtualNorm.startsWith(virtualNorm + '/')) {
				return `Vault folder "${virtualNorm}" overlaps with existing mount "${existingVirtualNorm}".`;
			}
		}
		return null;
	}

	/**
	 * Non-blocking advisories for a real path: overlaps with other mounts mean
	 * the same files appear twice in the vault (duplicate Bases rows).
	 */
	getPathWarnings(realPath: string, existingMounts: MountPoint[] = []): string[] {
		const warnings: string[] = [];
		const norm = normalizeForComparison(realPath);
		for (const m of existingMounts) {
			if (!m.realPath) continue;
			const existingRealNorm = normalizeForComparison(m.realPath);
			if (existingRealNorm === norm || norm.startsWith(existingRealNorm + '/') || existingRealNorm.startsWith(norm + '/')) {
				warnings.push(
					`"${realPath}" overlaps with the mount of "${m.realPath}". ` +
					`The same files will appear twice in the vault (and twice in Bases).`
				);
			}
		}
		return warnings;
	}
}
