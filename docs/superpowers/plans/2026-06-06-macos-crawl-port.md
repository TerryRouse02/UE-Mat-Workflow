# macOS Crawl Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Config-tab crawls run on macOS (against the local source-built UE 5.7 + G1_Project) without changing the validated Windows behavior.

**Architecture:** One `.ps1` runner set serves both OSes — `crawl-runner.ts` invokes them via `powershell` on Windows and `pwsh` (PowerShell Core 7) on macOS; the scripts pick the UE binary path by platform. `crawl-env.ts` stops hard-gating non-Windows and probes the Mac editor/`.dylib`. The Mac plugin binary is built locally with `RunUAT.sh` and gitignored. Single source of truth for crawl commands stays in `defaultCommandFor` (invariant #5); `.ps1` stay pure ASCII (#4); only gitignored files carry G1_Project data (#1/#2/#3).

**Tech Stack:** TypeScript (Node http+ws server, Vitest), PowerShell 5.1 + pwsh 7 runners, UE 5.7 editor commandlet (C++) built via RunUAT.

**Build/test commands (this repo, macOS — `node` is not on the non-interactive PATH):**
- Server typecheck: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/tsc -p viewer/tsconfig.json`
- Server build (emits `viewer/dist/server/*.js`): same command (tsconfig emits).
- Tests: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/vitest run --root viewer`
- pwsh: `/usr/local/bin/pwsh` (7.6.2, installed in W1).

**Verified environment:** Mac arm64, Xcode 26.5. Engine `/Users/rouseterry/G1Project/SDGF_G1_Project/UE_5.7`. Project `/Users/rouseterry/G1Project/SDGF_G1_Project/G1_Project/G1_Project.uproject`. `pwsh -v` → 7.6.2, `$IsMacOS` → True.

---

### Task 1: `crawl-runner.ts` — run `.ps1` under `pwsh` on macOS

**Files:**
- Modify: `viewer/server/crawl-runner.ts:41` (CommandFor type), `:50-55` (defaultCommandFor head)
- Test: `viewer/tests/crawl-runner.test.ts:74-80` (update) + new darwin test

**Why a test changes:** `defaultCommandFor` currently always returns `command:'powershell'`. After this task it branches on `process.platform`, and the test host here IS `darwin` — so the existing assertion `cmd('export').command).toBe('powershell')` would start returning `'pwsh'`. The test must pin the platform.

- [ ] **Step 1: Update the existing mapping test to pin Windows, add a macOS test**

In `viewer/tests/crawl-runner.test.ts`, replace the `it('maps each crawl kind to its PowerShell entrypoint', ...)` block (lines 74-80) with:

```ts
  it('maps each crawl kind to its PowerShell entrypoint (Windows)', () => {
    const cmd = (k: 'export' | 'enginemf' | 'workmf') => defaultCommandFor('/repo', k, undefined, 'win32');
    expect(cmd('export').command).toBe('powershell');
    expect(cmd('export').args.join(' ')).toMatch(/Invoke-NodeT3DMetadataMaintenance\.ps1.*-SkipViewerTests/);
    expect(cmd('enginemf').args.join(' ')).toMatch(/Run-EngineMfIndex\.ps1/);
    expect(cmd('workmf').args.join(' ')).toMatch(/Run-WorkMfIndex\.ps1/);
  });

  it('runs the same .ps1 entrypoints under pwsh on macOS (no -ExecutionPolicy)', () => {
    const cmd = defaultCommandFor('/repo', 'workmf', undefined, 'darwin');
    expect(cmd.command).toBe('pwsh');
    expect(cmd.args).toEqual(expect.arrayContaining(['-NoProfile', '-File']));
    expect(cmd.args).not.toContain('-ExecutionPolicy');
    expect(cmd.args.join(' ')).toMatch(/Run-WorkMfIndex\.ps1/);
    // contentRoots still threads through on darwin
    expect(defaultCommandFor('/repo', 'workmf', { contentRoots: '/Game/M' }, 'darwin').args).toContain('-ContentRoots');
  });
```

- [ ] **Step 2: Run tests to verify the new macOS test fails**

Run: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/vitest run --root viewer crawl-runner`
Expected: FAIL — `defaultCommandFor` ignores the 4th arg, so on the darwin host `cmd.command` is `'powershell'`, not `'pwsh'` (and the Windows-pinned test also fails for the same reason: it returns the host default).

- [ ] **Step 3: Add the `platform` parameter and the pwsh branch**

In `viewer/server/crawl-runner.ts`, change the `CommandFor` type (line 41) from:

```ts
export type CommandFor = (repoRoot: string, kind: CrawlKind, opts?: CrawlStartOpts) => SpawnSpec;
```
to:
```ts
export type CommandFor = (repoRoot: string, kind: CrawlKind, opts?: CrawlStartOpts, platform?: NodeJS.Platform) => SpawnSpec;
```

Then change the head of `defaultCommandFor` (lines 50-55) from:

```ts
export const defaultCommandFor: CommandFor = (repoRoot, kind, opts) => {
  const tool = resolve(repoRoot, 'tools', 'node-t3d-metadata');
  const ps = (file: string, extra: string[]): SpawnSpec => ({
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(tool, file), ...extra],
  });
```
to:
```ts
export const defaultCommandFor: CommandFor = (repoRoot, kind, opts, platform = process.platform) => {
  const tool = resolve(repoRoot, 'tools', 'node-t3d-metadata');
  // macOS runs the same .ps1 runners under PowerShell Core (pwsh). pwsh on macOS
  // has no -ExecutionPolicy switch, so it is omitted there; Windows keeps it.
  const ps = (file: string, extra: string[]): SpawnSpec => platform === 'darwin'
    ? { command: 'pwsh', args: ['-NoProfile', '-File', resolve(tool, file), ...extra] }
    : { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(tool, file), ...extra] };
```

(The `switch (kind)` body below is unchanged — it calls `ps(...)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/vitest run --root viewer crawl-runner`
Expected: PASS (all crawl-runner tests, including both new assertions).

- [ ] **Step 5: Commit**

```bash
git add viewer/server/crawl-runner.ts viewer/tests/crawl-runner.test.ts
git commit -m "feat(crawl): run .ps1 runners under pwsh on macOS"
```

---

### Task 2: `crawl-env.ts` — probe the macOS editor + plugin, drop the Windows-only gate

**Files:**
- Modify: `viewer/server/crawl-env.ts:23` (add `onMac`), `:45-46` (editor path), `:56` (dll path), `:65` (platformOk), `:68/:70/:72` (details)
- Test: `viewer/tests/crawl-env.test.ts` — extend `readyRepo()`, replace the darwin test, add a Mac-missing test

- [ ] **Step 1: Update the env tests for macOS support**

In `viewer/tests/crawl-env.test.ts`, add two Mac `touch` lines to `readyRepo()` (after the existing Win64 touches, around line 18) so the fixture is "ready" on both platforms:

```ts
  touch(resolve(engine, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
  touch(resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Mac', 'UnrealEditor-UEMatExportMetadata.dylib'));
```

Then replace the existing test `it('ready=false on a non-Windows host, with only the platform check failing', ...)` (lines 34-43) with:

```ts
  it('ready=true on darwin when the Mac engine binary + Mac plugin are present', async () => {
    const { root } = readyRepo();
    const env = await probeEnv(root, { platform: 'darwin' });
    expect(env.ready).toBe(true);
    expect(env.checks.platform.ok).toBe(true);
    expect(env.checks.platform.detail).toBe('macOS');
  });

  it('flags a darwin host whose Mac UnrealEditor-Cmd is absent (Win64-only engine)', async () => {
    const { root, tool, project } = readyRepo();
    const winOnly = resolve(root, 'winOnly');
    touch(resolve(winOnly, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'));
    writeFileSync(resolve(tool, 'local.config.json'), JSON.stringify({ ProjectPath: project, EngineRoot: winOnly }));
    const env = await probeEnv(root, { platform: 'darwin' });
    expect(env.checks.engine.ok).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/vitest run --root viewer crawl-env`
Expected: FAIL — current `probeEnv` sets `platformOk = platform === 'win32'`, so on darwin `platform.ok` is `false` and `ready` is `false`; the new `ready=true` assertion fails.

- [ ] **Step 3: Implement the platform branch in `crawl-env.ts`**

Add `onMac` + an editor name right after the `platform` line (line 23):

```ts
  const platform = opts.platform ?? process.platform;
  const onMac = platform === 'darwin';
  const editorName = onMac ? 'UnrealEditor-Cmd' : 'UnrealEditor-Cmd.exe';
```

Replace the editor path (line 45):

```ts
  const editorCmd = engineRoot
    ? (onMac
        ? resolve(engineRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd')
        : resolve(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'))
    : null;
```

Replace the dll path (line 56):

```ts
  const dll = onMac
    ? resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Mac', 'UnrealEditor-UEMatExportMetadata.dylib')
    : resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Win64', 'UnrealEditor-UEMatExportMetadata.dll');
```

Replace `platformOk` (line 65):

```ts
  const platformOk = platform === 'win32' || platform === 'darwin';
```

Replace the three detail strings in the `checks` object (lines 68, 70, 72):

```ts
    platform: { ok: platformOk, detail: platformOk ? (onMac ? 'macOS' : 'Windows') : `the crawl runs ${editorName} — needs Windows or macOS (host is ${platform})` },
```
```ts
    engine: { ok: engineOk, detail: engineOk ? `${editorName} found` : `${editorName} not found${engineRoot ? ` under ${engineRoot}` : ' (EngineRoot unset)'}` },
```
```ts
    plugin: { ok: dllOk, detail: dllOk ? 'compiled plugin present' : `compiled plugin missing — build it once (${onMac ? 'Mac .dylib' : 'Windows .dll'})` },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/vitest run --root viewer crawl-env`
Expected: PASS (win32 ready test still passes — fixture now has both binaries; both new darwin tests pass).

- [ ] **Step 5: Commit**

```bash
git add viewer/server/crawl-env.ts viewer/tests/crawl-env.test.ts
git commit -m "feat(crawl): probe macOS editor + plugin, allow darwin host"
```

---

### Task 3: Cross-platform the crawl `.ps1` entrypoints + the plugin packager

**Files (modify):**
- `tools/node-t3d-metadata/plugin-src/Scripts/Run-WorkMfIndex.ps1:75`
- `tools/node-t3d-metadata/plugin-src/Scripts/Run-ProjectMaterials.ps1:83,92`
- `tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1:97,106`
- `tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1:120,121,125`
- `tools/node-t3d-metadata/plugin-src/Scripts/Package-Plugin.ps1:37,60`

**Idiom (PS 5.1 + pwsh 7 safe):** `$IsMacOS` is undefined on Windows PowerShell 5.1 (which only runs on Windows), so `($IsMacOS -eq $true)` is `$false` there and `$true` only on pwsh-macOS. Keep all edits **pure ASCII**.

- [ ] **Step 1: `Run-WorkMfIndex.ps1` — branch `$EditorCmd` (line 75)**

Replace:
```powershell
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
```
with:
```powershell
if ($IsMacOS -eq $true) {
    $EditorCmd = Join-Path $EngineRoot "Engine/Binaries/Mac/UnrealEditor-Cmd"
} else {
    $EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
}
```

- [ ] **Step 2: `Run-ProjectMaterials.ps1` — branch `$EditorCmd` (line 83) and `$PackagedDll` (line 92)**

Replace line 83 `$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"` with the same `if ($IsMacOS -eq $true) { ... Mac/UnrealEditor-Cmd ... } else { ... Win64\UnrealEditor-Cmd.exe ... }` block from Step 1.

Replace line 92:
```powershell
$PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
```
with:
```powershell
if ($IsMacOS -eq $true) {
    $PackagedDll = Join-Path $PackageDir "Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib"
} else {
    $PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
}
```

- [ ] **Step 3: `Run-EngineMfIndex.ps1` — branch `$EditorCmd` (line 97) and `$PackagedDll` (line 106)**

Apply the exact same two replacements as Step 2 (the `$EditorCmd` block and the `$PackagedDll` block) at lines 97 and 106.

- [ ] **Step 4: `Invoke-NodeT3DMetadataMaintenance.ps1` — branch `$RunUAT` (120), `$EditorCmd` (121), `$PackagedDll` (125)**

Replace line 120:
```powershell
$RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"
```
with:
```powershell
if ($IsMacOS -eq $true) {
    $RunUAT = Join-Path $EngineRoot "Engine/Build/BatchFiles/RunUAT.sh"
} else {
    $RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"
}
```
Replace line 121 `$EditorCmd = ...` with the `$EditorCmd` block from Step 1, and line 125 `$PackagedDll = ...` with the `$PackagedDll` block from Step 2.

- [ ] **Step 5: `Package-Plugin.ps1` — branch `$RunUAT` (37) and `-TargetPlatforms` (60)**

Replace line 37 `$RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"` with the `$RunUAT` block from Step 4.

Replace line 60:
```powershell
& $RunUAT BuildPlugin "-Plugin=$PluginFile" "-Package=$PackageDir" -TargetPlatforms=Win64 2>&1 |
    Tee-Object -FilePath $PackageLog
```
with:
```powershell
$TargetPlatform = if ($IsMacOS -eq $true) { "Mac" } else { "Win64" }
& $RunUAT BuildPlugin "-Plugin=$PluginFile" "-Package=$PackageDir" "-TargetPlatforms=$TargetPlatform" 2>&1 |
    Tee-Object -FilePath $PackageLog
```

- [ ] **Step 6: Verify all five scripts parse under pwsh and stay pure ASCII**

Run:
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
for f in \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-WorkMfIndex.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-ProjectMaterials.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1 \
  tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Package-Plugin.ps1 ; do
  /usr/local/bin/pwsh -NoProfile -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$f',[ref]\$null,[ref]\$e); if(\$e){ \$e | ForEach-Object { \$_.Message }; exit 1 } else { 'PARSE OK: $f' }" || exit 1
done
perl -ne 'print "NON-ASCII $ARGV:$.\n" if /[^\x00-\x7F]/' \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-WorkMfIndex.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-ProjectMaterials.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1 \
  tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 \
  tools/node-t3d-metadata/plugin-src/Scripts/Package-Plugin.ps1
echo "ascii-check done"
```
Expected: five `PARSE OK` lines, no `NON-ASCII` line, `ascii-check done`.

- [ ] **Step 7: Commit**

```bash
git add tools/node-t3d-metadata/plugin-src/Scripts/Run-WorkMfIndex.ps1 \
        tools/node-t3d-metadata/plugin-src/Scripts/Run-ProjectMaterials.ps1 \
        tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1 \
        tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 \
        tools/node-t3d-metadata/plugin-src/Scripts/Package-Plugin.ps1
git commit -m "feat(tools): platform-detect UE binary paths in crawl runners (Win64/Mac)"
```

---

### Task 4: Gitignore the locally-built Mac plugin binary

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the ignore rule**

Append to `.gitignore` (near the existing `tools/node-t3d-metadata/...` lines):

```
# Locally-built macOS plugin binary (D2: Mac plugin stays local; Win64 stays committed)
tools/node-t3d-metadata/compiled/**/Binaries/Mac/
```

- [ ] **Step 2: Verify the rule ignores Mac but not the committed Win64**

Run:
```bash
git check-ignore -v tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib
git check-ignore tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Win64/UnrealEditor-UEMatExportMetadata.dll || echo "Win64 NOT ignored (correct)"
```
Expected: the Mac path prints a `.gitignore` match; the Win64 path prints `Win64 NOT ignored (correct)`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore locally-built macOS plugin binary"
```

---

### Task 5: Build the macOS plugin binary (real UE build — long-running)

**Files:**
- Output (gitignored): `tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib`

**Note:** `RunUAT BuildPlugin -Package=<dir>` writes a *full clean* plugin copy, so build to a TEMP dir and copy only the Mac binary into the committed plugin folder (do not let it clobber the Win64 layout). This compiles C++ against the source engine and can take 10–30 min.

- [ ] **Step 1: Build the plugin for Mac into a temp package dir (background)**

Run (in background; it is long):
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
rm -rf /tmp/uemat-mac-build
PATH=/usr/local/bin:$PATH /usr/local/bin/pwsh -NoProfile -File \
  tools/node-t3d-metadata/plugin-src/Scripts/Package-Plugin.ps1 \
  -EngineRoot /Users/rouseterry/G1Project/SDGF_G1_Project/UE_5.7 \
  -PackageDir /tmp/uemat-mac-build
```
Expected (on success): `Packaged plugin to /tmp/uemat-mac-build` and exit 0. If UBT errors, read `Logs/UE/UEMatExportMetadata_Package.log`.

- [ ] **Step 2: Verify the Mac binary and copy it into the committed plugin folder**

Run:
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
ls -lh /tmp/uemat-mac-build/Binaries/Mac/
file /tmp/uemat-mac-build/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib
DEST=tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Mac
mkdir -p "$DEST"
cp /tmp/uemat-mac-build/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib "$DEST/"
cp /tmp/uemat-mac-build/Binaries/Mac/UnrealEditor.modules "$DEST/" 2>/dev/null || true
ls -lh "$DEST/"
```
Expected: `file` reports a `Mach-O 64-bit dynamically linked shared library arm64`; the dylib now exists under `compiled/.../Binaries/Mac/`.

- [ ] **Step 3: Confirm the binary is gitignored (no repo pollution)**

Run:
```bash
git status --porcelain tools/node-t3d-metadata/compiled/ ; echo "---"; git check-ignore tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib
```
Expected: `git status` shows **nothing** under `compiled/` (the Mac binary is ignored), and `check-ignore` echoes the Mac dylib path. No commit (artifact is local).

---

### Task 6: Write the macOS `local.config.json` and confirm the env probe is green

**Files:**
- Create (gitignored): `tools/node-t3d-metadata/local.config.json`

- [ ] **Step 1: Write the local config with Mac paths**

Create `tools/node-t3d-metadata/local.config.json`:
```json
{
  "ProjectPath": "/Users/rouseterry/G1Project/SDGF_G1_Project/G1_Project/G1_Project.uproject",
  "EngineRoot": "/Users/rouseterry/G1Project/SDGF_G1_Project/UE_5.7",
  "WorkMfContentRoots": "/Game"
}
```

- [ ] **Step 2: Build the server and run the env probe**

Run:
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
PATH=/usr/local/bin:$PATH viewer/node_modules/.bin/tsc -p viewer/tsconfig.json
PATH=/usr/local/bin:$PATH node --input-type=module -e "import('./viewer/dist/server/crawl-env.js').then(async m => { const r = await m.probeEnv(process.cwd()); console.log(JSON.stringify(r.checks, null, 2)); console.log('READY:', r.ready); })"
```
Expected: every check `ok: true`; `platform.detail` is `macOS`; final line `READY: true`.

- [ ] **Step 3: Confirm `local.config.json` is gitignored**

Run: `git check-ignore tools/node-t3d-metadata/local.config.json`
Expected: the path is echoed (already ignored — no commit).

---

### Task 7: End-to-end crawl validation against G1_Project (real UE runs)

**Goal:** prove the full pwsh → UE → result path works on macOS and that no committed/public artifact is touched.

- [ ] **Step 1: Headless workmf crawl through the real runner (background, long)**

Run (background — launches UnrealEditor-Cmd):
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
PATH=/usr/local/bin:$PATH node --input-type=module -e "
import { createCrawlRunner } from './viewer/dist/server/crawl-runner.js';
const r = createCrawlRunner(process.cwd());
r.start('workmf', e => {
  if (e.type === 'log') console.log(e.line);
  else console.log('['+e.type+']', e.status ?? e.kind ?? '');
});
"
```
Expected: streamed UE log lines ending with `Work-MF index written to ...agent-pack/workmf-index.json` and `[done] success`. (If it ends `[done] error` with `check the Content Route`, the crawl found 0 MFs — re-run with a correct `WorkMfContentRoots` in local.config.json.)

- [ ] **Step 2: Verify workmf output exists and is gitignored**

Run:
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
ls -lh agent-pack/workmf-index.json
git check-ignore agent-pack/workmf-index.json
git status --porcelain | grep -vE '^\?\? Logs/' || echo "working tree clean of tracked changes"
```
Expected: the index exists; `check-ignore` echoes it; no tracked file is modified (only ignored outputs / Logs may appear as untracked).

- [ ] **Step 3: projectmat crawl + import through the server (browser-driven)**

Start the dev server, then trigger the crawl from the UI so the server's post-crawl import hook runs (it imports staged T3D into `graphs/_project/`, which the headless runner alone does not do):
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
PATH=/usr/local/bin:$PATH pnpm dev
```
Then in the browser at the printed `http://localhost:5790`: Config tab → confirm the env checklist is all-green → click **爬取專案母材質** (projectmat). Watch the live log stream and the 返回 button reappear when done; then Files → **工作 · Work** should list the crawled materials (and any referenced project MFs under 函式).

- [ ] **Step 4: Verify purity after the full run**

Run:
```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
node tools/node-t3d-metadata/audit-export-meta.js ; echo "audit exit=$?"
git status --porcelain
```
Expected: `audit exit=0`; `git status` shows **no modified committed artifacts** under `agent-pack/` or `tools/.../compiled/` — only gitignored outputs (`workmf-index.json`, `projectmat-staging/`, `compiled/**/Binaries/Mac/`, `Logs/`) and untracked `graphs/_project/` data. Nothing project-specific is staged for commit.

---

## Self-review

**Spec coverage:** W1 (pwsh install) done pre-plan; W2 → Task 5; W3 → Task 3; W4 → Task 1; W5 → Tasks 2 + 6; W6 → Task 7; D2 gitignore → Task 4. All spec items mapped.

**Type/idiom consistency:** `defaultCommandFor` 4th param `platform?: NodeJS.Platform` matches `probeEnv`'s injectable `platform`. The `.ps1` idiom `($IsMacOS -eq $true)` is identical across all five scripts. Mac paths are consistent everywhere: editor `Engine/Binaries/Mac/UnrealEditor-Cmd`, dll `Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib`.

**Invariants:** #4 enforced by Task 3 Step 6 ASCII check; #5 preserved (commands still only in `defaultCommandFor`, one `.ps1` set); #1/#2/#3 verified by Task 7 Step 4 purity check; D2 by Task 4.
