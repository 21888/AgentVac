import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as observer from './observer.mjs';
import { bundleSource, sourceRoutingPlugin, prepare } from './prepare.mjs';
import { HELPER, RUNTIME_FILES, sha256, verifyArtifacts, verifySource } from './pins.mjs';
import { blockedReceipt, receiptExitCode, runFixedSequence, runReviewedWindows } from './run.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(root, '../..');
const sourceRoot = existsSync(path.join(repositoryRoot, 'SOURCE-SHA256.json'))
  ? repositoryRoot : path.join(repositoryRoot, 'AgentVac-recovery-native-validation-dev');
const require = createRequire(path.join(sourceRoot, 'package.json'));
const esbuild = require('esbuild');
const lock = JSON.parse(await readFile(path.join(root, 'source-lock.json'), 'utf8'));
const source = await verifySource(sourceRoot, lock);
const bundle = await readFile(path.join(root, 'helper.observed.mjs'));
const originalCode = (await esbuild.transform(source, { loader: 'ts', format: 'cjs', target: 'node22' })).code;
const observedCode = (await esbuild.transform(bundle.toString('utf8'), { loader: 'js', format: 'cjs', target: 'node22' })).code;
const fixtureEnv = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\UserSynthetic',
  APPDATA: 'C:\\UserSynthetic\\Roaming', LOCALAPPDATA: 'C:\\UserSynthetic\\Local',
  TEMP: 'C:\\TempSynthetic', TMP: 'C:\\TempSynthetic' };
const target = 'C:\\TempSynthetic\\agentvac-acl-startup-A1';
const canary = 'NEVER_EMIT_CANARY_C:\\Private\\secret_S-1-5-21-1234_TOKEN=private';
const privateAcl = { localityVerified: true, currentUserSid: 'S-1-5-21-1', ownerSid: 'S-1-5-21-1',
  canonical: true, entries: [{ sid: 'S-1-5-21-1', rights: 3, type: 'allow', inherited: true, inheritance: 3, propagation: 0 }] };

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kills = 0;
  child.close = (code, signal = null) => {
    child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.kill = () => { child.kills++; queueMicrotask(() => child.close(null, 'SIGTERM')); return true; };
  return child;
}

function compileHarness(observed, nativeSpawn, env = fixtureEnv) {
  const module = { exports: {} };
  const timers = [];
  const sandbox = {
    module, exports: module.exports, Buffer, TextDecoder, AbortController,
    process: { platform: 'win32', env }, performance: { now: () => 0 },
    setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
    require: (name) => {
      if (name === 'node:child_process') return { spawn: nativeSpawn };
      if (name === 'node:path') return path;
      if (name === './observer.mjs') return observer;
      throw new Error('BLOCKED_TEST_IMPORT');
    },
  };
  vm.runInNewContext(observed ? observedCode : originalCode, sandbox);
  return { helper: module.exports, timers };
}

function expectedFor(helper, mode = 'acl', candidate = target, env = fixtureEnv) {
  return observer.expectedLaunch(helper.canonicalizeCursorSnapshotWindowsPath,
    observer.filteredInputs(env), candidate, mode, lock);
}
function tupleFor(expected) {
  const script = source.match(/const SCRIPT = String.raw`([\s\S]*?)`;/)[1];
  return [expected.executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: expected.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...expected.env } }];
}
const baseHelper = compileHarness(false, () => { throw new Error('NO_NATIVE_SPAWN'); }).helper;

test('frozen helper, manifest, script and bundle are pinned; build is deterministic', async () => {
  assert.equal(source.length > 0, true);
  assert.equal((await verifyArtifacts(root)).format, 'agentvac-acl-startup-artifacts-v1');
  assert.equal(sha256(await bundleSource(esbuild, source)), sha256(bundle));
  const input = await mkdtemp(path.join(root, 'test-source-'));
  try {
    await mkdir(path.join(input, 'electron/conversations'), { recursive: true });
    await writeFile(path.join(input, HELPER), source);
    await writeFile(path.join(input, 'SOURCE-SHA256.json'), await readFile(path.join(sourceRoot, 'SOURCE-SHA256.json')));
    assert.equal(await verifySource(input, lock), source);
    await writeFile(path.join(input, HELPER), source + '\n');
    await assert.rejects(verifySource(input, lock), /SOURCE_PIN/);
    await writeFile(path.join(input, HELPER), source);
    await assert.rejects(verifySource(input, { ...lock, scriptSha256: '0'.repeat(64) }), /SCRIPT_PIN/);
    await writeFile(path.join(input, 'SOURCE-SHA256.json'), '{}');
    await assert.rejects(verifySource(input, lock), /SOURCE_PIN/);
  } finally { await rm(input, { recursive: true }); }
});

test('only the exact helper import is substituted; unknown routing fails closed', async () => {
  let resolve;
  sourceRoutingPlugin(source).setup({ onResolve: (_, fn) => { resolve = fn; }, onLoad: () => {} });
  assert.equal(resolve({ kind: 'import-statement', path: 'node:child_process', namespace: 'frozen', importer: 'frozen-helper.ts' }).namespace, 'adapter');
  assert.equal(resolve({ kind: 'import-statement', path: 'node:child_process', namespace: 'adapter', importer: 'spawn-adapter.mjs' }).external, true);
  for (const args of [
    { path: 'node:child_process', namespace: 'frozen', importer: 'another.ts' },
    { path: 'child_process', namespace: 'frozen', importer: 'frozen-helper.ts' },
    { path: 'node:fs', namespace: 'frozen', importer: 'frozen-helper.ts' },
    { path: './observer.mjs', namespace: 'frozen', importer: 'frozen-helper.ts' },
    { path: 'node:path', namespace: 'adapter', importer: 'spawn-adapter.mjs' },
  ]) assert.equal(resolve(args).errors[0].text, 'BLOCKED_SOURCE_ROUTING');
  await assert.rejects(bundleSource(esbuild, source + '\nimport "node:fs";'), /BLOCKED_SOURCE_ROUTING/);
});

test('runtime pin rejects a modified bundle or changed runtime artifact list', async () => {
  const copy = await mkdtemp(path.join(root, 'test-artifact-'));
  try {
    for (const name of [...RUNTIME_FILES, 'artifact-lock.json'])
      await writeFile(path.join(copy, name), await readFile(path.join(root, name)));
    assert.equal((await verifyArtifacts(copy)).format, 'agentvac-acl-startup-artifacts-v1');
    await writeFile(path.join(copy, 'helper.observed.mjs'), Buffer.concat([bundle, Buffer.from('\n')]));
    await assert.rejects(verifyArtifacts(copy), /ARTIFACT_PIN/);
    await writeFile(path.join(copy, 'helper.observed.mjs'), bundle);
    const altered = JSON.parse(await readFile(path.join(copy, 'artifact-lock.json'), 'utf8'));
    delete altered.files['observer.mjs'];
    await writeFile(path.join(copy, 'artifact-lock.json'), JSON.stringify(altered));
    await assert.rejects(verifyArtifacts(copy), /ARTIFACT_PIN/);
  } finally { await rm(copy, { recursive: true }); }
});

test('hosted prepare checks reviewed pins, rebuilds the bundle, and never rewrites its trust lock', async () => {
  const copy = await mkdtemp(path.join(root, 'test-prepare-'));
  try {
    for (const name of [...RUNTIME_FILES.filter((v) => v !== 'helper.observed.mjs'), 'artifact-lock.json'])
      await writeFile(path.join(copy, name), await readFile(path.join(root, name)));
    const before = await readFile(path.join(copy, 'artifact-lock.json'));
    assert.equal((await prepare(sourceRoot, copy)).status, 'PREPARED_SOURCE_ONLY');
    assert.equal(sha256(await readFile(path.join(copy, 'artifact-lock.json'))), sha256(before));
    assert.equal(sha256(await readFile(path.join(copy, 'helper.observed.mjs'))), sha256(bundle));
    await writeFile(path.join(copy, 'observer.mjs'), '// changed');
    await assert.rejects(prepare(sourceRoot, copy), /ARTIFACT_PIN/);
    assert.equal(sha256(await readFile(path.join(copy, 'artifact-lock.json'))), sha256(before));
  } finally { await rm(copy, { recursive: true }); }
});

test('a changed publication manifest is allowed only with exactly one pinned helper record', async () => {
  const copy = await mkdtemp(path.join(root, 'test-manifest-'));
  try {
    await mkdir(path.join(copy, 'electron/conversations'), { recursive: true });
    await writeFile(path.join(copy, HELPER), source);
    const record = { path: HELPER, sha256: lock.helperSha256, bytes: lock.helperBytes };
    await writeFile(path.join(copy, 'SOURCE-SHA256.json'), JSON.stringify({ sourceDigest: 'new-publication', files: [record] }));
    assert.equal(await verifySource(copy, lock), source);
    await writeFile(path.join(copy, 'SOURCE-SHA256.json'), JSON.stringify({ files: [record, record] }));
    await assert.rejects(verifySource(copy, lock), /SOURCE_PIN/);
  } finally { await rm(copy, { recursive: true }); }
});

test('streaming token enums survive every chunk boundary without raw retention', () => {
  const bytes = Buffer.from(canary + '\nLoading managed Windows PowerShell failed with error 0x8009001D.\n');
  for (let split = 0; split <= bytes.length; split++) {
    const scanner = observer.createTokenScanner();
    scanner.push(bytes.subarray(0, split)); scanner.push(bytes.subarray(split)); scanner.finish();
    const result = scanner.snapshot();
    assert.deepEqual(result.familyTokens, ['MANAGED_POWERSHELL_LOAD']);
    assert.deepEqual(result.hresultTokens, ['H8009001D']);
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
});

test('HRESULT tokens require hexadecimal boundaries; unknown/localized/binary output stays unknown', () => {
  for (const text of [canary, '8009001d0', 'f8009001d', '0x8009001d0', '错误 0xdeadbeef', '\u0000\ufffd\ud800']) {
    const scanner = observer.createTokenScanner(); scanner.push(Buffer.from(text)); scanner.finish();
    assert.deepEqual(scanner.snapshot().familyTokens, []);
    assert.deepEqual(scanner.snapshot().hresultTokens, []);
    assert.equal(JSON.stringify(scanner.snapshot()).includes(canary), false);
  }
  const scanner = observer.createTokenScanner();
  for (const byte of Buffer.from('8009001d')) scanner.push(Buffer.from([byte]));
  scanner.finish(); assert.deepEqual(scanner.snapshot().hresultTokens, ['H8009001D']);
});

for (const encoding of ['UTF16LE', 'UTF16BE']) test(`fixed ${encoding} patterns, boundaries and CLIXML preamble across byte splits`, () => {
  const encode = (text) => {
    const bytes = Buffer.from(text, 'utf16le'); return encoding === 'UTF16BE' ? bytes.swap16() : bytes;
  };
  const bytes = encode('\uFEFF#< CLIXML\r\n<S>Loading managed Windows PowerShell failed with error 0x8009001D.</S>' + canary);
  for (let split = 0; split <= bytes.length; split++) {
    const scanner = observer.createTokenScanner();
    scanner.push(bytes.subarray(0, split)); scanner.push(bytes.subarray(split)); scanner.finish();
    const out = scanner.snapshot();
    assert.deepEqual(out.familyTokens, ['MANAGED_POWERSHELL_LOAD']);
    assert.deepEqual(out.hresultTokens, ['H8009001D']);
    assert.ok(out.matchedEncodings.includes(encoding));
    assert.ok(out.encodingPreambles.includes(`${encoding}_BOM`));
    assert.ok(out.encodingPreambles.includes(`CLIXML_${encoding}`));
    assert.equal(JSON.stringify(out).includes(canary), false);
  }
  for (const text of ['f8009001d', '8009001d0', '0xdeadbeef']) {
    const scanner = observer.createTokenScanner(); scanner.push(encode(text)); scanner.finish();
    assert.deepEqual(scanner.snapshot().hresultTokens, []);
  }
  const scanner = observer.createTokenScanner();
  for (const b of encode('8009001d')) scanner.push(Buffer.from([b]));
  scanner.finish(); assert.deepEqual(scanner.snapshot().hresultTokens, ['H8009001D']);
});

test('unknown UTF16 text reports only fixed encoding evidence and bounded zero-byte counts', () => {
  const scanner = observer.createTokenScanner(); scanner.push(Buffer.from('\uFEFF' + canary, 'utf16le')); scanner.finish();
  const out = scanner.snapshot();
  assert.deepEqual(out.familyTokens, []); assert.deepEqual(out.hresultTokens, []);
  assert.deepEqual(out.encodingPreambles, ['UTF16LE_BOM']);
  assert.ok(out.zeroOddBytes > 0); assert.equal(JSON.stringify(out).includes(canary), false);
});

test('stream bounds do not retain unbounded output or accept beyond-limit token suffixes', () => {
  const scanner = observer.createTokenScanner();
  scanner.push(Buffer.alloc(observer.LIMITS.stderr - 8, 32));
  scanner.push(Buffer.from('8009001d0' + canary)); scanner.finish();
  assert.deepEqual(scanner.snapshot().hresultTokens, []);
  assert.equal(scanner.snapshot().scannedBytes, observer.LIMITS.stderr);
  assert.equal(scanner.snapshot().truncated, true);
  const huge = observer.createTokenScanner();
  huge.push(Buffer.alloc(1024 * 1024, 120)); huge.push(Buffer.from('error 8009001d.'));
  assert.equal(huge.snapshot().scannedBytes, observer.LIMITS.stderr);
  assert.deepEqual(huge.snapshot().hresultTokens, []);
});

test('observer forwards exact argument references, receiver, and child identity without mutation', async () => {
  const expected = expectedFor(baseHelper); const tuple = tupleFor(expected);
  Object.freeze(tuple[1]); Object.freeze(tuple[2].stdio); Object.freeze(tuple[2].env); Object.freeze(tuple[2]); Object.freeze(tuple);
  const child = fakeChild(); const receiver = {}; const seen = [];
  const observation = observer.createObservation(expected);
  const returned = observation.spawn(function (...args) {
    assert.equal(this, receiver);
    args.forEach((value, i) => assert.equal(value, tuple[i])); seen.push(true); return child;
  }, receiver, tuple);
  assert.equal(returned, child); assert.equal(seen.length, 1);
  child.stdout.emit('data', Buffer.from(JSON.stringify({ ...privateAcl, secret: canary })));
  child.stderr.emit('data', Buffer.from(canary));
  child.close(4294901760); await observation.awaitReaping();
  const out = observation.snapshot();
  assert.equal(out.identicalTupleForwarded, true); assert.equal(out.closeSeen, true); assert.equal(out.exitSeen, true);
  assert.equal(out.stderrFamily, 'NO_KNOWN_FAMILY'); assert.deepEqual(out.hresultTokens, []);
  assert.equal(out.exitFamily, 'HOST_FFFF0000'); assert.equal(child.kills, 0);
  assert.equal(JSON.stringify(out).includes(canary), false);
  assert.equal(JSON.stringify(out).includes('currentUserSid'), false);
  assert.equal(JSON.stringify(out).includes(target), false);
});

test('launch shape deviations are blocked before spawn and reveal no values', () => {
  const changes = [
    (t) => { t[0] = canary; }, (t) => { t[1][0] = canary; }, (t) => { t[1][6] = canary; },
    (t) => { t[2].cwd = canary; }, (t) => { t[2].shell = true; }, (t) => { t[2].windowsHide = false; },
    (t) => { t[2].env.PATH = canary; }, (t) => { t[2].env.EXTRA = canary; },
    (t) => { t[2].env.USERPROFILE = canary; }, (t) => { t[2].env.AGENTVAC_ACL_MODE = 'locality'; },
    (t) => { t[2].env.AGENTVAC_ACL_ALLOW_MISSING_LEAF = '1'; }, (t) => { t[2].stdio[0] = 'pipe'; },
  ];
  for (const change of changes) {
    const expected = expectedFor(baseHelper); const tuple = tupleFor(expected); change(tuple);
    const observation = observer.createObservation(expected); let invoked = false;
    assert.throws(() => observation.spawn(() => { invoked = true; }, null, tuple), /BLOCKED_LAUNCH_SHAPE/);
    assert.equal(invoked, false); assert.equal(observation.snapshot().shapeBlocked, true);
    assert.equal(JSON.stringify(observation.snapshot()).includes(canary), false);
  }
});

test('native errors remain the same object and only allowlisted codes leave observation', () => {
  for (const code of ['ENOENT', canary, '__proto__']) {
    const expected = expectedFor(baseHelper); const error = Object.assign(new Error(canary), { code });
    const observation = observer.createObservation(expected);
    assert.throws(() => observation.spawn(() => { throw error; }, null, tupleFor(expected)), (caught) => caught === error);
    const out = observation.snapshot();
    assert.equal(out.spawnErrorFamily, code === 'ENOENT' ? 'ENOENT' : 'OTHER');
    assert.equal(JSON.stringify(out).includes(canary), false);
  }
});

test('a missing close stays unobserved after bounded wait; the observer never kills', async () => {
  const expected = expectedFor(baseHelper); const child = fakeChild();
  const observation = observer.createObservation(expected);
  observation.spawn(() => child, null, tupleFor(expected));
  child.emit('exit', 0, null);
  await observation.awaitReaping(1);
  assert.equal(observation.snapshot().exitSeen, true);
  assert.equal(observation.snapshot().closeSeen, false);
  assert.equal(child.kills, 0);
  child.emit('close', 0, null);
  assert.equal(observation.snapshot().closeSeen, true);
});

test('observer prevents unarmed and repeated launches before native spawn', () => {
  let count = 0; const native = () => { count++; return fakeChild(); };
  const expected = expectedFor(baseHelper); const tuple = tupleFor(expected);
  assert.throws(() => observer.observeSpawn(native, null, tuple), /BLOCKED_UNARMED_LAUNCH/);
  const observation = observer.createObservation(expected);
  observation.spawn(native, null, tuple);
  assert.throws(() => observation.spawn(native, null, tuple), /BLOCKED_LAUNCH_SHAPE/);
  assert.equal(count, 1);
});

test('observer counts are capped, unknown helper fields are dropped, and arbitrary exits never leak', () => {
  const expected = expectedFor(baseHelper); const child = fakeChild(); const observation = observer.createObservation(expected);
  observation.spawn(() => child, null, tupleFor(expected));
  child.stdout.emit('data', Buffer.alloc(1024 * 1024, 88)); child.stderr.emit('data', Buffer.alloc(1024 * 1024, 89));
  child.emit('error', { code: canary, message: canary }); child.close(canary, canary);
  const out = observation.snapshot();
  assert.equal(out.stdoutBytes, 65537); assert.equal(out.stderrBytes, 16385); assert.equal(out.scannedBytes, 16384);
  assert.equal(out.exitFamily, 'OTHER_EXIT'); assert.equal(out.signalFamily, 'OTHER_SIGNAL');
  for (const exitCode of [canary, '__proto__', { private: canary }, NaN]) {
    const sanitized = observer.sanitizeHelper({ outcome: canary, helperPhase: canary, exitCode, secret: canary, elapsedMs: Infinity });
    assert.equal(JSON.stringify(sanitized).includes(canary), false);
    assert.equal(sanitized.exitFamily, 'OTHER_EXIT');
  }
  assert.equal(JSON.stringify(out).includes(canary), false);
});

async function exercise(observed, scenario) {
  const child = fakeChild(); let tuple;
  const nativeSpawn = (...args) => { tuple = args; if (scenario.throw) throw scenario.throw; return child; };
  const { helper, timers } = compileHarness(observed, nativeSpawn);
  const mode = scenario.mode ?? 'acl'; const controller = new AbortController();
  if (scenario.preabort) controller.abort();
  const observation = observed ? observer.armObservation(expectedFor(helper, mode)) : null;
  try {
    const promise = mode === 'locality'
      ? helper.inspectCursorSnapshotWindowsLocalityDetailed(target, false, controller.signal)
      : helper.inspectCursorSnapshotWindowsAclDetailed(target, true, controller.signal);
    if (scenario.timeout) timers[0].callback();
    else if (scenario.abort) controller.abort();
    else if (!scenario.throw && !scenario.preabort) scenario.emit(child);
    const result = await promise;
    await Promise.resolve();
    if (observation) await observation.awaitReaping(1);
    return { result, tuple, timers: timers.map((v) => v.ms), kills: child.kills, observation: observation?.snapshot() };
  } finally { if (observed) observer.disarmObservation(); }
}

const scenarios = [
  { name: 'locality success', mode: 'locality', emit(c) { c.stdout.emit('data', Buffer.from('{"localityVerified":true}')); c.close(0); } },
  { name: 'private ACL success', emit(c) { c.stdout.emit('data', Buffer.from(JSON.stringify(privateAcl))); c.close(0); } },
  { name: 'public ACL rejection', emit(c) { c.stdout.emit('data', Buffer.from(JSON.stringify({ ...privateAcl, ownerSid: 'S-1-1-0' }))); c.close(0); } },
  { name: 'host startup failure', emit(c) { c.stderr.emit('data', Buffer.from('Loading managed Windows PowerShell failed with error 8009001d.')); c.close(4294901760); } },
  { name: 'unrecognized startup output', emit(c) { c.stderr.emit('data', Buffer.from(canary)); c.close(4294901760); } },
  { name: 'phase markers across chunks', emit(c) { for (const b of Buffer.from('AGENTVAC_ACL:started\nAGENTVAC_ACL:locality-verified\n')) c.stderr.emit('data', Buffer.from([b])); c.close(3); } },
  { name: 'native locality rejection', emit(c) { c.close(4); } },
  { name: 'stdout bound', emit(c) { c.stdout.emit('data', Buffer.alloc(65537)); } },
  { name: 'stderr bound', emit(c) { c.stderr.emit('data', Buffer.alloc(16385)); } },
  { name: 'invalid JSON', emit(c) { c.stdout.emit('data', Buffer.from(canary)); c.close(0); } },
  { name: 'invalid UTF8', emit(c) { c.stdout.emit('data', Buffer.from([0xff])); c.close(0); } },
  { name: 'stdout stream error', emit(c) { c.stdout.emit('error', new Error(canary)); } },
  { name: 'stderr stream error', emit(c) { c.stderr.emit('error', new Error(canary)); } },
  { name: 'spawn event error', emit(c) { c.emit('error', Object.assign(new Error(canary), { code: 'ENOENT' })); } },
  { name: 'spawn synchronous error', throw: Object.assign(new Error(canary), { code: 'EACCES' }) },
  { name: 'unchanged timeout', timeout: true },
  { name: 'cancellation after spawn', abort: true },
  { name: 'cancellation before spawn', preabort: true },
];
for (const scenario of scenarios) test(`original/bundled helper equivalence: ${scenario.name}`, async () => {
  const plain = await exercise(false, scenario); const wrapped = await exercise(true, scenario);
  assert.equal(JSON.stringify(plain.result), JSON.stringify(wrapped.result));
  assert.ok(JSON.stringify(plain.tuple) === JSON.stringify(wrapped.tuple), 'launch tuple differs');
  assert.deepEqual(plain.timers, wrapped.timers); assert.ok(plain.timers.every((v) => v === 5000));
  assert.equal(plain.kills, wrapped.kills);
  assert.equal(JSON.stringify(wrapped.observation).includes(canary), false);
});

async function controllerScenario({ parentOutcome = 'verified-local', failStep = 0, missingClose = false,
  missingCloseStep = 0, spawnCode, cleanupFails = false, mutateInputs = false, rejectAcl = false } = {}) {
  const calls = []; const input = { ...fixtureEnv }; let count = 0;
  const harness = compileHarness(true, (...tuple) => {
    const child = fakeChild(); const current = ++count;
    calls.push(tuple[2].env.AGENTVAC_ACL_MODE);
    if (spawnCode) throw Object.assign(new Error(canary), { code: spawnCode });
    queueMicrotask(() => {
      if (current === failStep) {
        child.stderr.emit('data', Buffer.from(canary)); child.close(4294901760); return;
      }
      if (current === 1 && parentOutcome !== 'verified-local') { child.close(4); return; }
      const acl = tuple[2].env.AGENTVAC_ACL_MODE === 'acl';
      child.stdout.emit('data', Buffer.from(JSON.stringify(acl ?
        (rejectAcl ? { ...privateAcl, ownerSid: 'S-1-1-0' } : privateAcl) : { localityVerified: true })));
      child.close(0);
    });
    return child;
  }, input);
  const testObserver = { ...observer, armObservation(expected) {
    const item = observer.armObservation(expected);
    if (!missingClose && missingCloseStep !== count + 1) return item;
    return { ...item, snapshot: () => ({ ...item.snapshot(), closeSeen: false }) };
  } };
  const result = await runFixedSequence({ helper: harness.helper, observer: testObserver, lock,
    parent: 'C:\\TempSynthetic', env: () => input,
    createFixture: async () => { calls.push('create'); if (mutateInputs) input.TEMP = 'C:\\Changed'; return target; },
    removeFixture: async () => { calls.push('remove'); if (cleanupFails) throw new Error(canary); },
  });
  return { result, calls };
}

test('fixed parent/locality/ACL/locality order; inherited ACL is observed without setup/repair', async () => {
  const { result, calls } = await controllerScenario();
  assert.deepEqual(calls, ['locality', 'create', 'locality', 'acl', 'locality', 'remove']);
  assert.equal(result.status, 'OBSERVED_ALL_VERIFIED'); assert.equal(result.fixtureRemoved, true);
  assert.deepEqual(result.steps.map((v) => v.step), lock.sequence);
  assert.equal(JSON.stringify(result).includes(target), false);
  assert.equal(result.productionAccepted, false);
  assert.equal(result.counts.verified, 4); assert.equal(result.counts.failed, 0);
  assert.equal(result.counts.notRun, 0); assert.equal(result.counts.missingEvidence, 0);
  assert.equal(receiptExitCode(result), 0);
});
test('failed ordinary temp-parent verification prevents fixture creation and alternate attempts', async () => {
  const { result, calls } = await controllerScenario({ parentOutcome: 'locality-rejected' });
  assert.deepEqual(calls, ['locality']); assert.equal(result.fixtureCreated, false);
  assert.equal(result.reason, 'PARENT_LOCALITY_UNVERIFIED');
  assert.equal(result.steps.length, 4); assert.equal(result.counts.rejected, 1); assert.equal(result.counts.notRun, 3);
  assert.ok(result.steps.slice(1).every((v) => v.outcome === 'NOT_RUN' && v.reason === 'PARENT_LOCALITY_UNVERIFIED'));
  assert.equal(receiptExitCode(result), 2);
});
test('ACL startup failure is recorded once and post-locality still runs with no retry', async () => {
  const { result, calls } = await controllerScenario({ failStep: 3 });
  assert.deepEqual(calls, ['locality', 'create', 'locality', 'acl', 'locality', 'remove']);
  assert.equal(result.steps[2].helper.outcome, 'helper-failed');
  assert.equal(result.steps[2].observation.stderrFamily, 'NO_KNOWN_FAMILY');
  assert.deepEqual(result.steps[2].observation.hresultTokens, []);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.status, 'OBSERVED_WITH_BLOCKS'); assert.equal(result.counts.helperFailed, 1);
  assert.equal(result.counts.verified, 3); assert.equal(result.counts.notRun, 0);
  assert.equal(result.steps[2].outcome, 'helper-failed'); assert.equal(receiptExitCode(result), 2);
});
test('missing child close evidence stops before creating or trying another target', async () => {
  const { result, calls } = await controllerScenario({ missingClose: true });
  assert.deepEqual(calls, ['locality']); assert.equal(result.reason, 'CHILD_CLOSE_UNOBSERVED');
});
test('missing close after fixture creation preserves fixture and prevents later launches', async () => {
  const { result, calls } = await controllerScenario({ missingCloseStep: 2 });
  assert.deepEqual(calls, ['locality', 'create', 'locality']);
  assert.equal(result.fixtureCreated, true); assert.equal(result.fixtureRemoved, false);
  assert.equal(result.reason, 'CHILD_CLOSE_UNOBSERVED');
  assert.equal(result.counts.verified, 2); assert.equal(result.counts.notRun, 2);
  assert.equal(result.counts.missingEvidence, 3);
  assert.equal(result.steps[1].helper.outcome, 'verified-local');
  assert.equal(result.steps[1].launchEvidenceComplete, false);
});
test('missing spawn capability has its own BLOCKED reason and no startup-family inference', async () => {
  const { result, calls } = await controllerScenario({ spawnCode: 'ENOENT' });
  assert.deepEqual(calls, ['locality']); assert.equal(result.reason, 'MISSING_SPAWN_CAPABILITY');
  assert.deepEqual(result.steps[0].observation.familyTokens, []);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.counts.capabilityBlocked, 1); assert.equal(result.counts.notRun, 3);
  assert.ok(result.steps.slice(1).every((v) => v.reason === 'MISSING_SPAWN_CAPABILITY'));
});
test('fixture cleanup failure is bounded and redacted without recursive repair', async () => {
  const { result, calls } = await controllerScenario({ cleanupFails: true });
  assert.deepEqual(calls, ['locality', 'create', 'locality', 'acl', 'locality', 'remove']);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'FIXTURE_CLEANUP_CAPABILITY');
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('filtered-input mutation blocks the next call without changing the environment', async () => {
  const { result, calls } = await controllerScenario({ mutateInputs: true });
  assert.deepEqual(calls, ['locality', 'create', 'remove']); assert.equal(result.reason, 'FILTERED_INPUTS_CHANGED');
});
test('non-Windows capability is BLOCKED and never treated as observed startup cause',
  { skip: process.platform === 'win32' ? 'Non-Windows capability check only' : false }, async () => {
  const result = await runReviewedWindows(sourceRoot, root);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'PLATFORM_NOT_WINDOWS');
  assert.equal(result.productionAccepted, false); assert.equal(receiptExitCode(result), 2);
  assert.equal(result.counts.notRun, 4); assert.equal(result.counts.observed, 0);
  assert.equal(result.counts.missingEvidence, 4);
  assert.ok(result.steps.every((v) => v.outcome === 'NOT_RUN' && v.reason === 'PLATFORM_NOT_WINDOWS'));
});

test('completed ACL rejection is explicitly observed-with-blocks and nonzero without changing its outcome', async () => {
  const { result, calls } = await controllerScenario({ rejectAcl: true });
  assert.deepEqual(calls, ['locality', 'create', 'locality', 'acl', 'locality', 'remove']);
  assert.equal(result.status, 'OBSERVED_WITH_BLOCKS');
  assert.equal(result.reason, 'FIXED_SEQUENCE_COMPLETED_WITH_BLOCKS');
  assert.equal(result.steps[2].helper.outcome, 'acl-rejected');
  assert.equal(result.steps[2].outcome, 'acl-rejected');
  assert.equal(result.counts.rejected, 1); assert.equal(result.counts.verified, 3);
  assert.equal(receiptExitCode(result), 2); assert.equal(result.productionAccepted, false);
});

test('every early block enumerates four NOT_RUN cases, explicit reasons and missing evidence', () => {
  for (const reason of ['ARTIFACT_PIN', 'SOURCE_PIN', 'PLATFORM_NOT_WINDOWS', 'UNEXPECTED_HARNESS_ERROR']) {
    const result = blockedReceipt(reason);
    assert.deepEqual(result.steps.map((v) => v.step), lock.sequence);
    assert.equal(result.counts.expected, 4); assert.equal(result.counts.observed, 0);
    assert.equal(result.counts.notRun, 4); assert.equal(result.counts.skipped, 0);
    assert.equal(result.counts.missingEvidence, 4); assert.equal(result.productionAccepted, false);
    assert.ok(result.steps.every((v) => v.execution === 'NOT_RUN' && v.reason === reason && v.helper === null));
    assert.equal(receiptExitCode(result), 2);
  }
});

test('receipt buckets cover every prescribed step while preserving actual helper outcomes', async () => {
  for (const options of [{}, { rejectAcl: true }, { failStep: 3 }, { spawnCode: 'ENOENT' }, { missingCloseStep: 2 }]) {
    const { result } = await controllerScenario(options);
    const c = result.counts;
    assert.equal(c.verified + c.rejected + c.capabilityBlocked + c.helperFailed + c.notRun, c.expected);
    assert.equal(c.observed + c.notRun, 4);
    assert.equal(c.failed, c.rejected + c.capabilityBlocked + c.helperFailed);
    for (const row of result.steps.filter((v) => v.execution === 'OBSERVED')) assert.equal(row.outcome, row.helper.outcome);
    assert.equal(result.productionAccepted, false);
  }
});

test('the previous frozen packet remains byte-for-byte unchanged',
  { skip: !existsSync(path.join(root, 'frozen-v1')) ? 'Local archive is excluded from publication' : false }, async () => {
  const archive = path.join(root, 'frozen-v1');
  const manifest = JSON.parse(await readFile(path.join(archive, 'archive-manifest.json'), 'utf8'));
  for (const [name, pin] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(archive, name));
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
  }
});
