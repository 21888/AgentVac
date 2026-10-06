// Native acceptance of the exact v0.2.0 deliverable bytes. No cross-host pass,
// unpacked-as-installer substitution, elevated launch, or security-policy edits.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageTargets } from './package-targets.mjs';
import { CapabilityBlock, assertNativeHost, inspectExecutable, fileIdentity, snapshotPayload, verifyPayload, validatePayloadManifest, isWithin } from '../qa/packaged-acceptance/core.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const VERSION = '0.2.0';
const PREFIX = `AgentVac-${VERSION}`;
export const RELEASE_TARGETS = Object.freeze({
  'linux-tar': { platform: 'linux', arch: 'x64', kind: 'tar', artifact: `linux/${PREFIX}-linux-x64.tar.gz`, candidate: 'linux-unpacked' },
  'macos-x64-zip': { platform: 'darwin', arch: 'x64', kind: 'zip', artifact: `macos/${PREFIX}-macos-x64.zip`, candidate: 'macos-x64-unpacked' },
  'macos-x64-dmg': { platform: 'darwin', arch: 'x64', kind: 'dmg', artifact: `macos/${PREFIX}-macos-x64.dmg`, candidate: 'macos-x64-unpacked' },
  'macos-arm64-zip': { platform: 'darwin', arch: 'arm64', kind: 'zip', artifact: `macos/${PREFIX}-macos-arm64.zip`, candidate: 'macos-arm64-unpacked' },
  'macos-arm64-dmg': { platform: 'darwin', arch: 'arm64', kind: 'dmg', artifact: `macos/${PREFIX}-macos-arm64.dmg`, candidate: 'macos-arm64-unpacked' },
  'windows-portable': { platform: 'win32', arch: 'x64', kind: 'portable', artifact: `windows/${PREFIX}-windows-x64-portable.exe`, candidate: 'windows-portable-built' },
  'windows-setup': { platform: 'win32', arch: 'x64', kind: 'setup', artifact: `windows/${PREFIX}-windows-x64-setup.exe`, candidate: 'windows-unpacked' },
});

const PACKAGE_CHECKS = new Set(['native-host', 'artifact-before', 'built-payload-snapshot', 'extract-actual-artifact', 'mount-actual-dmg', 'copy-dmg-payload', 'no-existing-installation', 'silent-install', 'prepared-payload-byte-identity', 'own-installed-uninstaller', 'actual-package-native-smoke', 'actual-package-conversation-readers', 'silent-uninstall-owned-installation', 'detach-owned-dmg', 'artifact-after']);
const NATIVE_CHECKS = new Set(['native-host', 'artifact-and-packaged-payload', 'native-launch-preload-and-sandbox', 'generated-fixture-roundtrip', 'theme-and-history-restart', 'clean-shutdown', 'harness-fatal-error']);
const READER_CHECKS = new Set(['reader-codex', 'reader-claude-code', 'reader-cline', 'reader-cursor', 'reader-cline-explicit-read-only', 'reader-cursor-explicit-read-only']);
const SAFE_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'INCOMPLETE', 'UNTESTED', 'UNSUPPORTED', 'PASS_PACKAGED_SMOKE_ONLY', 'PASS_WITH_LIMITATIONS', 'PENDING_RUNTIME']);
const SAFE_ERROR_CODES = new Set(['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ENOSPC', 'EBUSY', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_INVALID_ARG_TYPE']);
function firstFailedCheck(checks, allowlist) {
  return Object.entries(checks || {}).find(([name, check]) => allowlist.has(name) && ['FAIL', 'BLOCKED'].includes(check?.status))?.[0];
}
function safeAssertionScalar(value) {
  return typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) || SAFE_STATUSES.has(value);
}
// Console output is an allowlisted diagnostic receipt, never Error.message/stack,
// child output, assertion objects, paths, environment, argv or fixture content.
export function packageFailureSummary(report, error) {
  const failedCheck = firstFailedCheck(report?.checks, PACKAGE_CHECKS) || (report?.cleanup?.status === 'FAIL' ? 'temporary-cleanup' : report?.target ? 'release-preparation-or-finalization' : 'harness-initialization');
  const summary = {
    target: Object.hasOwn(RELEASE_TARGETS, report?.target) ? report.target : 'UNKNOWN',
    status: report?.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL', failedCheck,
    category: error instanceof CapabilityBlock ? 'NATIVE_CAPABILITY_BLOCK' : error?.code === 'ERR_ASSERTION' ? 'ASSERTION_MISMATCH' : Number.isInteger(error?.code) ? 'CHILD_PROCESS_EXIT' : error?.killed === true ? 'CHILD_PROCESS_INTERRUPTED' : SAFE_ERROR_CODES.has(error?.code) ? 'SYSTEM_ERROR' : 'CHECK_FAILED',
  };
  if (SAFE_ERROR_CODES.has(error?.code)) summary.errorCode = error.code;
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 0xffffffff) summary.exitCode = error.code;
  if (error?.code === 'ERR_ASSERTION') for (const key of ['expected', 'actual']) if (safeAssertionScalar(error[key])) summary[key] = error[key];
  if (failedCheck === 'actual-package-native-smoke') {
    if (NATIVE_CHECKS.has(report.nativeAcceptance?.failedCheck)) summary.nestedFailedCheck = report.nativeAcceptance.failedCheck;
    summary.expectedStatus = 'PASS_PACKAGED_SMOKE_ONLY';
    if (SAFE_STATUSES.has(report.nativeAcceptance?.status)) summary.actualStatus = report.nativeAcceptance.status;
  } else if (failedCheck === 'actual-package-conversation-readers') {
    if (READER_CHECKS.has(report.packagedReaders?.failedCheck)) summary.nestedFailedCheck = report.packagedReaders.failedCheck;
    summary.expectedStatus = RELEASE_TARGETS[summary.target]?.platform === 'win32' ? 'PASS_WITH_LIMITATIONS' : 'PASS';
    if (SAFE_STATUSES.has(report.packagedReaders?.nativeOutcome)) summary.actualStatus = report.packagedReaders.nativeOutcome;
  }
  return summary;
}

export function parseReleaseArgs(values) {
  const args = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i];
    assert.ok(['--target', '--release-root', '--source-revision'].includes(key), `Unknown release option: ${key}`);
    assert.equal(args[key.slice(2)], undefined, `Duplicate release option: ${key}`);
    const value = values[++i];
    assert.ok(value && !value.startsWith('--'), `Missing value: ${key}`);
    args[key.slice(2)] = value;
  }
  assert.ok(Object.hasOwn(RELEASE_TARGETS, args.target), 'An exact release --target is required');
  assert.match(args['source-revision'] || '', /^[0-9a-f]{40}$/, 'Provide the exact 40-character source commit SHA');
  return args;
}

export function validateArchiveListing(raw, expectedRoot) {
  const names = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(names.length, 'Empty archive');
  for (const name of names) {
    assert.ok(!name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name), 'Unsafe archive path');
    assert.ok(!name.split('/').includes('..'), 'Archive traversal');
    assert.ok(name === expectedRoot || name.startsWith(expectedRoot + '/'), 'Unexpected archive root');
  }
  return names.length;
}

export function installerArguments(installRoot, tempRoot, uninstall = false) {
  assert.ok(path.isAbsolute(installRoot) && path.isAbsolute(tempRoot) && isWithin(tempRoot, installRoot), 'Installation must stay inside its generated temp root');
  assert.equal(path.basename(installRoot), 'installed');
  assert.ok(!/[\r\n"\0]/.test(installRoot), 'Unsafe generated installation path');
  // NSIS /D= and _?= are last and intentionally unquoted; no shell is involved.
  return uninstall ? ['/S', '/currentuser', `_?=${installRoot}`] : ['/S', '/currentuser', `/D=${installRoot}`];
}

export function assertFreshWindowsState(state) {
  assert.equal(state.processCount, 0, 'Existing AgentVac process: installer must not close or replace it');
  assert.ok(state.registry.length === 8 && state.registry.every(item => item.exists === false), 'Existing or unverified AgentVac installation registry');
  assert.ok(state.paths.length >= 5 && state.paths.every(item => item.exists === false), 'Existing AgentVac shortcut, cache, or installation path');
}

export function assertInstalledWindowsState(state, installRoot) {
  assert.equal(state.processCount, 0, 'AgentVac must be closed before installer cleanup');
  const present = state.registry.filter(item => item.exists);
  assert.ok(present.length >= 2, 'Installed registry evidence missing');
  for (const item of present) {
    assert.equal(item.hive, 'CurrentUser', 'Unexpected machine-wide installation');
    if (item.key.startsWith('Software\\Microsoft\\')) {
      assert.equal(item.uninstallMode, '/currentuser', 'Uninstaller is not registered per user');
      assert.equal(path.resolve(item.uninstallerPath || ''), path.join(path.resolve(installRoot), 'Uninstall AgentVac.exe'), 'Uninstaller registry points outside owned installation');
    } else assert.equal(path.resolve(item.installLocation || ''), path.resolve(installRoot), 'Installer registry points outside owned installation');
  }
}

export function assertPackagedReaderEvidence(readers, spec, revision, artifactSha256) {
  assert.equal(readers.sourceRevision, revision);
  assert.equal(readers.platform, spec.platform); assert.equal(readers.arch, spec.arch);
  assert.equal(readers.status, spec.platform === 'win32' ? 'PASS_WITH_LIMITATIONS' : 'PASS');
  assert.equal(readers.packagedArtifactTested, true);
  assert.equal(readers.packagePayloadBinding?.status, 'PASS');
  assert.equal(readers.packagePayloadBinding?.artifactSha256, artifactSha256);
  assert.equal(readers.sourcesUnchanged, true); assert.equal(readers.builtUnchanged, true);
  assert.equal(readers.cleanup?.appClosed, true); assert.equal(readers.cleanup?.profileRemoved, true);
  assert.deepEqual(readers.errors, []);
  for (const provider of ['codex', 'claude-code', 'cline', 'cursor']) {
    const canonical = readers.checks.filter(check => check.provider === provider && !check.source);
    assert.equal(canonical.length, 1, `Missing unique packaged reader case: ${provider}`);
    const check = canonical[0];
    if (provider === 'cursor' && spec.platform === 'win32') {
      assert.equal(check.status, 'UNSUPPORTED'); assert.equal(check.reason, 'WINDOWS_CURSOR_IDE_DISABLED_0_2');
      for (const field of ['disabledGateVerified', 'consentRefused', 'listRefused', 'noSnapshotCreated', 'sourceUnchanged']) assert.equal(check[field], true);
    } else {
      assert.equal(check.status, 'PASS');
      for (const field of ['lateContentSearch', 'fullUnicodePaging', 'actualTimestamp', 'consentBeforeRead', 'revokeInvalidates']) assert.equal(check[field], true);
    }
  }
  for (const provider of ['cline', 'cursor']) {
    const explicit = readers.checks.filter(check => check.provider === provider && check.source === 'explicit-read-only');
    assert.equal(explicit.length, 1); assert.equal(explicit[0].status, 'PASS');
    for (const field of ['newConsent', 'cleanupRootUnchanged', 'archiveDisabled', 'resetRevokes']) assert.equal(explicit[0][field], true);
  }
  assert.equal(readers.checks.length, 6, 'Unexpected/missing package reader cases');
}

function psQuote(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }

async function windowsState(guid) {
  // Read exact product keys and process counts only. Never enumerate command lines.
  const script = `
$ErrorActionPreference = 'Stop'
$keys = @(${psQuote('Software\\' + guid)}, ${psQuote('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid)})
$items = @()
foreach ($hive in @('CurrentUser', 'LocalMachine')) {
  foreach ($view in @('Registry64', 'Registry32')) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
    try {
      foreach ($key in $keys) {
        $handle = $base.OpenSubKey($key, $false)
        try {
          $location = $null; $uninstallerPath = $null; $uninstallMode = $null
          if ($handle) {
            $location = $handle.GetValue('InstallLocation', $null)
            $uninstall = $handle.GetValue('UninstallString', '')
            if ($uninstall -match '^"([^"]+)" (/currentuser)$') { $uninstallerPath = $Matches[1]; $uninstallMode = $Matches[2] }
          }
          $items += @{ hive=$hive; view=$view; key=$key; exists=($null -ne $handle); installLocation=$location; uninstallerPath=$uninstallerPath; uninstallMode=$uninstallMode }
        } finally { if ($handle) { $handle.Dispose() } }
      }
    } finally { $base.Dispose() }
  }
}
$local = [Environment]::GetFolderPath('LocalApplicationData')
$paths = @(
  @{ role='desktop-shortcut'; path=(Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AgentVac.lnk') },
  @{ role='start-menu-shortcut'; path=(Join-Path ([Environment]::GetFolderPath('Programs')) 'AgentVac.lnk') },
  @{ role='installer-cache'; path=(Join-Path $local 'agentvac-updater\\installer.exe') },
  @{ role='default-user-install'; path=(Join-Path $local 'Programs\\AgentVac') },
  @{ role='default-machine-install'; path=(Join-Path $env:ProgramFiles 'AgentVac') }
)
foreach ($item in $paths) { $item.exists = Test-Path -LiteralPath $item.path }
[ordered]@{ processCount=@([System.Diagnostics.Process]::GetProcessesByName('AgentVac')).Count; registry=@($items); paths=@($paths); cacheDirectoryExists=(Test-Path -LiteralPath (Join-Path $local 'agentvac-updater')) } | ConvertTo-Json -Depth 5 -Compress
`;
  const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  return JSON.parse(result.stdout.trim());
}

async function absent(file) {
  try { await fs.lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function waitAbsent(file, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await absent(file)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned installation was not removed by its uninstaller');
}

export async function main(values = process.argv.slice(2)) {
  const args = parseReleaseArgs(values), spec = RELEASE_TARGETS[args.target];
  const releaseRoot = path.resolve(args['release-root'] || path.join(project, 'release-final'));
  const out = path.join(project, '.qa/release-package', args.target);
  await fs.mkdir(out, { recursive: true });
  // A previous success must never survive a new failed or incomplete attempt.
  const report = {
    schemaVersion: 1, status: 'INCOMPLETE', target: args.target, sourceRevision: args['source-revision'], startedAt: new Date().toISOString(),
    artifact: { path: path.join(releaseRoot, spec.artifact), name: path.basename(spec.artifact) },
    nativeAcceptance: { status: 'UNTESTED' }, payloadVerification: { status: 'UNTESTED' }, packagedReaders: { status: 'UNTESTED' },
    installer: { tested: false, status: spec.kind === 'setup' ? 'UNTESTED' : 'NOT_APPLICABLE' },
    checks: {}, cleanup: { status: 'UNTESTED' },
    scope: 'Native package launch, full payload byte/link binding, generated-fixture roundtrip, restart and shutdown; setup also requires real isolated install and uninstall. Independent source-native/provider lifecycle gates must pass separately.',
    limitations: ['No Finder/Explorer first-launch, SmartScreen, Gatekeeper, signing or notarization acceptance.', 'No real user cleanup roots, native file picker or OS Trash acceptance.'],
  };
  const save = async () => fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  let owned, mounted, manifest, originalUninstaller, copiedUninstaller, installedReady = false, windowsBefore, guid, failure;
  const check = async (name, action) => {
    try { const result = await action(); report.checks[name] = { status: 'PASS', detail: result }; await save(); return result; }
    catch (error) { report.checks[name] = { status: error instanceof CapabilityBlock ? 'BLOCKED' : 'FAIL', detail: String(error.message) }; await save(); throw error; }
  };
  try {
    await check('native-host', async () => {
      const host = { platform: process.platform, arch: process.arch, display: process.env.DISPLAY, waylandDisplay: process.env.WAYLAND_DISPLAY, translated: false };
      if (process.platform === 'darwin') {
        const result = await execute('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeout: 5000 }).catch(error => {
          if (error.code === 1 && !String(error.stdout || '').trim()) return { stdout: '0' };
          throw error;
        });
        host.translated = result.stdout.trim() === '1';
      }
      assertNativeHost(spec, host);
      if (spec.kind === 'setup' && (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'))
        throw new CapabilityBlock('NSIS install smoke requires a fresh standard GitHub-hosted Windows runner');
      return { platform: host.platform, arch: host.arch, translated: host.translated, graphicalSession: process.platform !== 'linux' || !!(host.display || host.waylandDisplay) };
    });
    const metadata = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
    assert.equal(metadata.name, 'agentvac'); assert.equal(metadata.version, VERSION); assert.equal(metadata.build.appId, 'app.agentvac.desktop');
    await check('artifact-before', async () => {
      Object.assign(report.artifact, await fileIdentity(report.artifact.path));
      assert.ok(report.artifact.bytes > 0);
      if (['setup', 'portable'].includes(spec.kind)) assert.equal((await inspectExecutable(report.artifact.path)).format, 'PE');
      return report.artifact;
    });
    owned = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agentvac-release-package-'));
    report.ownedRoot = owned;
    const temporary = path.join(owned, 'runtime-temp'); await fs.mkdir(temporary);
    const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
    const built = packageTargets.find(t => t.platform === ({ linux: 'linux', win32: 'windows', darwin: 'macos' })[spec.platform] && t.arch === spec.arch);
    const builtRoot = path.join(releaseRoot, built.app);
    let launchPath, launchRoot;
    const entries = await check('built-payload-snapshot', () => snapshotPayload(builtRoot));
    // Do not duplicate the full inventory in the result; the bound manifest is retained separately.
    report.checks['built-payload-snapshot'].detail = { entries: entries.length };
    if (spec.kind === 'tar' || spec.kind === 'zip') {
      const extracted = path.join(owned, 'extracted'); await fs.mkdir(extracted);
      const expectedRoot = spec.kind === 'tar' ? path.basename(spec.artifact, '.tar.gz') : 'AgentVac.app';
      await check('extract-actual-artifact', async () => {
        const result = spec.kind === 'tar'
          ? await execute('tar', ['-tzf', report.artifact.path], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
          : await execute('/usr/bin/unzip', ['-Z1', report.artifact.path], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        const count = validateArchiveListing(result.stdout, expectedRoot);
        // Only freshly built, locally verified release artifacts enter this bounded extractor.
        if (spec.kind === 'tar') await execute('tar', ['-xzf', report.artifact.path, '-C', extracted, '--no-same-owner'], { timeout: 60000 });
        else await execute('/usr/bin/ditto', ['-x', '-k', report.artifact.path, extracted], { timeout: 60000 });
        return { entries: count, expectedRoot };
      });
      launchRoot = path.join(extracted, expectedRoot, ...(spec.kind === 'zip' ? ['Contents'] : []));
      launchPath = path.join(launchRoot, built.exe);
    } else if (spec.kind === 'dmg') {
      const mountpoint = path.join(owned, 'mounted'); await fs.mkdir(mountpoint);
      await check('mount-actual-dmg', async () => {
        await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, report.artifact.path], { timeout: 60000, maxBuffer: 1024 * 1024 });
        mounted = mountpoint;
        return { readOnly: true, mountpoint };
      });
      const copied = path.join(owned, 'copied/AgentVac.app');
      await fs.mkdir(path.dirname(copied));
      await check('copy-dmg-payload', async () => {
        const source = path.join(mounted, 'AgentVac.app');
        assert.ok((await fs.lstat(source)).isDirectory() && !(await fs.lstat(source)).isSymbolicLink());
        await execute('/usr/bin/ditto', [source, copied], { timeout: 60000 });
        return { source, destination: copied, nativeDiskImageInstallMethod: 'readonly mount and copy into fresh owned directory' };
      });
      launchRoot = path.join(copied, 'Contents'); launchPath = path.join(launchRoot, built.exe);
    } else if (spec.kind === 'portable') {
      launchRoot = temporary; launchPath = report.artifact.path;
    } else {
      const nsis = metadata.build.nsis || {};
      assert.equal(nsis.perMachine, false, 'Release setup must explicitly use per-user installation');
      assert.equal(nsis.allowElevation, false, 'Release setup must explicitly disallow elevation');
      assert.equal(nsis.deleteAppDataOnUninstall, false, 'Setup must never delete real application data');
      assert.equal(nsis.oneClick, false);
      for (const option of ['include', 'script', 'guid', 'menuCategory', 'shortcutName', 'uninstallerIcon']) assert.equal(nsis[option], undefined, `Unreviewed NSIS customization: ${option}`);
      const { UUID } = require('builder-util-runtime');
      guid = UUID.v5(metadata.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
      windowsBefore = await check('no-existing-installation', async () => { const state = await windowsState(guid); assertFreshWindowsState(state); return state; });
      launchRoot = path.join(owned, 'installed'); assert.ok(await absent(launchRoot), 'Install destination already exists');
      report.installer.installRoot = launchRoot;
      await check('silent-install', async () => {
        await execute(report.artifact.path, installerArguments(launchRoot, owned), { env, cwd: owned, timeout: 120000, windowsVerbatimArguments: true, maxBuffer: 1024 * 1024 });
        return { exitedSuccessfully: true, perUser: true, installRoot: launchRoot, elevationRequested: false };
      });
      launchPath = path.join(launchRoot, built.exe);
    }
    manifest = validatePayloadManifest({
      schemaVersion: 1, sourceRevision: report.sourceRevision, artifactSha256: report.artifact.sha256,
      rootMode: spec.kind === 'portable' ? 'inside' : 'exact', root: launchRoot,
      executable: built.exe, resources: spec.platform === 'darwin' ? 'Resources' : 'resources', entries,
      installer: spec.kind === 'setup', allowedExtraFiles: spec.kind === 'setup' ? ['Uninstall AgentVac.exe'] : [],
    });
    const manifestPath = path.join(out, 'payload-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    report.payloadVerification = { status: 'PENDING_RUNTIME', manifestSha256: (await fileIdentity(manifestPath)).sha256, fileCount: entries.filter(e => e.kind === 'file').length, symlinkCount: entries.filter(e => e.kind === 'symlink').length, runtimeBindings: [] };
    if (spec.kind !== 'portable') await check('prepared-payload-byte-identity', () => verifyPayload(launchRoot, manifest));
    if (spec.kind === 'setup') {
      await check('own-installed-uninstaller', async () => {
        const state = await windowsState(guid); assertInstalledWindowsState(state, launchRoot);
        const file = path.join(launchRoot, 'Uninstall AgentVac.exe');
        assert.equal((await inspectExecutable(file)).format, 'PE');
        originalUninstaller = { path: file, ...await fileIdentity(file) };
        copiedUninstaller = path.join(owned, 'owned-uninstaller.exe');
        await fs.copyFile(file, copiedUninstaller, fs.constants.COPYFILE_EXCL);
        assert.deepEqual(await fileIdentity(copiedUninstaller), { bytes: originalUninstaller.bytes, sha256: originalUninstaller.sha256 });
        installedReady = true;
        return { generatedUninstaller: originalUninstaller, installedState: state };
      });
    }
    await check('actual-package-native-smoke', async () => {
      const acceptanceRoot = path.join(out, 'native'); await fs.mkdir(acceptanceRoot, { recursive: true });
      const previous = new Set(await fs.readdir(acceptanceRoot));
      let result, launchError;
      try {
        result = await execute(process.execPath, [path.join(project, 'qa/packaged-acceptance/run.mjs'), '--target', spec.candidate, '--candidate-executable', launchPath, '--candidate-id', report.sourceRevision, '--playwright-root', project, '--payload-manifest', manifestPath, '--evidence-root', acceptanceRoot], { cwd: project, env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
      } catch (error) { result = error; launchError = error; }
      await fs.writeFile(path.join(out, 'native-process.log'), String(result.stdout || '') + String(result.stderr || ''));
      const fresh = (await fs.readdir(acceptanceRoot)).filter(name => !previous.has(name));
      assert.equal(fresh.length, 1, 'Missing unique native acceptance report');
      const resultPath = path.join(acceptanceRoot, fresh[0], 'result.json');
      const native = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      report.nativeAcceptance = { status: native.verdict, report: path.relative(project, resultPath).split(path.sep).join('/'), nativeLaunchAttempted: native.nativeLaunchAttempted, packagedRuntimeVerified: native.packagedRuntimeVerified, failedCheck: firstFailedCheck(native.checks, NATIVE_CHECKS) };
      report.payloadVerification.runtimeBindings = native.payloadBindings || [];
      if (launchError) throw new Error(`Native package acceptance failed: ${native.error || native.verdict}; see native-process.log and native report`);
      assert.equal(native.verdict, 'PASS_PACKAGED_SMOKE_ONLY');
      assert.equal(native.packagedRuntimeVerified, true);
      assert.equal(native.payloadBindings?.length, 2, 'Both initial launch and restart must bind the full package payload');
      assert.ok(native.payloadBindings.every(binding => binding.status === 'PASS' && binding.artifactSha256 === report.artifact.sha256));
      report.payloadVerification.status = 'PASS';
      return report.nativeAcceptance;
    });
    await check('actual-package-conversation-readers', async () => {
      const readerOut = await fs.mkdtemp(path.join(out, 'readers-'));
      let result, readerError;
      try {
        result = await execute(process.execPath, ['--import', 'tsx', path.join(project, 'scripts/native-conversation-regression.mjs')], {
          cwd: project, timeout: 240000, maxBuffer: 4 * 1024 * 1024,
          env: { ...env, GITHUB_SHA: report.sourceRevision, AGENTVAC_PACKAGE_EXECUTABLE: launchPath, AGENTVAC_PACKAGE_PAYLOAD_MANIFEST: manifestPath, AGENTVAC_CONVERSATION_EVIDENCE: readerOut },
        });
      } catch (error) { result = error; readerError = error; }
      await fs.writeFile(path.join(readerOut, 'process.log'), String(result.stdout || '') + String(result.stderr || ''));
      const readers = JSON.parse(await fs.readFile(path.join(readerOut, 'results.json'), 'utf8'));
      report.packagedReaders = { status: 'FAIL', nativeOutcome: readers.status, report: path.relative(project, path.join(readerOut, 'results.json')).split(path.sep).join('/'), checks: readers.checks, packagePayloadBinding: readers.packagePayloadBinding };
      const failedReader = readers.checks?.find(check => check.status === 'FAIL');
      const readerCheck = failedReader && [undefined, 'explicit-read-only'].includes(failedReader.source) ? `reader-${failedReader.provider}${failedReader.source === 'explicit-read-only' ? '-explicit-read-only' : ''}` : readers.failedCheck;
      if (READER_CHECKS.has(readerCheck)) report.packagedReaders.failedCheck = readerCheck;
      if (readerError) throw new Error(`Packaged conversation reader acceptance failed: ${readers.status}; see reader report`);
      assertPackagedReaderEvidence(readers, spec, report.sourceRevision, report.artifact.sha256);
      report.packagedReaders.status = 'PASS';
      return report.packagedReaders;
    });
  } catch (error) { failure = error; report.error = String(error.message); }
  finally {
    if (installedReady) {
      try {
        await check('silent-uninstall-owned-installation', async () => {
          assertInstalledWindowsState(await windowsState(guid), report.installer.installRoot);
          await verifyPayload(report.installer.installRoot, manifest);
          const identity = { bytes: originalUninstaller.bytes, sha256: originalUninstaller.sha256 };
          assert.deepEqual(await fileIdentity(originalUninstaller.path), identity, 'Installed uninstaller changed');
          assert.deepEqual(await fileIdentity(copiedUninstaller), identity, 'Owned uninstaller copy changed');
          // Run the identical copied uninstaller so it can synchronously remove its installation, including its original EXE.
          await execute(copiedUninstaller, installerArguments(report.installer.installRoot, owned, true), { cwd: owned, env: { ...process.env, TEMP: path.join(owned, 'runtime-temp'), TMP: path.join(owned, 'runtime-temp') }, timeout: 120000, windowsVerbatimArguments: true, maxBuffer: 1024 * 1024 });
          await waitAbsent(report.installer.installRoot);
          const after = await windowsState(guid);
          assert.equal(after.processCount, 0);
          assert.ok(after.registry.every(item => !item.exists), 'Uninstaller left product registry keys');
          for (const item of after.paths.filter(item => item.role !== 'installer-cache')) assert.equal(item.exists, false, 'Uninstaller left a shortcut or installation');
          const cache = after.paths.find(item => item.role === 'installer-cache');
          if (cache.exists) {
            assert.deepEqual(await fileIdentity(cache.path), { bytes: report.artifact.bytes, sha256: report.artifact.sha256 }, 'Refuse to clean a cache that is not the tested installer');
            await fs.unlink(cache.path);
            if (!windowsBefore.cacheDirectoryExists) await fs.rmdir(path.dirname(cache.path));
          }
          assertFreshWindowsState(await windowsState(guid));
          const installedLaunchVerified = report.nativeAcceptance.status === 'PASS_PACKAGED_SMOKE_ONLY' && report.payloadVerification.status === 'PASS' && report.packagedReaders.status === 'PASS';
          report.installer = { ...report.installer, tested: true, status: installedLaunchVerified ? 'PASS' : 'FAIL', installedLaunchVerified, installedExecutable: path.join(report.installer.installRoot, 'AgentVac.exe'), uninstaller: originalUninstaller, directoryRemoved: true, productRegistryRemoved: true, shortcutsRemoved: true };
          return report.installer;
        });
      } catch (error) { failure ||= error; report.installer.status = 'FAIL'; report.error ||= String(error.message); }
    }
    if (mounted) {
      try { await check('detach-owned-dmg', async () => { await execute('/usr/bin/hdiutil', ['detach', mounted], { timeout: 30000 }); return { detached: true }; }); }
      catch (error) { failure ||= error; report.error ||= String(error.message); }
    }
    if (report.artifact.sha256) {
      try { await check('artifact-after', async () => { report.artifactAfter = await fileIdentity(report.artifact.path); assert.deepEqual(report.artifactAfter, { bytes: report.artifact.bytes, sha256: report.artifact.sha256 }, 'Artifact bytes changed during acceptance'); return report.artifactAfter; }); }
      catch (error) { failure ||= error; report.error ||= String(error.message); }
    }
    if (!failure && spec.kind === 'setup' && report.installer.status !== 'PASS') failure = new Error('Real installer and uninstaller evidence missing');
    if (!failure && report.payloadVerification.status !== 'PASS') failure = new Error('Runtime payload binding missing');
    if (!failure && report.packagedReaders.status !== 'PASS') failure = new Error('Packaged conversation reader evidence missing');
    if (owned && !failure) {
      try { assert.ok(isWithin(await fs.realpath(os.tmpdir()), owned)); assert.ok(!(await fs.lstat(owned)).isSymbolicLink()); await fs.rm(owned, { recursive: true }); report.cleanup = { status: 'PASS', ownedTemporaryFilesRemoved: true }; }
      catch (error) { failure = error; report.cleanup = { status: 'FAIL', detail: String(error.message) }; }
    } else report.cleanup = { status: owned ? 'RETAINED_FOR_DIAGNOSIS' : 'NOT_CREATED', ownedRoot: owned || null };
    report.status = failure ? (failure instanceof CapabilityBlock ? 'BLOCKED' : 'FAIL') : 'PASS';
    report.finishedAt = new Date().toISOString();
    await save();
  }
  if (report.status === 'PASS') console.log(`${report.status}: ${path.join(out, 'result.json')}`);
  else console.error(JSON.stringify(packageFailureSummary(report, failure)));
  return report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(JSON.stringify(packageFailureSummary(null, error))); process.exitCode = 2; });
}
