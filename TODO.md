# Open items

## Measure fast scan on a real network share

All fast-scan numbers so far come from an SMB share on the same PC (`\\localhost\…`), which has almost no network latency. The plain method pays one network round trip per file, the fast scan one per folder, so the real gain should be bigger on a work share. Not measured yet.

How: on a Windows PC with a real network drive, mount a big folder (thousands of files). In the developer console (verbose level), each scan logs `Synced "<mount>" in N ms {…} {lists, fastLists, stats}`.

1. Settings → Folder Bridge Local → "Fast scan on Windows (uses PowerShell)" off. Run "Rescan" on the mount a few times and note N.
2. Turn it on and rescan the same way. `fastLists` should be > 0 and `stats` 0.
3. Both rescans must report `added: 0, modified: 0, removed: 0`. If they don't, the helper's dates differ from `fs.stat` on that server: note the server type (Windows, Samba, NAS).

## Fast scan when a server stops answering mid-scan

Tested: a share removed or a drive letter disconnected. Both fail at once, and the scan falls back and marks the mount offline. Not tested for real: a server that stops answering in the middle of a scan (VPN drop, Wi-Fi gone, server hangs). Then the helper gets no answer, and after 10 seconds per folder it should be killed and the scan should fall back to the normal method. Unit tests cover the timeout, but the real case hasn't been run.

How: start a rescan of a big mount over VPN or Wi-Fi, then drop the connection mid-scan. Expect:
- Obsidian stays responsive.
- The mount goes offline within about 30 s.
- No files disappear from the vault.
- No `powershell.exe` is left running after turning the setting off (Task Manager).
