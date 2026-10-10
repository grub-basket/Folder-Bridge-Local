import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	FastScanHelper, HelperProcess, RawDirEntry, encodeRequest, fileTimeToMs, kindFromAttributes, parseLine, ticksToMs,
} from '../src/fastScan';

describe('fast scan timestamps', () => {
	it('converts FILETIME to the same rounded ms as fs.stat', () => {
		expect(fileTimeToMs('116444736000000000')).toBe(0); // 1970-01-01
		expect(fileTimeToMs('133000000000000000')).toBe(1655526400000);
		// 0.4995 ms rounds down, 0.5 ms rounds up, like Math.round(stat.mtimeMs).
		expect(fileTimeToMs('133000000000004995')).toBe(1655526400000);
		expect(fileTimeToMs('133000000000005000')).toBe(1655526400001);
		// 0.4999 ms: Node's sec * 1e3 + nsec / 1e6 lands on .5 in floating point.
		expect(fileTimeToMs('133000000000004999')).toBe(1655526400001);
		// Before 1970 libuv floors the seconds.
		expect(fileTimeToMs('116444735990000000')).toBe(-1000);
		expect(fileTimeToMs('0')).toBe(-11644473600000);
	});

	it('converts .NET ticks the same way', () => {
		expect(ticksToMs('621355968000000000')).toBe(0);
		expect(ticksToMs('637911232000005000')).toBe(fileTimeToMs('133000000000005000'));
	});

	it('types entries like libuv readdir on Windows', () => {
		expect(kindFromAttributes(0x20)).toBe('file'); // archive
		expect(kindFromAttributes(0x10)).toBe('folder');
		expect(kindFromAttributes(0x2010)).toBe('folder'); // not content indexed
		expect(kindFromAttributes(0x410)).toBe('link'); // junction / directory symlink
		expect(kindFromAttributes(0x420)).toBe('link'); // file symlink, cloud placeholder
		expect(kindFromAttributes(0x40)).toBe('other'); // device
	});
});

describe('fast scan protocol', () => {
	it('encodes a request as one ASCII line with the UTF-16 path in base64', () => {
		const p = '\\\\server\\share\\Caf\u00e9 \u{1F4C8}';
		const line = encodeRequest(7, p);
		expect(line).toMatch(/^7 [A-Za-z0-9+/=]+\n$/);
		expect(Buffer.from(line.split(' ')[1].trim(), 'base64').toString('utf16le')).toBe(p);
	});

	it('ignores lines that are not answers', () => {
		expect(parseLine('')).toBeNull();
		expect(parseLine('{"fbl":1,"ready":true}')).toBeNull();
		expect(parseLine('WARNING: something from PowerShell')).toBeNull();
	});

	it('parses a listing, decoding escaped names exactly', () => {
		const line = '{"fbl":1,"id":3,"ok":true,"e":[["Caf\\u00e9 \\ud83d\\udcc8.md",32,12,"133000000000005000","133000000000000000"],["Sub",16,0,"133000000000000000","133000000000000000"],["Link",1040,0,"1","1"],["odd\\ud800",32,1,"1","1"]]}';
		const parsed = parseLine(line);
		expect(parsed).toEqual({
			id: 3, ok: true, entries: [
				{ name: 'Caf\u00e9 \u{1F4C8}.md', kind: 'file', size: 12, mtime: 1655526400001, ctime: 1655526400000 },
				{ name: 'Sub', kind: 'folder', size: 0, mtime: 1655526400000, ctime: 1655526400000 },
				{ name: 'Link', kind: 'link', size: 0, mtime: fileTimeToMs('1'), ctime: fileTimeToMs('1') },
				{ name: 'odd\ud800', kind: 'file', size: 1, mtime: fileTimeToMs('1'), ctime: fileTimeToMs('1') },
			],
		});
	});

	it('parses an error answer', () => {
		expect(parseLine('{"fbl":1,"id":4,"ok":false,"code":"EACCES","error":"Access denied"}'))
			.toEqual({ id: 4, ok: false, code: 'EACCES', error: 'Access denied' });
	});

	it('throws on anything malformed that claims to be an answer', () => {
		expect(() => parseLine('{"fbl":1,"id":5,"ok":true,"e":[["a",32,1,"x","1"]]}')).toThrow();
		expect(() => parseLine('{"fbl":1,"id":5,"ok":true,"e":[["a",32,1,"1"]]}')).toThrow();
		expect(() => parseLine('{"fbl":1,"id":5,"ok":true,"e":[["",32,1,"1","1"]]}')).toThrow();
		expect(() => parseLine('{"fbl":1,"id":5,"ok":true}')).toThrow();
		expect(() => parseLine('{"fbl":1,"id":"5","ok":true,"e":[]}')).toThrow();
		expect(() => parseLine('{"fbl":1,"id":5,"ok":true,"e":[')).toThrow();
	});
});

/** A stand-in for the PowerShell process: the test plays the helper's side. */
class FakeProcess extends EventEmitter implements HelperProcess {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	requests: { id: number; path: string }[] = [];
	constructor() {
		super();
		this.stdin.setEncoding('ascii');
		this.stdin.on('data', (chunk: string) => {
			for (const line of chunk.split('\n').filter(Boolean)) {
				const [id, b64] = line.split(' ');
				this.requests.push({ id: Number(id), path: Buffer.from(b64, 'base64').toString('utf16le') });
				this.emit('request');
			}
		});
	}
	kill(): boolean { this.killed = true; return true; }
	answer(id: number, entries: unknown[] = []): void {
		this.stdout.write(JSON.stringify({ fbl: 1, id, ok: true, e: entries }) + '\r\n');
	}
	private consumed = 0;
	/** The next request the client sent (waits for it). */
	async nextRequest(): Promise<{ id: number; path: string }> {
		while (this.requests.length <= this.consumed) await new Promise(resolve => this.once('request', resolve));
		return this.requests[this.consumed++];
	}
}

function helperWith(options: { timeoutMs?: number; cooldownMs?: number; now?: () => number } = {}) {
	const procs: FakeProcess[] = [];
	const helper = new FastScanHelper({
		...options,
		spawn: () => { const p = new FakeProcess(); procs.push(p); return p; },
	});
	return { helper, procs };
}

describe('FastScanHelper', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('sends requests one at a time and matches answers by id', async () => {
		const { helper, procs } = helperWith();
		const a = helper.list('C:\\A');
		const b = helper.list('C:\\B');
		const p = procs[0];
		const r1 = await p.nextRequest();
		expect(r1.path).toBe('C:\\A');
		expect(p.requests).toHaveLength(1); // B waits until A is answered
		p.stdout.write('noise from PowerShell\n{"fbl":1,"ready":true}\n');
		// An answer split across chunks.
		const line = JSON.stringify({ fbl: 1, id: r1.id, ok: true, e: [['x.md', 32, 3, '133000000000000000', '133000000000000000']] });
		p.stdout.write(line.slice(0, 20));
		p.stdout.write(line.slice(20) + '\n');
		expect(await a).toEqual([{ name: 'x.md', kind: 'file', size: 3, mtime: 1655526400000, ctime: 1655526400000 }]);
		const r2 = await p.nextRequest();
		expect(r2.path).toBe('C:\\B');
		p.answer(r2.id);
		expect(await b).toEqual([]);
		expect(procs).toHaveLength(1);
		helper.dispose();
		expect(p.killed).toBe(true);
	});

	it('rejects an error answer with its code and keeps the helper', async () => {
		const { helper, procs } = helperWith();
		const a = helper.list('C:\\Denied');
		const r = await procs[0].nextRequest();
		procs[0].stdout.write(JSON.stringify({ fbl: 1, id: r.id, ok: false, code: 'EACCES', error: 'Access denied' }) + '\n');
		await expect(a).rejects.toMatchObject({ code: 'EACCES' });
		const b = helper.list('C:\\Ok');
		const r2 = await procs[0].nextRequest();
		procs[0].answer(r2.id);
		await expect(b).resolves.toEqual([]);
		expect(procs[0].killed).toBe(false);
		helper.dispose();
	});

	it('kills the helper and fails everything waiting on a mismatched id, then cools down', async () => {
		let now = 1000;
		const { helper, procs } = helperWith({ cooldownMs: 30000, now: () => now });
		const a = helper.list('C:\\A');
		const b = helper.list('C:\\B');
		const r = await procs[0].nextRequest();
		procs[0].answer(r.id + 1);
		await expect(a).rejects.toThrow(/does not match/);
		await expect(b).rejects.toThrow(/does not match/);
		expect(procs[0].killed).toBe(true);
		await expect(helper.list('C:\\C')).rejects.toThrow(/cooling down/);
		now += 30001;
		const c = helper.list('C:\\C');
		expect(procs).toHaveLength(2); // a fresh helper
		const r3 = await procs[1].nextRequest();
		procs[1].answer(r3.id);
		await expect(c).resolves.toEqual([]);
		helper.dispose();
	});

	it('fails on garbled output', async () => {
		const { helper, procs } = helperWith();
		const a = helper.list('C:\\A');
		await procs[0].nextRequest();
		procs[0].stdout.write('{"fbl":1,"id":1,"ok":tru\n');
		await expect(a).rejects.toThrow();
		expect(procs[0].killed).toBe(true);
		helper.dispose();
	});

	it('times out a folder that gets no answer', async () => {
		vi.useFakeTimers();
		const { helper, procs } = helperWith({ timeoutMs: 10000 });
		const a = helper.list('\\\\server\\share\\Slow');
		const failed = expect(a).rejects.toThrow(/no answer within 10000 ms/);
		await vi.advanceTimersByTimeAsync(10001);
		await failed;
		expect(procs[0].killed).toBe(true);
		helper.dispose();
	});

	it('fails waiting requests when the helper exits', async () => {
		const { helper, procs } = helperWith();
		const a = helper.list('C:\\A');
		await procs[0].nextRequest();
		procs[0].emit('exit', 1);
		await expect(a).rejects.toThrow(/exited/);
		helper.dispose();
	});

	it('refuses work after dispose', async () => {
		const { helper, procs } = helperWith();
		const a = helper.list('C:\\A');
		helper.dispose();
		await expect(a).rejects.toThrow(/stopped/);
		await expect(helper.list('C:\\B')).rejects.toThrow(/stopped/);
		expect(procs[0].killed).toBe(true);
	});
});

// The real PowerShell helper against the real file system. Windows only.
describe.runIf(process.platform === 'win32')('FastScanHelper on Windows', () => {
	it('returns the same names, types, sizes and timestamps as readdir + stat', { timeout: 60000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fbl-fast-'));
		const helper = new FastScanHelper({ timeoutMs: 30000 });
		try {
			const names = ['plain.md', 'Caf\u00e9.md', 'Emoji \u{1F4C8}.md', 'Notes #1 [x] ^y.md', 'no-extension', '.dot.md', 'tool.exe'];
			for (const [i, n] of names.entries()) {
				await fs.writeFile(path.join(dir, n), 'x'.repeat(i));
				// Sub-millisecond parts, including the rounding boundaries.
				const t = 1700000000 + i + [0.0004995, 0.0005, 0.0004999, 0.1234567, 0.9999999, 0, 0.5][i];
				await fs.utimes(path.join(dir, n), t, t);
			}
			await fs.mkdir(path.join(dir, 'Sub'));
			execFileSync('cmd', ['/c', 'mklink', '/J', path.join(dir, 'Junction'), path.join(dir, 'Sub')]);

			const entries = await helper.list(dir);
			const byName = new Map<string, RawDirEntry>(entries.map(e => [e.name, e]));
			const dirents = await fs.readdir(dir, { withFileTypes: true });
			expect(entries).toHaveLength(dirents.length);
			for (const d of dirents) {
				const e = byName.get(d.name);
				expect(e, d.name).toBeDefined();
				expect(e!.kind).toBe(d.isSymbolicLink() ? 'link' : d.isDirectory() ? 'folder' : 'file');
				if (!d.isFile()) continue;
				const s = await fs.stat(path.join(dir, d.name));
				expect([e!.mtime, e!.ctime, e!.size], d.name).toEqual([Math.round(s.mtimeMs), Math.round(s.birthtimeMs || s.ctimeMs), s.size]);
			}
			await expect(helper.list(path.join(dir, 'Missing'))).rejects.toMatchObject({ code: 'ENOENT' });
			// Still usable after an error.
			await expect(helper.list(path.join(dir, 'Sub'))).resolves.toEqual([]);
		} finally {
			helper.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
