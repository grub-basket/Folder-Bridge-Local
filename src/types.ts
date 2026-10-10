/**
 * A single virtual mount point: maps a vault-relative virtual path
 * to an absolute real filesystem path (a local folder, a mapped drive
 * such as `Z:\Finance`, or a UNC share such as `\\server\share\Finance`).
 */
export type MountVisibleFileFilter = 'all' | 'markdown-only' | 'pdf-only';
export type MountWatchMode = 'native' | 'poll' | 'off';
/** A note changed on disk since Obsidian last saw it, and Obsidian is saving: */
export type ConflictMode = 'merge' | 'copy' | 'overwrite';

export interface MountPoint {
	id: string;            // Unique identifier (generated at creation)
	virtualPath: string;   // Normalized vault path, e.g. "Finance/Reports"
	realPath: string;      // Absolute OS path, e.g. "Z:\\Finance\\Reports" or "\\\\server\\share\\Reports"
	/**
	 * Alternative path tried automatically when realPath is not accessible.
	 * Typical use: the UNC form of a mapped drive (`\\server\share\…` for
	 * `Z:\…`), so the mount still works on a PC where the drive letter differs.
	 */
	fallbackRealPath?: string;
	enabled: boolean;      // Whether the mount is currently active
	readOnly: boolean;     // Block all write operations through this mount
	label?: string;        // Optional human-readable display name
	ignoreList?: string[]; // File/folder names, globs, or mount-relative paths to hide
	/** Limits which file types are exposed to Obsidian for this mount. */
	visibleFileFilter?: MountVisibleFileFilter;
	/**
	 * How external changes are picked up.
	 * - `native` (default): one recursive OS change-notification handle
	 *   (ReadDirectoryChangesW on Windows, including SMB shares that support it).
	 * - `poll`: rescan the mount every `watcherPollingIntervalMs`. Use when a
	 *   share never reports changes.
	 * - `off`: never watch; only edits made inside Obsidian and manual
	 *   "Refresh" pick up changes.
	 */
	watchMode?: MountWatchMode;
	watcherDebounceMs?: number;        // Coalescing window for change events (default 300 ms)
	watcherPollingIntervalMs?: number; // Rescan interval for poll mode (default 60 000 ms)
	maxFiles?: number;                 // Cap initial scan at this many items (0 = unlimited)
}

export interface FolderBridgeSettings {
	mountPoints: MountPoint[];
	/**
	 * Deleting a mount's root folder in Obsidian only ever unmounts it (no
	 * files touched). 'ask' confirms first; 'unmount' does it silently.
	 * Deleting a whole share folder is left to File Explorer on purpose.
	 */
	mountRootDeletionBehavior: 'ask' | 'unmount';
	showStatusBar: boolean;
	/** merge = combine both versions (copy when the same lines changed); copy = keep theirs as a copy; overwrite = last save wins. */
	conflictMode: ConflictMode;
	/**
	 * Patterns applied to EVERY mount, exactly like per-mount ignoreList entries.
	 * Defaults cover Windows/Office noise files.
	 */
	globalIgnorePatterns: string[];
	/** "Suggest mounts from Bases": where it last looked, and the share folder it used. */
	lastBaseScanSource?: 'vault' | 'disk';
	lastBaseScanRoot?: string;
	/** Windows only: list folders with sizes and dates through a read-only PowerShell helper (see fastScan.ts). Off by default. */
	fastScanWindows?: boolean;
}

export const DEFAULT_SETTINGS: FolderBridgeSettings = {
	mountPoints: [],
	mountRootDeletionBehavior: 'ask',
	showStatusBar: true,
	conflictMode: 'merge',
	// Names starting with "." (.git, .DS_Store, …) are always hidden.
	globalIgnorePatterns: ['Thumbs.db', 'desktop.ini', '~$*', '$RECYCLE.BIN', 'System Volume Information'],
	fastScanWindows: false,
};

/** The stat shape Obsidian's DataAdapter returns. */
export interface VaultStat {
	type: 'file' | 'folder';
	ctime: number;
	mtime: number;
	size: number;
}
