import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// These identify the actual frozen deliverables. There is no installer target.
export const TARGETS = Object.freeze({
  'linux-tar': { platform: 'linux', arch: 'x64', type: 'tar-portable', artifact: 'linux/agentvac-0.1.0.tar.gz', executable: 'agentvac-0.1.0/agentvac' },
  'linux-appimage': { platform: 'linux', arch: 'x64', type: 'appimage-fuse', artifact: 'linux/AgentVac-0.1.0.AppImage' },
  'windows-portable': { platform: 'win32', arch: 'x64', type: 'portable-launcher', artifact: 'windows/AgentVac 0.1.0.exe', launcherArch: 'ia32' },
  'windows-unpacked': { platform: 'win32', arch: 'x64', type: 'unpacked-payload', artifact: 'windows/win-unpacked/AgentVac.exe' },
  'windows-portable-built': { platform: 'win32', arch: 'x64', type: 'portable-launcher', launcherArch: 'ia32', candidateOnly: true },
  'macos-arm64': { platform: 'darwin', arch: 'arm64', type: 'app-zip', artifact: 'macos/AgentVac-0.1.0-macos-arm64.zip', executable: 'AgentVac.app/Contents/MacOS/AgentVac' },
  'macos-x64': { platform: 'darwin', arch: 'x64', type: 'app-zip', artifact: 'macos/AgentVac-0.1.0-macos-x64.zip', executable: 'AgentVac.app/Contents/MacOS/AgentVac' },
  'linux-unpacked': { platform: 'linux', arch: 'x64', type: 'unpacked-payload', candidateOnly: true },
  'macos-arm64-unpacked': { platform: 'darwin', arch: 'arm64', type: 'unpacked-payload', candidateOnly: true },
  'macos-x64-unpacked': { platform: 'darwin', arch: 'x64', type: 'unpacked-payload', candidateOnly: true },
});
export class CapabilityBlock extends Error { name = 'CapabilityBlock'; }
export function classifyLaunchError(error, spec) {
  const detail = String(error.stack || error);
  if (spec.type === 'appimage-fuse' && /error loading libfuse\.so\.2|AppImages require FUSE to run/.test(detail))
    return new CapabilityBlock('Direct AppImage launch is blocked by the missing FUSE runtime. No extraction fallback or system change was attempted.\n' + detail);
  return error;
}
export async function recordCheck(checks, name, action, persist = async () => {}) {
  try {
    const detail = await action();
    checks[name] = { status: 'PASS', detail };
    return detail;
  } catch (error) {
    checks[name] = { status: error instanceof CapabilityBlock ? 'BLOCKED' : 'FAIL', detail: String(error.stack || error) };
    throw error;
  } finally { await persist(); }
}
export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (['--help', '--preflight-only'].includes(option)) {
      assert.equal(result[option.slice(2)], undefined, `Duplicate option ${option}`);
      result[option.slice(2)] = true;
    } else {
      assert.ok(['--target', '--release-root', '--playwright-root', '--candidate-executable', '--candidate-id', '--payload-manifest', '--evidence-root'].includes(option), `Unknown option ${option}; extra launch flags and installer targets are forbidden`);
      assert.equal(result[option.slice(2)], undefined, `Duplicate option ${option}`);
      const value = args[++i];
      assert.ok(value && !value.startsWith('--'), `Missing value for ${option}`);
      result[option.slice(2)] = value;
    }
  }
  if (!result.help) {
    assert.ok(Object.hasOwn(TARGETS, result.target), `Choose --target ${Object.keys(TARGETS).join('|')}`);
    const spec = TARGETS[result.target];
    if (spec.candidateOnly || result['candidate-executable'] || result['candidate-id']) {
      assert.ok(spec.type === 'unpacked-payload' || result.target === 'windows-portable-built', 'Candidate inputs require an explicitly unpacked or built portable target, never a frozen archive/portable claim');
      assert.ok(result['candidate-executable'] && path.isAbsolute(result['candidate-executable']), 'Provide an absolute --candidate-executable');
      assert.match(result['candidate-id'] || '', /^[A-Za-z0-9._-]{1,120}$/, 'Provide a bounded --candidate-id (for example the exact CI commit SHA)');
      assert.equal(result['release-root'], undefined, 'Candidate executable and frozen release-root inputs must not be mixed');
    }
    for (const option of ['payload-manifest', 'evidence-root']) if (result[option]) assert.ok(path.isAbsolute(result[option]), `--${option} must be absolute`);
    if (result['payload-manifest']) assert.ok(result['candidate-executable'], 'A payload manifest requires an explicit candidate');
    if (result.target === 'windows-portable-built') assert.ok(result['payload-manifest'], 'Built portable launch requires a runtime payload manifest');
  }
  return result;
}
export function resolveInput(args, releaseRoot) {
  const candidate = args['candidate-executable'];
  return {
    artifact: candidate ? path.resolve(candidate) : path.join(releaseRoot, TARGETS[args.target].artifact),
    provenance: candidate
      ? { kind: 'native-built-candidate', candidateId: args['candidate-id'], identitySource: 'Caller-supplied build/revision label; not a content hash proof', frozenArchiveByteIdentity: 'NOT_ASSERTED', installerTested: false }
      : { kind: 'frozen-release-input', frozenArchiveByteIdentity: 'Use existing frozen integrity evidence; archive hashes not recomputed by this harness', installerTested: false },
  };
}
export function assertNativeHost(spec, host) {
  if (host.platform !== spec.platform || host.arch !== spec.arch)
    throw new CapabilityBlock(`Requires native ${spec.platform}/${spec.arch}; current Node host is ${host.platform}/${host.arch}. No emulation fallback.`);
  if (host.translated === true)
    throw new CapabilityBlock('Translated macOS process cannot establish native CPU acceptance. Use a matching native runner.');
  if (host.platform === 'linux' && !host.display && !host.waylandDisplay)
    throw new CapabilityBlock('No graphical session is available (DISPLAY and WAYLAND_DISPLAY are unset). Run in an authorized normal desktop or existing Xvfb session with Chromium sandbox enabled.');
}
export function isolatedEnv(source, profile) {
  const env = { ...source };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'ELECTRON_EXTRA_LAUNCH_ARGS', 'NODE_OPTIONS', 'AGENTVAC_TEST_USER_DATA', 'AGENTVAC_DEV_URL', 'APPIMAGE_EXTRACT_AND_RUN', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[name];
  // Production candidate discovery sees generated empty locations. No real roots are selected.
  env.CODEX_HOME = path.join(profile, 'empty-codex-home');
  env.CODEX_SQLITE_HOME = path.join(profile, 'empty-sqlite-home');
  return env;
}
export function assertArchiveEntries(raw, kind) {
  const names = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(names.length > 0, 'Empty archive listing');
  for (const name of names) {
    assert.ok(!name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name), `Unsafe archive entry: ${name}`);
    assert.ok(!name.split('/').includes('..'), `Archive traversal: ${name}`);
    if (kind === 'tar-portable') assert.ok(name === 'agentvac-0.1.0/' || name.startsWith('agentvac-0.1.0/'), `Unexpected tar root: ${name}`);
    else assert.ok(name === 'AgentVac.app/' || name.startsWith('AgentVac.app/'), `Unexpected app ZIP root: ${name}`);
  }
  return names.length;
}
export function binaryHeader(buffer) {
  assert.ok(buffer.length >= 64, 'Executable header is truncated');
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    assert.equal(buffer[4], 2, 'Expected ELF64');
    assert.equal(buffer[5], 1, 'Expected little-endian ELF');
    const machine = buffer.readUInt16LE(18);
    assert.ok([62, 183].includes(machine), 'Unsupported ELF CPU');
    return { format: 'ELF', arch: machine === 62 ? 'x64' : 'arm64' };
  }
  if (buffer.readUInt16LE(0) === 0x5a4d) {
    const offset = buffer.readUInt32LE(0x3c);
    assert.ok(offset + 6 <= buffer.length, 'PE header is outside inspected prefix');
    assert.equal(buffer.readUInt32LE(offset), 0x4550, 'Invalid PE signature');
    const machine = buffer.readUInt16LE(offset + 4);
    assert.ok([0x14c, 0x8664, 0xaa64].includes(machine), 'Unsupported PE CPU');
    return { format: 'PE', arch: ({ 332: 'ia32', 34404: 'x64', 43620: 'arm64' })[machine] };
  }
  if (buffer.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buffer.readUInt32LE(4);
    assert.ok([0x1000007, 0x100000c].includes(cpu), 'Unsupported Mach-O CPU');
    return { format: 'Mach-O', arch: cpu === 0x1000007 ? 'x64' : 'arm64' };
  }
  throw new Error('Not a supported native executable; source-launch inputs are forbidden');
}
export async function inspectExecutable(file) {
  const st = await fs.lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'Executable must be a regular file');
  const h = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    return { ...binaryHeader(buf.subarray(0, bytesRead)), bytes: st.size };
  } finally { await h.close(); }
}
export const PACKAGED_HELPERS = Object.freeze(['diagnostic-supervisor.cjs', 'diagnostic-worker.cjs', 'cursor-sql-worker.cjs', 'process-argv-worker.cjs']);
export async function fileIdentity(file) {
  const st = await fs.lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'Expected a regular file for byte identity');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return { bytes: st.size, sha256: digest.digest('hex') };
}
export function isWithin(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
// Snapshot every shipped file and relative link, without following directory links.
// The root is Contents on macOS and the executable directory on Linux/Windows.
export async function snapshotPayload(root) {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Payload root must be a real directory');
  const realRoot = await fs.realpath(root);
  const entries = [];
  async function visit(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), st = await fs.lstat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (st.isSymbolicLink()) {
        const target = await fs.readlink(file);
        assert.ok(!path.isAbsolute(target) && isWithin(root, path.resolve(path.dirname(file), target)), `Payload link escapes root: ${relative}`);
        assert.ok(isWithin(realRoot, await fs.realpath(file)), `Payload link resolves outside root: ${relative}`);
        entries.push({ relative, kind: 'symlink', target });
      } else if (st.isDirectory()) await visit(file);
      else {
        assert.ok(st.isFile(), `Unsupported payload entry: ${relative}`);
        entries.push({ relative, kind: 'file', ...await fileIdentity(file) });
      }
    }
  }
  await visit(root);
  assert.ok(entries.length, 'Empty payload');
  return entries.sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
}
export function validatePayloadManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.sourceRevision || '', /^[0-9a-f]{40}$/);
  assert.match(manifest.artifactSha256 || '', /^[0-9a-f]{64}$/);
  assert.ok(['exact', 'inside'].includes(manifest.rootMode));
  assert.ok(path.isAbsolute(manifest.root));
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0);
  const seen = new Set();
  for (const entry of manifest.entries) {
    fixturePath(manifest.root, entry.relative);
    assert.ok(!seen.has(entry.relative), 'Duplicate payload entry');
    seen.add(entry.relative);
    if (entry.kind === 'file') {
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
      assert.match(entry.sha256 || '', /^[0-9a-f]{64}$/);
    } else {
      assert.equal(entry.kind, 'symlink');
      assert.ok(typeof entry.target === 'string' && !path.isAbsolute(entry.target));
      assert.ok(isWithin(manifest.root, path.resolve(path.dirname(fixturePath(manifest.root, entry.relative)), entry.target)), 'Manifest link escapes root');
    }
  }
  fixturePath(manifest.root, manifest.executable);
  fixturePath(manifest.root, manifest.resources + '/app.asar');
  for (const relative of [manifest.executable, manifest.resources + '/app.asar', ...PACKAGED_HELPERS.map(name => manifest.resources + '/app.asar.unpacked/dist-electron/' + name)])
    assert.ok(manifest.entries.some(entry => entry.relative === relative && entry.kind === 'file' && entry.bytes > 0), `Missing required payload identity: ${relative}`);
  assert.deepEqual(manifest.allowedExtraFiles || [], manifest.installer === true ? ['Uninstall AgentVac.exe'] : []);
  return manifest;
}
export async function verifyPayload(root, manifest) {
  validatePayloadManifest(manifest);
  const actual = await snapshotPayload(root);
  const allowed = new Set(manifest.allowedExtraFiles || []);
  for (const entry of actual.filter(entry => allowed.has(entry.relative))) assert.equal(entry.kind, 'file', 'Installer-only addition must be regular');
  assert.deepEqual(actual.filter(entry => !allowed.has(entry.relative)), manifest.entries, 'Launched payload bytes/links differ from the verified built package');
  return { status: 'PASS', fileCount: manifest.entries.filter(e => e.kind === 'file').length, symlinkCount: manifest.entries.filter(e => e.kind === 'symlink').length, artifactSha256: manifest.artifactSha256 };
}
export async function bindRuntimePayload(runtime, manifest) {
  validatePayloadManifest(manifest);
  const root = path.resolve(runtime.resourcesPath, '..');
  const realRoot = await fs.realpath(root), realExpected = await fs.realpath(manifest.root);
  if (manifest.rootMode === 'exact') assert.equal(realRoot, realExpected, 'Runtime was not launched from the prepared/installed payload');
  else assert.ok(isWithin(realExpected, realRoot), 'Portable runtime did not extract inside its generated temp root');
  assert.equal(path.resolve(runtime.execPath), path.join(root, ...manifest.executable.split('/')), 'Unexpected running executable');
  assert.equal(path.resolve(runtime.appPath), path.join(root, manifest.resources, 'app.asar'), 'Unexpected loaded ASAR');
  return { ...await verifyPayload(root, manifest), root, execPath: runtime.execPath, appPath: runtime.appPath };
}
export function assertRuntime(runtime, spec, profile) {
  assert.equal(runtime.packaged, true, 'Source-launched Electron cannot pass packaged acceptance');
  assert.equal(runtime.platform, spec.platform);
  assert.equal(runtime.arch, spec.arch, 'Inspect the runtime CPU, not the portable bootstrap CPU');
  assert.equal(path.resolve(runtime.userData), path.resolve(profile), 'Profile isolation was ignored; stop before any fixture action');
  assert.equal(path.basename(runtime.appPath), 'app.asar', 'The shipped ASAR must be loaded');
  assert.equal(runtime.windows, 1);
  assert.equal(runtime.visible, true);
  assert.equal(runtime.sandbox, true);
  assert.equal(runtime.contextIsolation, true);
  assert.equal(runtime.nodeIntegration, false);
  assert.equal(runtime.webSecurity, true);
  assert.deepEqual(runtime.disabledProtectionSwitches, []);
  assert.ok(!runtime.argv.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|single-process)(?:=|$)/.test(arg)), 'An OS/browser protection-disabling flag is present');
}
export function fixturePath(root, relative) {
  assert.ok(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0'), 'Invalid fixture path');
  assert.ok(!path.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative) && !relative.split('/').includes('..'), 'Fixture path must stay relative');
  const file = path.resolve(root, relative);
  assert.ok(file.startsWith(path.resolve(root) + path.sep), 'Fixture path escaped owned root');
  return file;
}
export async function fixtureDigest(root, relative) {
  const file = fixturePath(root, relative);
  // Parent components must remain real directories; never follow a generated-root escape.
  let current = path.resolve(root);
  for (const part of ['', ...relative.split('/').slice(0, -1)]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'Fixture parent is not a plain directory');
  }
  const st = await fs.lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'Fixture is not an owned plain file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { relative, bytes: st.size, sha256: hash.digest('hex') };
}
export function summarize(checks, preflight) {
  const states = Object.values(checks).map(value => value.status);
  if (states.includes('FAIL')) return 'FAIL';
  if (states.includes('BLOCKED')) return 'BLOCKED';
  if (preflight) return 'NOT_RUN_PREFLIGHT_ONLY';
  if (!states.length || states.some(state => state !== 'PASS')) return 'INCOMPLETE';
  return 'PASS_PACKAGED_SMOKE_ONLY';
}
