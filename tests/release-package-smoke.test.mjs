import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASE_TARGETS, parseReleaseArgs, validateArchiveListing, installerArguments, assertFreshWindowsState, assertInstalledWindowsState, assertPackagedReaderEvidence, packageFailureSummary } from '../scripts/release-package-smoke.mjs';
import { PACKAGED_HELPERS, snapshotPayload, verifyPayload, validatePayloadManifest, bindRuntimePayload, parseArgs } from '../qa/packaged-acceptance/core.mjs';

const revision = 'a'.repeat(40), artifactSha256 = 'b'.repeat(64);
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentvac-release-smoke-unit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'payload'); await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'resources/app.asar.unpacked/dist-electron'), { recursive: true });
  await fs.writeFile(path.join(root, 'AgentVac.exe'), 'fixture executable');
  await fs.writeFile(path.join(root, 'resources/app.asar'), 'fixture asar');
  for (const helper of PACKAGED_HELPERS) await fs.writeFile(path.join(root, 'resources/app.asar.unpacked/dist-electron', helper), helper);
  const manifest = { schemaVersion: 1, sourceRevision: revision, artifactSha256, rootMode: 'exact', root, executable: 'AgentVac.exe', resources: 'resources', entries: await snapshotPayload(root), installer: false, allowedExtraFiles: [] };
  const runtime = { resourcesPath: path.join(root, 'resources'), execPath: path.join(root, 'AgentVac.exe'), appPath: path.join(root, 'resources/app.asar') };
  return { parent, root, manifest, runtime };
}

test('release targets require all seven exact v0.2.0 assets including NSIS setup and both DMGs', () => {
  assert.equal(Object.keys(RELEASE_TARGETS).length, 7);
  assert.equal(RELEASE_TARGETS['windows-setup'].artifact, 'windows/AgentVac-0.2.0-windows-x64-setup.exe');
  assert.equal(RELEASE_TARGETS['windows-portable'].candidate, 'windows-portable-built');
  assert.equal(Object.values(RELEASE_TARGETS).filter(spec => spec.kind === 'dmg').length, 2);
  assert.equal(new Set(Object.values(RELEASE_TARGETS).map(spec => spec.artifact)).size, 7);
});

test('release CLI accepts exact source identity and rejects unsupported, duplicate, preflight or launch flags', () => {
  assert.deepEqual(parseReleaseArgs(['--target', 'windows-setup', '--source-revision', revision]), { target: 'windows-setup', 'source-revision': revision });
  for (const args of [[], ['--target', 'windows-unpacked', '--source-revision', revision], ['--target', 'windows-setup', '--source-revision', 'main'], ['--target', 'linux-tar', '--source-revision', revision, '--preflight-only'], ['--target', 'linux-tar', '--source-revision', revision, '--no-sandbox'], ['--target', 'linux-tar', '--target', 'linux-tar', '--source-revision', revision]]) assert.throws(() => parseReleaseArgs(args));
});

test('portable candidate cannot run without explicit runtime payload binding', () => {
  const args = ['--target', 'windows-portable-built', '--candidate-executable', path.resolve('portable.exe'), '--candidate-id', revision];
  assert.throws(() => parseArgs(args), /manifest/);
  assert.equal(parseArgs([...args, '--payload-manifest', path.resolve('manifest.json')]).target, 'windows-portable-built');
  assert.throws(() => parseArgs([...args, '--payload-manifest', 'relative.json']));
});

test('archive listing rejects traversal, absolute paths and unrelated roots', () => {
  const root = 'AgentVac-0.2.0-linux-x64';
  assert.equal(validateArchiveListing(`${root}/\n${root}/./resources/app.asar\n`, root), 2);
  assert.equal(validateArchiveListing('AgentVac.app/Contents/Frameworks/Current\n', 'AgentVac.app'), 1);
  for (const value of ['', `/${root}/agentvac`, `${root}/../escape`, `C:/${root}/a`, `${root}\\escape`, 'wrong-root/file', `${root}/a\0b`]) assert.throws(() => validateArchiveListing(value, root));
});

test('NSIS arguments are per-user, silent, own-root-only, and keep the NSIS path last', () => {
  const root = path.resolve('generated temporary root'), installed = path.join(root, 'installed');
  assert.deepEqual(installerArguments(installed, root), ['/S', '/currentuser', `/D=${installed}`]);
  assert.deepEqual(installerArguments(installed, root, true), ['/S', '/currentuser', `_?=${installed}`]);
  for (const target of [root, path.resolve('outside/installed'), path.join(root, 'different'), path.join(root + '\n', 'installed')]) assert.throws(() => installerArguments(target, root));
});

function state() {
  const registry = [];
  for (const hive of ['CurrentUser', 'LocalMachine']) for (const view of ['Registry64', 'Registry32']) for (const key of ['Software\\fixture-guid', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\fixture-guid']) registry.push({ hive, view, key, exists: false });
  return { processCount: 0, registry, paths: Array.from({ length: 5 }, (_, i) => ({ role: `fixture-${i}`, exists: false })) };
}
test('installer guard rejects an existing installation, process, shortcut/cache, or incomplete observation', () => {
  assert.doesNotThrow(() => assertFreshWindowsState(state()));
  for (const mutate of [s => { s.processCount = 1; }, s => { s.registry[0].exists = true; }, s => { s.paths[2].exists = true; }, s => { s.registry.pop(); }, s => { s.paths.pop(); }]) {
    const value = state(); mutate(value); assert.throws(() => assertFreshWindowsState(value));
  }
});

test('uninstall guard demands the exact owned installation and registered per-user uninstaller', () => {
  const root = path.resolve('generated/installed'), value = state();
  value.registry[0] = { ...value.registry[0], exists: true, installLocation: root };
  value.registry[1] = { ...value.registry[1], exists: true, uninstallerPath: path.join(root, 'Uninstall AgentVac.exe'), uninstallMode: '/currentuser' };
  assert.doesNotThrow(() => assertInstalledWindowsState(value, root));
  for (const mutate of [s => { s.processCount = 1; }, s => { s.registry[0].installLocation = path.resolve('existing'); }, s => { s.registry[1].uninstallMode = '/allusers'; }, s => { s.registry[1].uninstallerPath = path.resolve('foreign-uninstaller.exe'); }, s => { s.registry[0].hive = 'LocalMachine'; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => assertInstalledWindowsState(changed, root));
  }
});

test('full runtime payload binds executable, ASAR, all four helpers and every extra shipped file', async t => {
  const { root, manifest, runtime } = await fixture(t);
  assert.equal(manifest.entries.length, 6);
  assert.equal(PACKAGED_HELPERS.length, 4);
  assert.equal((await bindRuntimePayload(runtime, manifest)).status, 'PASS');
  await fs.writeFile(path.join(root, 'resources/app.asar.unpacked/dist-electron/cursor-sql-worker.cjs'), 'changed fixture');
  await assert.rejects(verifyPayload(root, manifest), /differ/);
});

test('an unpacked candidate cannot impersonate an extracted, installed or portable runtime', async t => {
  const { parent, root, manifest, runtime } = await fixture(t);
  const wrongRoot = path.join(parent, 'other'); await fs.mkdir(wrongRoot);
  await assert.rejects(bindRuntimePayload(runtime, { ...manifest, root: wrongRoot }), /prepared\/installed/);
  await assert.rejects(bindRuntimePayload(runtime, { ...manifest, rootMode: 'inside', root }), /generated temp/);
  assert.equal((await bindRuntimePayload(runtime, { ...manifest, rootMode: 'inside', root: parent })).status, 'PASS');
  await assert.rejects(bindRuntimePayload({ ...runtime, execPath: path.join(root, 'other.exe') }, manifest), /Unexpected running executable/);
  await assert.rejects(bindRuntimePayload({ ...runtime, appPath: path.join(root, 'different.asar') }, manifest), /Unexpected loaded ASAR/);
});

test('missing helpers, duplicate paths and traversal invalidate a manifest', async t => {
  const { manifest } = await fixture(t);
  for (const helper of PACKAGED_HELPERS) assert.throws(() => validatePayloadManifest({ ...manifest, entries: manifest.entries.filter(e => !e.relative.endsWith('/' + helper)) }), /Missing required/);
  assert.throws(() => validatePayloadManifest({ ...manifest, entries: [...manifest.entries, manifest.entries[0]] }), /Duplicate/);
  assert.throws(() => validatePayloadManifest({ ...manifest, entries: [...manifest.entries, { relative: '../escape', kind: 'file', bytes: 1, sha256: artifactSha256 }] }));
  assert.throws(() => validatePayloadManifest({ ...manifest, artifactSha256: 'unverified' }));
  assert.throws(() => validatePayloadManifest({ ...manifest, sourceRevision: 'branch-name' }));
});

test('only the generated regular uninstaller may be an extra installed payload file', async t => {
  const { root, manifest } = await fixture(t);
  const installed = { ...manifest, installer: true, allowedExtraFiles: ['Uninstall AgentVac.exe'] };
  await fs.writeFile(path.join(root, 'Uninstall AgentVac.exe'), 'generated fixture');
  assert.equal((await verifyPayload(root, installed)).status, 'PASS');
  await assert.rejects(verifyPayload(root, manifest), /differ/);
  await fs.writeFile(path.join(root, 'unexpected.dll'), 'extra fixture');
  await assert.rejects(verifyPayload(root, installed), /differ/);
  assert.throws(() => validatePayloadManifest({ ...installed, allowedExtraFiles: ['unexpected.dll'] }));
});

test('payload snapshots retain internal links and reject escaped links without following them', async t => {
  const { parent, root } = await fixture(t);
  try { await fs.symlink('AgentVac.exe', path.join(root, 'linked.exe')); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows runner cannot create a test symlink without changing privileges'); throw error; }
  const entries = await snapshotPayload(root);
  assert.deepEqual(entries.find(e => e.relative === 'linked.exe'), { relative: 'linked.exe', kind: 'symlink', target: 'AgentVac.exe' });
  await fs.writeFile(path.join(parent, 'outside'), 'outside fixture');
  await fs.symlink('../outside', path.join(root, 'escape'));
  await assert.rejects(snapshotPayload(root), /escapes root/);
});

function readers(platform) {
  return {
    sourceRevision: revision, platform, arch: 'x64', status: platform === 'win32' ? 'PASS_WITH_LIMITATIONS' : 'PASS', packagedArtifactTested: true,
    packagePayloadBinding: { status: 'PASS', artifactSha256 }, sourcesUnchanged: true, builtUnchanged: true, errors: [], cleanup: { appClosed: true, profileRemoved: true },
    checks: [
      ...['codex', 'claude-code', 'cline', 'cursor'].map(provider => provider === 'cursor' && platform === 'win32'
        ? { provider, status: 'UNSUPPORTED', reason: 'WINDOWS_CURSOR_IDE_DISABLED_0_2', disabledGateVerified: true, consentRefused: true, listRefused: true, noSnapshotCreated: true, sourceUnchanged: true }
        : { provider, status: 'PASS', lateContentSearch: true, fullUnicodePaging: true, actualTimestamp: true, consentBeforeRead: true, revokeInvalidates: true }),
      ...['cline', 'cursor'].map(provider => ({ provider, source: 'explicit-read-only', status: 'PASS', newConsent: true, cleanupRootUnchanged: true, archiveDisabled: true, resetRevokes: true })),
    ],
  };
}
test('packaged reader gate requires exact package binding and actual shipped-worker reader cases', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const receipt = readers(platform), spec = { platform, arch: 'x64' };
    assert.doesNotThrow(() => assertPackagedReaderEvidence(receipt, spec, revision, artifactSha256));
    for (const mutate of [r => { r.packagedArtifactTested = false; }, r => { r.packagePayloadBinding.artifactSha256 = 'c'.repeat(64); }, r => { r.sourceRevision = 'c'.repeat(40); }, r => { r.checks.pop(); }, r => { r.checks[0].revokeInvalidates = false; }, r => { r.status = 'FAIL'; }, r => { r.cleanup.appClosed = false; }, r => { r.cleanup.profileRemoved = false; }]) {
      const changed = structuredClone(receipt); mutate(changed); assert.throws(() => assertPackagedReaderEvidence(changed, spec, revision, artifactSha256));
    }
  }
});
test('Windows limited receipt proves disabled IDE DB without promoting it to shipped SQLite success', () => {
  const spec = { platform: 'win32', arch: 'x64' }, receipt = readers('win32');
  for (const mutate of [r => { r.checks[3].status = 'PASS'; }, r => { r.checks[3].noSnapshotCreated = false; }, r => { r.checks[5].status = 'UNSUPPORTED'; }, r => { r.status = 'PASS'; }]) {
    const changed = structuredClone(receipt); mutate(changed); assert.throws(() => assertPackagedReaderEvidence(changed, spec, revision, artifactSha256));
  }
});

test('package failure console receipt preserves actionable stage/status while excluding raw errors and nested data', () => {
  const secret = 'SECRET_FIXTURE_TOKEN /private/user/path --raw-argument {"source":"sensitive fixture"}';
  const error = Object.assign(new Error(secret), { stack: secret, stdout: secret, stderr: secret, code: 'ERR_ASSERTION', expected: true, actual: { source: secret } });
  const summary = packageFailureSummary({ target: 'windows-setup', status: 'FAIL', error: secret, checks: { 'artifact-before': { status: 'PASS' }, 'actual-package-native-smoke': { status: 'FAIL', detail: secret } }, nativeAcceptance: { status: 'FAIL', failedCheck: 'generated-fixture-roundtrip', report: secret }, environment: { SECRET: secret }, argv: [secret] }, error);
  assert.deepEqual(summary, { target: 'windows-setup', status: 'FAIL', failedCheck: 'actual-package-native-smoke', category: 'ASSERTION_MISMATCH', errorCode: 'ERR_ASSERTION', expected: true, nestedFailedCheck: 'generated-fixture-roundtrip', expectedStatus: 'PASS_PACKAGED_SMOKE_ONLY', actualStatus: 'FAIL' });
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.ok(JSON.stringify(summary).length < 512);
});

test('failure diagnostics reject unrecognized labels, string assertions, control characters and large nested payloads', () => {
  const secret = 'do-not-print\n/real/path\u001b[31m' + 'x'.repeat(20000);
  const report = { target: secret, status: secret, checks: { [secret]: { status: 'FAIL', detail: secret } }, nativeAcceptance: { status: secret, failedCheck: secret } };
  const result = packageFailureSummary(report, { message: secret, code: secret, expected: [secret], actual: secret });
  assert.deepEqual(result, { target: 'UNKNOWN', status: 'FAIL', failedCheck: 'release-preparation-or-finalization', category: 'CHECK_FAILED' });
  const assertion = packageFailureSummary({ target: 'linux-tar', status: 'FAIL', checks: { 'prepared-payload-byte-identity': { status: 'FAIL' } } }, { code: 'ERR_ASSERTION', expected: secret, actual: secret });
  assert.equal(Object.hasOwn(assertion, 'expected'), false); assert.equal(Object.hasOwn(assertion, 'actual'), false);
});

test('failure diagnostics retain safe subprocess and filesystem codes and known reader outcomes', () => {
  const report = { target: 'windows-setup', status: 'FAIL', checks: { 'silent-install': { status: 'FAIL' } } };
  assert.equal(packageFailureSummary(report, { code: 1603, stdout: 'private', stderr: 'private' }).exitCode, 1603);
  assert.equal(packageFailureSummary(report, { code: 'ENOENT', path: 'private' }).errorCode, 'ENOENT');
  const reader = packageFailureSummary({ ...report, checks: { 'actual-package-conversation-readers': { status: 'FAIL' } }, packagedReaders: { nativeOutcome: 'FAIL', failedCheck: 'reader-cursor-explicit-read-only' } }, new Error('private'));
  assert.equal(reader.expectedStatus, 'PASS_WITH_LIMITATIONS'); assert.equal(reader.actualStatus, 'FAIL');
  assert.equal(reader.nestedFailedCheck, 'reader-cursor-explicit-read-only');
  assert.equal(packageFailureSummary({ ...report, cleanup: { status: 'FAIL' }, checks: {} }, {}).failedCheck, 'temporary-cleanup');
});

test('top-level CLI rejection emits only the bounded diagnostic receipt and stays nonzero', () => {
  const secret = '--PRIVATE_TEST_SENTINEL=/private/user/path';
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-package-smoke.mjs', import.meta.url)), secret], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  const receipt = JSON.parse(result.stderr.trim());
  assert.equal(receipt.target, 'UNKNOWN'); assert.equal(receipt.failedCheck, 'harness-initialization');
  assert.equal(receipt.category, 'ASSERTION_MISMATCH'); assert.equal(receipt.status, 'FAIL');
  assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes('/private/user/path'));
});
