import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TARGETS, CapabilityBlock, classifyLaunchError, recordCheck, parseArgs, resolveInput, assertNativeHost, isolatedEnv, assertArchiveEntries, binaryHeader, inspectExecutable, assertRuntime, fixturePath, fixtureDigest, summarize } from '../core.mjs';
const spec = TARGETS['linux-tar'];
const host = { platform: 'linux', arch: 'x64', display: ':77' };
const runtime = { packaged: true, platform: 'linux', arch: 'x64', userData: '/owned/profile', appPath: '/owned/extracted/resources/app.asar', windows: 1, visible: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, disabledProtectionSwitches: [], argv: ['/owned/agentvac', '--user-data-dir=/owned/profile'] };
function elf(arch = 'x64') { const b = Buffer.alloc(128); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); b.writeUInt16LE(arch === 'x64' ? 62 : 183, 18); return b; }
function pe(arch = 'x64') { const b = Buffer.alloc(128); b.writeUInt16LE(0x5a4d); b.writeUInt32LE(64, 0x3c); b.writeUInt32LE(0x4550, 64); b.writeUInt16LE(arch === 'x64' ? 0x8664 : 0x14c, 68); return b; }
function mach(arch) { const b = Buffer.alloc(128); b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(arch === 'x64' ? 0x1000007 : 0x100000c, 4); return b; }

test('exact frozen targets include native Mac architectures and separate Windows bootstrap/payload', () => {
  assert.equal(Object.values(TARGETS).filter(value => !value.candidateOnly).length, 6);
  assert.equal(TARGETS['windows-portable'].arch, 'x64');
  assert.equal(TARGETS['windows-portable'].launcherArch, 'ia32');
  assert.equal(TARGETS['windows-unpacked'].type, 'unpacked-payload');
  assert.equal(TARGETS['macos-arm64'].arch, 'arm64');
  assert.equal(TARGETS['macos-x64'].arch, 'x64');
  assert.ok(Object.values(TARGETS).every(v => !v.type.includes('installer')));
});
test('check recorder returns prepared executable and persists success/failure/block without masking them', async () => {
  const checks = {}; let saves = 0;
  const prepared = { executable: '/owned/agentvac' };
  assert.equal(await recordCheck(checks, 'prepare', async () => prepared, async () => { saves++; }), prepared);
  assert.equal(checks.prepare.status, 'PASS');
  await assert.rejects(recordCheck(checks, 'failed', async () => { throw new Error('fixture failure'); }, async () => { saves++; }), /fixture failure/);
  await assert.rejects(recordCheck(checks, 'blocked', async () => { throw new CapabilityBlock('no display'); }, async () => { saves++; }), /no display/);
  assert.equal(checks.failed.status, 'FAIL');
  assert.equal(checks.blocked.status, 'BLOCKED');
  assert.equal(saves, 3);
});
test('only explicit AppImage FUSE errors become capability blocks; unrelated failures stay failures', () => {
  const fuse = new Error('dlopen(): error loading libfuse.so.2');
  assert.ok(classifyLaunchError(fuse, TARGETS['linux-appimage']) instanceof CapabilityBlock);
  assert.equal(classifyLaunchError(fuse, spec), fuse);
  const failure = new Error('preload initialization failed');
  assert.equal(classifyLaunchError(failure, TARGETS['linux-appimage']), failure);
});
test('CLI accepts only explicit target and bounded options', () => assert.deepEqual(parseArgs(['--target', 'linux-tar', '--preflight-only']), { target: 'linux-tar', 'preflight-only': true }));
test('native candidate executable carries separate provenance without frozen identity claims', () => {
  const executable = path.resolve('/owned/candidate/release/linux-unpacked/agentvac');
  const args = parseArgs(['--target', 'linux-unpacked', '--candidate-executable', executable, '--candidate-id', 'a123456789']);
  const input = resolveInput(args, '/unused-release');
  assert.equal(input.artifact, executable);
  assert.equal(input.provenance.kind, 'native-built-candidate');
  assert.equal(input.provenance.candidateId, 'a123456789');
  assert.equal(input.provenance.frozenArchiveByteIdentity, 'NOT_ASSERTED');
  assert.equal(resolveInput(parseArgs(['--target', 'linux-tar']), '/frozen').provenance.kind, 'frozen-release-input');
});
for (const args of [
  ['--target', 'linux-unpacked'],
  ['--target', 'linux-unpacked', '--candidate-executable', 'relative'],
  ['--target', 'linux-tar', '--candidate-executable', path.resolve('/owned/bin'), '--candidate-id', 'abc123'],
  ['--target', 'windows-portable', '--candidate-executable', path.resolve('/owned/bin'), '--candidate-id', 'abc123'],
  ['--target', 'linux-unpacked', '--candidate-executable', path.resolve('/owned/bin')],
  ['--target', 'linux-unpacked', '--candidate-executable', path.resolve('/owned/bin'), '--candidate-id', 'abc123', '--release-root', '/frozen'],
]) test(`reject ambiguous candidate input ${JSON.stringify(args)}`, () => assert.throws(() => parseArgs(args)));
for (const args of [[], ['--target', 'windows-installer'], ['--target', 'macos-dmg'], ['--target', 'linux-tar', '--no-sandbox'], ['--target'], ['--target', '--preflight-only'], ['--target', 'linux-tar', '--target', 'linux-appimage'], ['--target', 'linux-tar', '--preflight-only', '--preflight-only']])
  test(`reject unsafe/ambiguous CLI ${JSON.stringify(args)}`, () => assert.throws(() => parseArgs(args)));
test('native host supports exact architecture on available display', () => assert.doesNotThrow(() => assertNativeHost(spec, host)));
for (const value of [{ ...host, platform: 'win32' }, { ...host, arch: 'arm64' }, { ...host, translated: true }, { ...host, display: '' }])
  test(`block native host ${JSON.stringify(value)}`, () => assert.throws(() => assertNativeHost(spec, value), { name: 'CapabilityBlock' }));
test('safe environment keeps HOME/XDG/display and strips source, injection and extraction fallbacks', () => {
  const source = { HOME: '/real/home', XDG_DATA_HOME: '/real/xdg', DISPLAY: ':77', NODE_OPTIONS: '--require=bad.cjs', ELECTRON_RUN_AS_NODE: '1', ELECTRON_DISABLE_SANDBOX: '1', ELECTRON_EXTRA_LAUNCH_ARGS: '--no-sandbox', AGENTVAC_TEST_USER_DATA: '/real/profile', AGENTVAC_DEV_URL: 'http://localhost:5173', APPIMAGE_EXTRACT_AND_RUN: '1', PORTABLE_EXECUTABLE_DIR: '/unexpected', CODEX_HOME: '/real/codex' };
  const env = isolatedEnv(source, '/owned/profile');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'DISPLAY']) assert.equal(env[key], source[key]);
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'ELECTRON_EXTRA_LAUNCH_ARGS', 'AGENTVAC_TEST_USER_DATA', 'AGENTVAC_DEV_URL', 'APPIMAGE_EXTRACT_AND_RUN', 'PORTABLE_EXECUTABLE_DIR']) assert.equal(env[key], undefined);
  assert.equal(env.CODEX_HOME, path.join('/owned/profile', 'empty-codex-home'));
  assert.equal(source.NODE_OPTIONS, '--require=bad.cjs');
});
test('archive paths permit Framework entries and the expected tar root', () => {
  assert.equal(assertArchiveEntries('agentvac-0.1.0/\nagentvac-0.1.0/resources/app.asar\n', 'tar-portable'), 2);
  assert.equal(assertArchiveEntries('AgentVac.app/Contents/Frameworks/Electron Framework.framework/Versions/Current\n', 'app-zip'), 1);
});
for (const bad of ['', '/agentvac-0.1.0/evil', 'agentvac-0.1.0/../../escape', 'C:/agentvac-0.1.0/evil', 'agentvac-0.1.0\\evil', 'other-root/file'])
  test(`reject archive entry ${JSON.stringify(bad)}`, () => assert.throws(() => assertArchiveEntries(bad, 'tar-portable')));
for (const [buffer, expected] of [[elf(), { format: 'ELF', arch: 'x64' }], [elf('arm64'), { format: 'ELF', arch: 'arm64' }], [pe(), { format: 'PE', arch: 'x64' }], [pe('ia32'), { format: 'PE', arch: 'ia32' }], [mach('x64'), { format: 'Mach-O', arch: 'x64' }], [mach('arm64'), { format: 'Mach-O', arch: 'arm64' }]])
  test(`decode native executable ${expected.format}/${expected.arch}`, () => assert.deepEqual(binaryHeader(buffer), expected));
test('reject source input and malformed executable headers', () => {
  assert.throws(() => binaryHeader(Buffer.from('console.log("source")')));
  assert.throws(() => binaryHeader(Buffer.alloc(128)));
  const truncated = pe(); truncated.writeUInt32LE(0xffff, 0x3c);
  assert.throws(() => binaryHeader(truncated), /outside inspected/);
});
test('runtime proves packaged preload window and isolated native architecture', () => assert.doesNotThrow(() => assertRuntime(runtime, spec, '/owned/profile')));
for (const change of [{ packaged: false }, { userData: '/real/profile' }, { arch: 'ia32' }, { appPath: '/source' }, { windows: 2 }, { visible: false }, { sandbox: false }, { contextIsolation: false }, { nodeIntegration: true }, { webSecurity: false }, { disabledProtectionSwitches: ['no-sandbox'] }, { argv: ['--no-sandbox'] }, { argv: ['--disable-setuid-sandbox'] }, { argv: ['--disable-web-security=true'] }, { argv: ['--single-process'] }])
  test(`reject unsafe runtime ${JSON.stringify(change)}`, () => assert.throws(() => assertRuntime({ ...runtime, ...change }, spec, '/owned/profile')));
test('fixture paths stay below the fresh owned root', () => {
  assert.equal(fixturePath('/owned/demo', 'log/demo.log.1'), path.resolve('/owned/demo/log/demo.log.1'));
  for (const relative of ['../escape', '/absolute', 'C:/escape', 'log/../../escape', 'log\\escape', '']) assert.throws(() => fixturePath('/owned/demo', relative));
});
test('real fixture digest and executable inspection preserve bytes and reject symlink/hardlink paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentvac-acceptance-unit-'));
  try {
    await fs.mkdir(path.join(root, 'log'));
    await fs.writeFile(path.join(root, 'log/fixture.log'), 'fixture-only\n');
    const initial = await fixtureDigest(root, 'log/fixture.log');
    assert.equal(initial.bytes, 13);
    assert.equal(initial.sha256.length, 64);
    assert.deepEqual(await fixtureDigest(root, 'log/fixture.log'), initial);
    await fs.writeFile(path.join(root, 'native'), elf());
    assert.deepEqual(await inspectExecutable(path.join(root, 'native')), { format: 'ELF', arch: 'x64', bytes: 128 });
    await fs.link(path.join(root, 'log/fixture.log'), path.join(root, 'hardlink'));
    await assert.rejects(fixtureDigest(root, 'hardlink'), /owned plain file/);
    // Windows may legitimately forbid creating symlinks without privileges. No privilege escalation.
    let linked = false;
    try { await fs.symlink(path.join(root, 'log'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    if (linked) await assert.rejects(fixtureDigest(root, 'linked/fixture.log'), /plain directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('result classifier cannot promote preflight, block, skip or untested checks to a native pass', () => {
  const pass = { one: { status: 'PASS' }, two: { status: 'PASS' } };
  assert.equal(summarize(pass, false), 'PASS_PACKAGED_SMOKE_ONLY');
  assert.equal(summarize(pass, true), 'NOT_RUN_PREFLIGHT_ONLY');
  for (const status of ['UNTESTED', 'SKIP']) assert.equal(summarize({ ...pass, extra: { status } }, false), 'INCOMPLETE');
  assert.equal(summarize({}, false), 'INCOMPLETE');
  assert.equal(summarize({ ...pass, extra: { status: 'BLOCKED' } }, false), 'BLOCKED');
  assert.equal(summarize({ ...pass, extra: { status: 'FAIL' } }, false), 'FAIL');
});
