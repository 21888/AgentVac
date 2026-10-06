import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { TARGETS, CapabilityBlock, classifyLaunchError, recordCheck, parseArgs, resolveInput, assertNativeHost, isolatedEnv, assertArchiveEntries, inspectExecutable, assertRuntime, fixturePath, fixtureDigest, summarize, PACKAGED_HELPERS, validatePayloadManifest, bindRuntimePayload } from './core.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
let args;
try { args = parseArgs(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 2; }
if (!args) process.exit(2);
if (args.help) {
  console.log(`Usage: node run.mjs --target <${Object.keys(TARGETS).join('|')}> [--release-root DIRECTORY | --candidate-executable ABSOLUTE_PATH --candidate-id REVISION] [--playwright-root PROJECT] [--preflight-only]\n\nCandidate inputs require an unpacked target and never assert frozen archive byte identity. No source, package, OS-security or installer changes. Results go to evidence/; owned profiles remain in .runs/. See README.md for scope and native gaps.`);
  process.exit(0);
}
const spec = TARGETS[args.target];
const releaseRoot = path.resolve(args['release-root'] || path.join(here, '../AgentVac-next/release-next'));
const dependencyRoot = path.resolve(args['playwright-root'] || path.join(here, '../AgentVac-next'));
const preflight = args['preflight-only'] === true;
const evidenceRoot = args['evidence-root'] || path.join(here, 'evidence');
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.mkdir(path.join(here, '.runs'), { recursive: true });
const ownedRoot = await fs.mkdtemp(path.join(await fs.realpath(path.join(here, '.runs')), args.target + '-'));
const profile = path.join(ownedRoot, 'profile');
const evidence = path.join(evidenceRoot, path.basename(ownedRoot));
await fs.mkdir(profile);
await fs.mkdir(evidence);
const input = resolveInput(args, releaseRoot);
const payloadManifest = args['payload-manifest'] ? validatePayloadManifest(JSON.parse(await fs.readFile(args['payload-manifest'], 'utf8'))) : null;
if (payloadManifest) assert.equal(payloadManifest.sourceRevision, args['candidate-id'], 'Payload manifest and candidate revision must match');
const artifact = input.artifact;
const env = isolatedEnv(process.env, profile);
await fs.mkdir(env.CODEX_HOME);
await fs.mkdir(env.CODEX_SQLITE_HOME);
const host = { platform: process.platform, arch: process.arch, machine: os.machine(), node: process.version, display: process.env.DISPLAY || null, waylandDisplay: process.env.WAYLAND_DISPLAY || null, translated: false };
const planned = ['native-host', 'artifact-and-packaged-payload', 'native-launch-preload-and-sandbox', 'generated-fixture-roundtrip', 'theme-and-history-restart', 'clean-shutdown'];
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), suite: 'packaged-executable-smoke', mode: preflight ? 'preflight' : 'native',
  target: args.target, artifactType: spec.type, artifact, inputProvenance: input.provenance, host, ownedRoot, profile,
  nativeLaunchAttempted: false, packagedRuntimeVerified: false,
  payloadBindings: [],
  sourceImported: false, applicationPatched: false, sandboxDisabled: false,
  fixtureOnly: true, mockDialogs: false, mockFilesystem: false, mockPreload: false,
  checks: Object.fromEntries(planned.map(name => [name, { status: 'UNTESTED' }])),
  separateReleaseGates: {
    firstLaunchViaOS: 'UNTESTED: Inspector-driven direct executable launch is not Finder/Explorer/Gatekeeper/SmartScreen first-launch acceptance.',
    signingAndNotarization: 'UNTESTED: Recovery-history signing is unrelated to macOS Developer ID/notarization or Windows Authenticode.',
    installer: 'NOT_TESTED_BY_THIS_HARNESS: Installation, artifact hashes and disk-image preparation belong to the release-package wrapper; an unpacked launch is never installer evidence.',
    nativeDialogsAndTrash: 'UNTESTED: This minimal smoke uses only generated-demo IPC; no system Trash, restore UI or native file picker.',
    sqliteHelperLifecycle: 'UNTESTED: Native parser, cancel/close and owned-child cleanup require the separate diagnostic harness on a clear authorized machine.',
    appimageFuse: args.target === 'linux-appimage' ? 'PENDING: Only direct successful AppImage launch may count; extraction fallback is prohibited.' : 'UNTESTED: This target does not establish AppImage/FUSE acceptance.',
  },
};
let application, page, launcher, mainPid, electron;
let demoRoot, batchId, originals = [], protectedOriginals = [];
const rendererErrors = [];
let logBytes = 0;
// Preserve failed evidence even if a dependency emits an unhandled rejection
// before returning its launch promise. This observes rather than suppresses the crash.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  report.checks['harness-fatal-error'] = { status: 'FAIL', detail: String(error.stack || error), origin };
  report.finishedAt = new Date().toISOString();
  report.verdict = 'FAIL';
  report.cleanup = { status: 'UNVERIFIED_AFTER_FATAL_ERROR', ownedLauncherPid: launcher?.pid || null, observedMainPid: mainPid || null };
  try { writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n'); } catch { /* Original fatal error still terminates the process. */ }
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM');
});
function log(text) {
  if (logBytes >= 262144) return;
  const part = String(text).slice(0, 262144 - logBytes);
  logBytes += part.length;
  // Only executable logs, never environment, key contents or preview tokens.
  fs.appendFile(path.join(evidence, 'process.log'), part).catch(() => {});
}
async function save() {
  report.finishedAt = new Date().toISOString();
  report.verdict = summarize(report.checks, preflight);
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
async function check(name, action) {
  return recordCheck(report.checks, name, action, save);
}
async function deadline(promise, ms, name) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, name, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${name}`);
}
async function prepare() {
  const stat = await fs.lstat(artifact);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be a regular file');
  report.artifactObservation = { bytes: stat.size, mtime: stat.mtime.toISOString(), archiveHashesRecomputed: false };
  let executable = artifact;
  if (spec.type === 'tar-portable' || spec.type === 'app-zip') {
    const extracted = path.join(ownedRoot, 'extracted');
    await fs.mkdir(extracted);
    // Inputs are the already verified, trusted frozen release artifacts. This is not a general untrusted archive importer.
    const listing = spec.type === 'tar-portable'
      ? await run('tar', ['-tzf', artifact], { maxBuffer: 2 * 1024 * 1024, timeout: 60000 })
      : await run('/usr/bin/unzip', ['-Z1', artifact], { maxBuffer: 2 * 1024 * 1024, timeout: 60000 });
    report.archiveEntries = assertArchiveEntries(listing.stdout, spec.type);
    if (spec.type === 'tar-portable') await run('tar', ['-xzf', artifact, '-C', extracted, '--no-same-owner'], { timeout: 60000 });
    else await run('/usr/bin/ditto', ['-x', '-k', artifact, extracted], { timeout: 60000 });
    executable = path.join(extracted, spec.executable);
  }
  const header = await inspectExecutable(executable);
  assert.equal(header.arch, spec.launcherArch || spec.arch);
  assert.equal(header.format, { linux: 'ELF', win32: 'PE', darwin: 'Mach-O' }[spec.platform]);
  if (spec.type !== 'portable-launcher' && spec.type !== 'appimage-fuse') {
    const resources = spec.platform === 'darwin'
      ? path.resolve(path.dirname(executable), '../Resources')
      : path.join(path.dirname(executable), 'resources');
    for (const name of ['app.asar', ...PACKAGED_HELPERS.map(name => 'app.asar.unpacked/dist-electron/' + name)]) {
      const st = await fs.lstat(path.join(resources, name));
      assert.ok(st.isFile() && !st.isSymbolicLink() && st.size > 0, `Missing regular packaged resource ${name}`);
    }
  }
  return { executable, header, freshExtraction: !!spec.executable, installerTested: false };
}
async function launch(executable) {
  report.nativeLaunchAttempted = true;
  await save();
  try {
    application = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], cwd: ownedRoot, env, chromiumSandbox: true, timeout: 45000 });
  } catch (error) { throw classifyLaunchError(error, spec); }
  launcher = application.process();
  launcher.stdout?.on('data', log);
  launcher.stderr?.on('data', log);
  page = await deadline(application.firstWindow(), 20000, 'first packaged window');
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => rendererErrors.push(String(error)));
  const runtime = await application.evaluate(({ app, BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const prefs = windows[0].webContents.getLastWebPreferences();
    return {
      mainPid: process.pid, packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      electron: process.versions.electron, userData: app.getPath('userData'), appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
      execPath: process.execPath, argv: process.argv, windows: windows.length, visible: windows[0].isVisible(),
      sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity,
      disabledProtectionSwitches: ['no-sandbox', 'disable-setuid-sandbox', 'disable-web-security', 'single-process'].filter(name => app.commandLine.hasSwitch(name)),
    };
  });
  mainPid = runtime.mainPid;
  assertRuntime(runtime, spec, profile);
  for (const name of PACKAGED_HELPERS) {
    const st = await fs.lstat(path.join(runtime.resourcesPath, 'app.asar.unpacked/dist-electron', name));
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.size > 0, `Packaged helper is missing: ${name}`);
  }
  if (payloadManifest) report.payloadBindings.push(await bindRuntimePayload(runtime, payloadManifest));
  // Validate transient launch arguments above, but do not publish process argv.
  delete runtime.argv;
  report.packagedRuntimeVerified = true;
  await page.getByRole('complementary', { name: '工作空间导航' }).waitFor();
  await page.waitForFunction(() => typeof window.agentvac?.getContext === 'function' && typeof window.agentvac?.scan === 'function' && typeof window.agentvac?.restore === 'function');
  const choose = page.getByRole('button', { name: /^(选择 Codex 目录|切换目录)$/ });
  await until(() => choose.isEnabled(), 'startup IPC settled');
  return runtime;
}
async function shutdown() {
  const current = application, child = launcher;
  if (!current) return;
  await deadline(current.close(), 15000, 'packaged app shutdown');
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned launcher exit', 10000);
  assert.equal(child.exitCode, 0, 'The launch process must exit cleanly');
  assert.equal(child.signalCode, null);
  application = undefined;
  return { launcherExitCode: child.exitCode, observedMainPid: mainPid };
}
try {
  await check('native-host', async () => {
    if (host.platform === 'darwin') {
      // Read-only observation. Never request Accessibility or change Gatekeeper/TCC.
      const translated = await run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeout: 5000 }).catch(error => ({ stdout: '', stderr: String(error.message) }));
      host.translated = translated.stdout.trim() === '1';
    }
    assertNativeHost(spec, preflight ? { ...host, display: host.display || 'preflight-does-not-launch' } : host);
    return { ...host, graphicalSessionRequired: !preflight };
  });
  const prepared = await check('artifact-and-packaged-payload', prepare);
  if (!preflight) {
    await check('native-launch-preload-and-sandbox', async () => {
      const require = createRequire(path.join(dependencyRoot, 'package.json'));
      ({ _electron: electron } = require('playwright'));
      const runtime = await launch(prepared.executable);
      const cold = await page.evaluate(async () => {
        const context = await window.agentvac.getContext();
        const preferences = await window.agentvac.getPreferences();
        const appData = await window.agentvac.getAppData();
        return { context, preferences, canSignRecoveryHistory: appData.recovery.canSign, issues: appData.issues, recoveryIssues: appData.recovery.issues, requireType: typeof window.require, processType: typeof window.process };
      });
      assert.equal(cold.context.root, null);
      assert.equal(cold.canSignRecoveryHistory, true);
      assert.deepEqual(cold.issues, []);
      assert.deepEqual(cold.recoveryIssues, []);
      assert.equal(cold.requireType, 'undefined');
      assert.equal(cold.processType, 'undefined');
      await page.screenshot({ path: path.join(evidence, '01-cold.png') });
      if (spec.type === 'appimage-fuse') report.separateReleaseGates.appimageFuse = 'PASS: Direct AppImage executable launched successfully; no extraction fallback was used.';
      return { runtime, cold };
    });
    await check('generated-fixture-roundtrip', async () => {
      // The shipped demo generator creates every tested file. No file-picker adapter or app patch is involved.
      await page.getByRole('button', { name: '体验演示扫描', exact: true }).click();
      demoRoot = path.join(profile, 'demo-workspace');
      await until(async () => {
        try { const ctx = await page.evaluate(() => window.agentvac.getContext()); return ctx.root === demoRoot && ctx.demo; }
        catch { return false; }
      }, 'generated demo context');
      await until(() => page.getByRole('button', { name: /^(选择 Codex 目录|切换目录)$/ }).isEnabled(), 'demo creation and UI scan settled');
      const scan = await page.evaluate(() => window.agentvac.scan({ minAgeDays: 30, includeSessions: false }));
      assert.equal(scan.root, demoRoot);
      assert.equal(scan.demo, true);
      assert.equal(scan.status, 'complete');
      const safe = scan.entries.filter(entry => entry.selectable && entry.risk === 'safe');
      assert.deepEqual(safe.map(entry => entry.path).sort(), ['log/codex-tui.log.1', 'log/codex-tui.log.2', 'log/codex-tui.log.2026-05-01.gz'].sort());
      originals = await Promise.all(safe.map(entry => fixtureDigest(demoRoot, entry.path)));
      protectedOriginals = await Promise.all(['auth.json', 'config.toml', 'history.jsonl', 'state_5.sqlite', 'log/codex-tui.log', 'projects/keep.txt'].map(relative => fixtureDigest(demoRoot, relative)));
      const preview = await page.evaluate(ids => window.agentvac.preview(ids), safe.map(entry => entry.id));
      assert.equal(preview.items.length, 3);
      assert.equal(preview.scanStatus, 'complete');
      assert.equal(preview.processStatus.status, 'clear', 'The production demo policy must identify its own fixture');
      const moved = await page.evaluate(token => window.agentvac.quarantine(token, true), preview.token);
      batchId = moved.batchId;
      assert.equal(moved.completed, 3);
      assert.deepEqual(moved.failed, []);
      for (const entry of safe) await assert.rejects(fs.lstat(fixturePath(demoRoot, entry.path)), { code: 'ENOENT' });
      const rows = await page.evaluate(() => window.agentvac.history());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, batchId);
      assert.equal(rows[0].items.length, 3);
      assert.ok(rows[0].items.every(item => item.status === 'quarantined'));
      for (const item of rows[0].items) {
        const stored = await fixtureDigest(demoRoot, `.agentvac-quarantine/${batchId}/${item.id}.data`);
        const original = originals.find(value => value.relative === item.path);
        assert.ok(original);
        assert.equal(stored.sha256, original.sha256);
        assert.equal(stored.bytes, original.bytes);
      }
      const restored = await page.evaluate(id => window.agentvac.restore(id, true), batchId);
      assert.equal(restored.completed, 3);
      assert.deepEqual(restored.failed, []);
      for (const original of [...originals, ...protectedOriginals]) assert.deepEqual(await fixtureDigest(demoRoot, original.relative), original);
      const history = await page.evaluate(() => window.agentvac.history());
      assert.equal(history[0].id, batchId);
      assert.ok(history[0].items.every(item => item.status === 'restored'));
      return { generatedDemoOnly: true, ipcCalls: ['scan', 'preview', 'quarantine', 'history', 'restore'], realFiles: true, restoredFileHashes: originals, protectedFilesUnchanged: protectedOriginals.map(item => item.relative), batchId, nativeDialogsTested: false, operatingSystemTrashTested: false };
    });
    await check('theme-and-history-restart', async () => {
      await page.getByRole('button', { name: '浅色主题', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal((await page.evaluate(() => window.agentvac.getPreferences())).theme, 'light');
      await page.screenshot({ path: path.join(evidence, '02-light.png') });
      await page.getByRole('button', { name: '深色主题', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      assert.equal((await page.evaluate(() => window.agentvac.getPreferences())).theme, 'dark');
      const firstPid = mainPid;
      await shutdown();
      assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).theme, 'dark');
      const restarted = await launch(prepared.executable);
      assert.notEqual(restarted.mainPid, firstPid, 'A real process restart is required');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      assert.equal(await page.getByRole('button', { name: '深色主题', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
      const persistent = await page.evaluate(async () => ({ context: await window.agentvac.getContext(), preferences: await window.agentvac.getPreferences(), history: await window.agentvac.history(), appData: await window.agentvac.getAppData() }));
      assert.equal(persistent.context.root, demoRoot);
      assert.equal(persistent.context.demo, true);
      assert.equal(persistent.preferences.theme, 'dark');
      assert.equal(persistent.history.length, 1);
      assert.equal(persistent.history[0].id, batchId);
      assert.ok(persistent.history[0].items.every(item => item.status === 'restored'));
      assert.equal(persistent.appData.workspaces.entries.filter(item => item.demo).length, 1);
      assert.equal(persistent.appData.recovery.canSign, true);
      assert.deepEqual(persistent.appData.issues, []);
      for (const original of [...originals, ...protectedOriginals]) assert.deepEqual(await fixtureDigest(demoRoot, original.relative), original);
      await page.screenshot({ path: path.join(evidence, '03-dark-restarted.png') });
      return { previousPid: firstPid, restartedPid: mainPid, profileReused: true, theme: 'dark', nativeTheme: 'dark', demoRootReused: true, restoredBatchId: batchId, recoveryHistorySigning: true, osCodeSigningTested: false };
    });
    await check('clean-shutdown', async () => {
      const result = await shutdown();
      assert.deepEqual(rendererErrors, [], 'Uncaught renderer exceptions occurred');
      return { ...result, rendererErrors: [] };
    });
  }
} catch (error) {
  report.error = String(error.message || error);
  process.exitCode = error instanceof CapabilityBlock ? 2 : 1;
} finally {
  if (application) {
    try { await shutdown(); }
    catch (error) {
      report.cleanup = { status: 'FAIL', detail: String(error.message), ownedLauncherPid: launcher?.pid, observedMainPid: mainPid };
      // No broad process-name kills. Ask the report consumer to inspect this exact owned PID.
      if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM');
      process.exitCode = 1;
    }
  }
  if (preflight) for (const name of planned.slice(2)) report.checks[name] = { status: 'UNTESTED', detail: 'Preflight only; no Electron launch or application action was attempted.' };
  await save();
  if (report.cleanup?.status === 'FAIL') { report.verdict = 'FAIL'; await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
  console.log(`${report.verdict}: ${path.join(evidence, 'result.json')}`);
  if (!preflight && report.verdict !== 'PASS_PACKAGED_SMOKE_ONLY') process.exitCode ||= 1;
}
