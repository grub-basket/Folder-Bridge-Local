import { spawn as nodeSpawn } from 'child_process';
import { logger } from './logger';

/**
 * Fast scan on Windows: one long-lived, read-only PowerShell process lists
 * folders WITH size and timestamps.
 *
 * Node's readdir returns names and types only, so the tree sync needs one
 * fs.stat per file, and libuv runs four of those at a time: 20 000 files at
 * ~10 ms per network round trip is about a minute per scan. A Windows
 * directory query (FindFirstFileEx / NtQueryDirectoryFile, also over SMB)
 * already returns size and timestamps for every entry, so one query per
 * folder replaces all of those stats.
 *
 * The helper never writes: it only enumerates [System.IO.DirectoryInfo].
 * Filtering (ignore rules, dot-names, executables, name checks, links) stays
 * in Node, in VirtualAdapter, so both paths apply exactly the same rules.
 */

/** One raw directory entry, typed the way libuv types fs.readdir results on Windows. */
export interface RawDirEntry {
	name: string;
	kind: 'file' | 'folder' | 'link' | 'other';
	size: number;
	/** Math.round(mtimeMs), exactly as fs.stat would give it. */
	mtime: number;
	/** Math.round(birthtimeMs), exactly as fs.stat would give it. */
	ctime: number;
}

export interface FolderLister {
	/** List a real folder. Throws on ANY problem; the caller then falls back to fs. */
	list(realDirPath: string): Promise<RawDirEntry[]>;
}

// --- Timestamps ---------------------------------------------------------

/** 1970-01-01 as a Windows FILETIME (100-ns intervals since 1601-01-01). */
const UNIX_EPOCH_AS_FILETIME = BigInt('116444736000000000');
const FILETIME_PER_SECOND = BigInt(10000000);
const NS_PER_SECOND = BigInt(1000000000);

/**
 * FILETIME (as a decimal string: it exceeds 2^53) → milliseconds, computed
 * exactly like fs.stat: libuv splits the FILETIME into seconds and
 * nanoseconds (floored), then Node computes sec * 1e3 + nsec / 1e6.
 * Rounding the float the same way matters: off by 1 ms and every file looks
 * modified, so Obsidian re-reads every note.
 */
export function fileTimeToMs(fileTime: string): number {
	const t = BigInt(fileTime) - UNIX_EPOCH_AS_FILETIME;
	let sec = t / FILETIME_PER_SECOND; // BigInt division truncates toward zero
	let nsec = (t - sec * FILETIME_PER_SECOND) * BigInt(100);
	if (nsec < BigInt(0)) { // before 1970: libuv floors instead
		sec -= BigInt(1);
		nsec += NS_PER_SECOND;
	}
	return Math.round(Number(sec) * 1000 + Number(nsec) / 1e6);
}

/** .NET DateTime ticks (100 ns since 0001-01-01) → ms, same rounding as fs.stat. */
export function ticksToMs(ticks: string): number {
	return fileTimeToMs((BigInt(ticks) - BigInt('504911232000000000')).toString());
}

// --- Protocol -----------------------------------------------------------
//
// Request  (Node → helper), one line:  <id> <base64 of the UTF-16LE path>
// Response (helper → Node), one line:  {"fbl":1,"id":<id>,"ok":true,"e":[[name,attributes,size,mtimeFT,ctimeFT],…]}
//                                  or  {"fbl":1,"id":<id>,"ok":false,"code":"EACCES","error":"…"}
// The helper escapes every non-ASCII character as \uXXXX, so its output is
// plain ASCII whatever the console code page, and names round-trip exactly.

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_DEVICE = 0x40;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

/** Same order of checks as libuv's scandir on Windows, so the helper and fs.readdir agree. */
export function kindFromAttributes(attributes: number): RawDirEntry['kind'] {
	if (attributes & FILE_ATTRIBUTE_DEVICE) return 'other';
	if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return 'link';
	if (attributes & FILE_ATTRIBUTE_DIRECTORY) return 'folder';
	return 'file';
}

export function encodeRequest(id: number, realDirPath: string): string {
	return `${id} ${Buffer.from(realDirPath, 'utf16le').toString('base64')}\n`;
}

export type ParsedLine =
	| { id: number; ok: true; entries: RawDirEntry[] }
	| { id: number; ok: false; code: string; error: string };

/**
 * Parse one output line. null: not a protocol line (PowerShell noise, the
 * ready marker). Throws on a protocol line that is malformed in any way: the
 * caller then stops trusting the helper.
 */
export function parseLine(line: string): ParsedLine | null {
	if (!line.startsWith('{"fbl":1,"id":')) return null;
	const msg = JSON.parse(line) as { id?: unknown; ok?: unknown; e?: unknown; code?: unknown; error?: unknown };
	if (typeof msg.id !== 'number' || !Number.isInteger(msg.id)) throw new Error('Fast scan: response without id');
	if (msg.ok === false) {
		return {
			id: msg.id, ok: false,
			code: typeof msg.code === 'string' ? msg.code : 'EIO',
			error: typeof msg.error === 'string' ? msg.error : 'unknown error',
		};
	}
	if (msg.ok !== true || !Array.isArray(msg.e)) throw new Error('Fast scan: malformed response');
	const entries = msg.e.map((row: unknown): RawDirEntry => {
		if (!Array.isArray(row) || row.length !== 5) throw new Error('Fast scan: malformed entry');
		const [name, attributes, size, mtime, ctime] = row as unknown[];
		if (typeof name !== 'string' || name === '' || typeof attributes !== 'number' || typeof size !== 'number'
			|| typeof mtime !== 'string' || typeof ctime !== 'string' || !/^\d+$/.test(mtime) || !/^\d+$/.test(ctime)) {
			throw new Error('Fast scan: malformed entry');
		}
		return { name, kind: kindFromAttributes(attributes), size, mtime: fileTimeToMs(mtime), ctime: fileTimeToMs(ctime) };
	});
	return { id: msg.id, ok: true, entries };
}

/**
 * The helper script. Windows PowerShell 5.1 / .NET Framework compatible.
 * Read-only: it enumerates folders and prints; it never creates, opens for
 * writing, or changes anything. Reparse points (junctions, symlinks, cloud
 * placeholders) are reported, never followed. Exits when stdin closes.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ascii = New-Object Text.ASCIIEncoding
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $ascii)
$writer = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $ascii)
$special = New-Object Text.RegularExpressions.Regex '[^\x20\x21\x23-\x5B\x5D-\x7E]'
$escape = [Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int]$m.Value[0] }
function J([string]$s) { '"' + $special.Replace($s, $escape) + '"' }
$writer.WriteLine('{"fbl":1,"ready":true}'); $writer.Flush()
while ($null -ne ($line = $reader.ReadLine())) {
	$parts = $line.Split(' ')
	if ($parts.Count -ne 2 -or $parts[0] -notmatch '^\d+$') { continue }
	$id = $parts[0]
	try {
		$dir = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($parts[1]))
		$sb = New-Object Text.StringBuilder
		[void]$sb.Append('{"fbl":1,"id":').Append($id).Append(',"ok":true,"e":[')
		$first = $true
		foreach ($e in (New-Object IO.DirectoryInfo($dir)).EnumerateFileSystemInfos()) {
			if (-not $first) { [void]$sb.Append(',') }
			$first = $false
			$size = 0
			if ($e -is [IO.FileInfo]) { $size = $e.Length }
			[void]$sb.Append('[').Append((J $e.Name)).Append(',').Append([int]$e.Attributes).Append(',').Append($size)
			[void]$sb.Append(',"').Append($e.LastWriteTimeUtc.ToFileTimeUtc()).Append('","').Append($e.CreationTimeUtc.ToFileTimeUtc()).Append('"]')
		}
		[void]$sb.Append(']}')
		$writer.WriteLine($sb.ToString())
	} catch {
		$ex = $_.Exception
		while ($ex.InnerException) { $ex = $ex.InnerException }
		$code = 'EIO'
		if ($ex -is [UnauthorizedAccessException] -or $ex -is [Security.SecurityException]) { $code = 'EACCES' }
		elseif ($ex -is [IO.DirectoryNotFoundException] -or $ex -is [IO.FileNotFoundException]) { $code = 'ENOENT' }
		$writer.WriteLine('{"fbl":1,"id":' + $id + ',"ok":false,"code":"' + $code + '","error":' + (J $ex.Message) + '}')
	}
	$writer.Flush()
}
`;

// --- Client -------------------------------------------------------------

interface Pending {
	id: number;
	realDirPath: string;
	resolve(entries: RawDirEntry[]): void;
	reject(error: Error): void;
}

/** The parts of a ChildProcess the client uses (a fake one in tests). */
export interface HelperProcess {
	stdin: NodeJS.WritableStream | null;
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	kill(): boolean;
	on(event: 'exit', listener: (code: number | null) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface FastScanOptions {
	/** Per folder, including helper start-up. */
	timeoutMs?: number;
	/** After the helper failed (timeout, crash, garbage), use fs for this long before trying again. */
	cooldownMs?: number;
	spawn?: () => HelperProcess;
	now?: () => number;
}

function spawnPowerShell(): HelperProcess {
	// -EncodedCommand, not "-Command -": with "-Command -" PowerShell reads
	// stdin itself and would run request lines that arrive early as commands.
	// Here stdin is only ever read by the script, as data.
	const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
	return nodeSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

/**
 * Talks to one helper process. Requests run one at a time (the helper is
 * sequential anyway), so the timeout is per folder. On any failure the
 * helper is killed, every waiting request is rejected (callers fall back to
 * fs), and a new helper is started on demand after a cool-down.
 */
export class FastScanHelper implements FolderLister {
	private proc: HelperProcess | null = null;
	private stdoutBuffer = '';
	private nextId = 1;
	private queue: Pending[] = [];
	private current: Pending | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private failedAt = -Infinity;
	private disposed = false;
	private readonly timeoutMs: number;
	private readonly cooldownMs: number;
	private readonly spawnHelper: () => HelperProcess;
	private readonly now: () => number;

	constructor(options: FastScanOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 10000;
		this.cooldownMs = options.cooldownMs ?? 30000;
		this.spawnHelper = options.spawn ?? spawnPowerShell;
		this.now = options.now ?? Date.now;
	}

	list(realDirPath: string): Promise<RawDirEntry[]> {
		if (this.disposed) return Promise.reject(new Error('Fast scan: stopped'));
		if (this.now() - this.failedAt < this.cooldownMs) return Promise.reject(new Error('Fast scan: cooling down after a failure'));
		return new Promise<RawDirEntry[]>((resolve, reject) => {
			this.queue.push({ id: this.nextId++, realDirPath, resolve, reject });
			this.pump();
		});
	}

	/** Kill the helper and fail everything waiting. Call on unload and when the setting is turned off. */
	dispose(): void {
		this.disposed = true;
		this.stop(new Error('Fast scan: stopped'));
	}

	private pump(): void {
		if (this.current || this.queue.length === 0) return;
		try {
			this.ensureProcess();
		} catch (e) {
			this.fail(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		const next = this.queue.shift()!;
		this.current = next;
		this.timer = setTimeout(() => this.fail(new Error(`Fast scan: no answer within ${this.timeoutMs} ms for "${next.realDirPath}"`)), this.timeoutMs);
		this.proc!.stdin!.write(encodeRequest(next.id, next.realDirPath));
	}

	private ensureProcess(): void {
		if (this.proc) return;
		const proc = this.spawnHelper();
		if (!proc.stdin || !proc.stdout) throw new Error('Fast scan: helper has no pipes');
		this.proc = proc;
		this.stdoutBuffer = '';
		proc.stdout.setEncoding('ascii');
		proc.stdout.on('data', (chunk: string) => { if (this.proc === proc) this.onData(chunk); });
		let stderrTail = '';
		proc.stderr?.on('data', (chunk: Buffer | string) => { stderrTail = (stderrTail + String(chunk)).slice(-500); });
		proc.stdin.on('error', (e: Error) => { if (this.proc === proc) this.fail(e); });
		proc.on('error', e => { if (this.proc === proc) this.fail(e); });
		proc.on('exit', code => {
			if (this.proc === proc) this.fail(new Error(`Fast scan: helper exited (code ${code}) ${stderrTail.trim()}`));
		});
	}

	private onData(chunk: string): void {
		this.stdoutBuffer += chunk;
		let nl: number;
		while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
			const line = this.stdoutBuffer.slice(0, nl).replace(/\r$/, '');
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			let parsed: ParsedLine | null;
			try {
				parsed = parseLine(line);
			} catch (e) {
				this.fail(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			if (!parsed) continue;
			const cur = this.current;
			if (!cur || parsed.id !== cur.id) {
				this.fail(new Error(`Fast scan: answer ${parsed.id} does not match request ${cur?.id ?? '(none)'}`));
				return;
			}
			this.clearTimer();
			this.current = null;
			if (parsed.ok) cur.resolve(parsed.entries);
			else {
				const err: NodeJS.ErrnoException = new Error(`Fast scan: ${parsed.error}`);
				err.code = parsed.code;
				cur.reject(err);
			}
			this.pump();
		}
	}

	/** The helper can no longer be trusted: kill it, fail all requests, cool down. */
	private fail(error: Error): void {
		logger.debug('Fast scan helper failed; using fs for now:', error.message);
		this.failedAt = this.now();
		this.stop(error);
	}

	private stop(error: Error): void {
		this.clearTimer();
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			try { proc.stdin?.end(); } catch { /* already closed */ }
			try { proc.kill(); } catch { /* already gone */ }
		}
		const waiting = this.current ? [this.current, ...this.queue] : this.queue;
		this.current = null;
		this.queue = [];
		for (const p of waiting) p.reject(error);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}
