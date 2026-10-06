import path from 'node:path';
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ stderr: 16384, stdout: 65536, reapingMs: 2000 });
const FAMILIES = [
  ['MANAGED_POWERSHELL_LOAD', 'loading managed windows powershell failed'],
  ['SHELL_INITIALIZATION', 'a failure occurred during initialization'],
  ['CLR_INITIALIZATION', 'failed to initialize the common language runtime'],
];
const HRESULTS = ['8009001d', '80070002', '80070003', '80070005', '80131500', '80131700'];
const BOOTSTRAP = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
const EMPTY = [...BOOTSTRAP, 'HOMEDRIVE', 'HOMEPATH'];
const PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand'];
const PHASES = ['not-started', 'started', 'locality-verified', 'modules-loaded', 'acl-read', 'serialized'];
const OUTCOMES = ['verified-private', 'verified-local', 'locality-rejected', 'acl-rejected',
  'not-windows', 'invalid-target', 'invalid-environment', 'cancelled', 'spawn-failed',
  'timeout', 'output-limit', 'helper-failed', 'invalid-output'];
const cap = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lower = (b) => b >= 65 && b <= 90 ? b + 32 : b;
const hex = (b) => (b >= 48 && b <= 57) || (b >= 97 && b <= 102);

// Fixed pattern bytes and integer state only. No decoded lines, raw tails, chunks,
// error messages, or arbitrary matches are retained. Unknown bytes are discarded.
export function createTokenScanner() {
  const matches = new Set(), matchedPatterns = new Set(), encodings = new Set(), preambles = new Set();
  const definitions = [
    ...FAMILIES.map(([id, token]) => ({ id, token, kind: 'family', boundary: false })),
    ...HRESULTS.map((token) => ({ id: `H${token.toUpperCase()}`, token, kind: 'hresult', boundary: true })),
    { id: 'CLIXML', token: '#< clixml', kind: 'preamble', boundary: false },
  ];
  const patterns = ['ASCII', 'UTF16LE', 'UTF16BE'].flatMap((encoding) => definitions.map((definition) => {
    const bytes = Buffer.from(definition.token, encoding === 'ASCII' ? 'ascii' : 'utf16le');
    if (encoding === 'UTF16BE') bytes.swap16();
    const failure = Array(bytes.length).fill(0);
    for (let i = 1, j = 0; i < bytes.length; i++) {
      while (j > 0 && bytes[i] !== bytes[j]) j = failure[j - 1];
      if (bytes[i] === bytes[j]) j++;
      failure[i] = j;
    }
    return { ...definition, encoding, key: `${encoding}:${definition.id}`,
      bytes, failure, position: 0, pending: 0, suffixClass: false };
  }));
  let scanned = 0, previousClass = 2, beforePreviousClass = 2,
    truncated = false, bomState = 0, zeroEvenBytes = 0, zeroOddBytes = 0;
  const record = (p) => {
    matchedPatterns.add(p.key);
    encodings.add(p.encoding);
    if (p.kind === 'preamble') preambles.add(`CLIXML_${p.encoding}`);
    else matches.add(p.id);
  };
  const acceptPending = (b) => {
    for (const p of patterns) {
      if (p.pending === 1) {
        if (p.encoding === 'ASCII') {
          if (!hex(b)) record(p);
          p.pending = 0;
        } else {
          // Only fixed booleans survive between code-unit halves, never bytes.
          p.suffixClass = p.encoding === 'UTF16LE' ? hex(b) : b === 0;
          p.pending = 2;
        }
      } else if (p.pending === 2) {
        if (!(p.suffixClass && (p.encoding === 'UTF16LE' ? b === 0 : hex(b)))) record(p);
        p.pending = 0;
      }
    }
  };
  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) return;
      const remaining = LIMITS.stderr - scanned;
      if (chunk.length > remaining) truncated = true;
      for (let i = 0; i < Math.min(chunk.length, remaining); i++) {
        const b = lower(chunk[i]);
        if (scanned === 0) bomState = b === 255 ? 1 : b === 254 ? 2 : b === 239 ? 3 : 0;
        else if (scanned === 1) {
          if (bomState === 1 && b === 254) preambles.add('UTF16LE_BOM');
          if (bomState === 2 && b === 255) preambles.add('UTF16BE_BOM');
          bomState = bomState === 3 && b === 187 ? 4 : 0;
        } else if (scanned === 2 && bomState === 4 && b === 191) preambles.add('UTF8_BOM');
        if (b === 0) { if (scanned % 2 === 0) zeroEvenBytes++; else zeroOddBytes++; }
        acceptPending(b);
        for (const p of patterns) {
          if (matchedPatterns.has(p.key)) continue;
          while (p.position > 0 && b !== p.bytes[p.position]) p.position = p.failure[p.position - 1];
          const previousHex = p.encoding === 'ASCII' ? previousClass === 1 :
            p.encoding === 'UTF16LE' ? beforePreviousClass === 1 && previousClass === 0 :
              beforePreviousClass === 0 && previousClass === 1;
          if (b === p.bytes[p.position] && !(p.boundary && p.position === 0 && previousHex)) p.position++;
          if (p.position === p.bytes.length) {
            if (p.boundary) p.pending = 1;
            else record(p);
            p.position = p.failure[p.position - 1];
          }
        }
        beforePreviousClass = previousClass;
        previousClass = b === 0 ? 0 : hex(b) ? 1 : 2;
        scanned++;
      }
    },
    finish() {
      if (!truncated) for (const p of patterns) { if (p.pending === 1) record(p); p.pending = 0; }
    },
    snapshot() {
      return {
        familyTokens: FAMILIES.map(([id]) => id).filter((id) => matches.has(id)),
        hresultTokens: HRESULTS.map((v) => `H${v.toUpperCase()}`).filter((id) => matches.has(id)),
        matchedEncodings: ['ASCII', 'UTF16LE', 'UTF16BE'].filter((id) => encodings.has(id)),
        encodingPreambles: ['UTF8_BOM', 'UTF16LE_BOM', 'UTF16BE_BOM',
          'CLIXML_ASCII', 'CLIXML_UTF16LE', 'CLIXML_UTF16BE'].filter((id) => preambles.has(id)),
        zeroEvenBytes, zeroOddBytes, scannedBytes: scanned, truncated,
      };
    },
  };
}

export function filteredInputs(env) {
  return Object.fromEntries(['SystemRoot', ...BOOTSTRAP].map((name) => [name, env[name]]));
}

export function sameInputs(a, b) {
  return Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => a[key] === b[key]);
}

// This describes the expected tuple; it is never passed to spawn or used to
// replace the helper's own options. All values stay transient and private.
export function expectedLaunch(canonicalize, inputs, target, mode, lock) {
  const root = canonicalize(inputs.SystemRoot ?? '');
  if (!root || !/^[a-zA-Z]:\\Windows$/i.test(root) || canonicalize(target) !== target)
    throw new Error('EXPECTED_ENVIRONMENT');
  const home = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0');
  const env = {
    SystemRoot: root, WINDIR: root, SystemDrive: root.slice(0, 2),
    PATH: path.win32.join(root, 'System32'), PSModulePath: path.win32.join(home, 'Modules'),
    PSModuleAnalysisCachePath: 'NUL', AGENTVAC_SNAPSHOT_ACL_TARGET: target,
    AGENTVAC_ACL_MODE: mode, AGENTVAC_ACL_DIRECTORY: '1', AGENTVAC_ACL_ALLOW_MISSING_LEAF: '0',
    ...Object.fromEntries(EMPTY.map((name) => [name, ''])),
  };
  for (const name of BOOTSTRAP) {
    if (inputs[name]) {
      const value = canonicalize(inputs[name]);
      if (!value) throw new Error('EXPECTED_ENVIRONMENT');
      env[`AGENTVAC_BOOTSTRAP_${name}`] = value;
    }
  }
  if (!['locality', 'acl'].includes(mode)) throw new Error('EXPECTED_MODE');
  return { executable: path.win32.join(home, 'powershell.exe'), cwd: home, env, lock };
}

export function inspectLaunch(tuple, expected) {
  const [executable, argv, options] = tuple;
  const env = options?.env;
  const envKeys = env && typeof env === 'object' ? Object.keys(env) : [];
  const expectedKeys = Object.keys(expected.env);
  const script = Array.isArray(argv) && typeof argv[6] === 'string' &&
    argv[6].length === expected.lock.scriptBase64Chars ? Buffer.from(argv[6], 'base64') : null;
  const shape = {
    executableMatches: executable === expected.executable,
    argumentCount: cap(Array.isArray(argv) ? argv.length : 0, 8),
    fixedArgumentsMatch: Array.isArray(argv) && argv.length === 7 && PREFIX.every((v, i) => argv[i] === v),
    scriptMatches: script !== null && script.length === expected.lock.scriptUtf16Bytes &&
      hash(script) === expected.lock.scriptSha256 && script.toString('base64') === argv[6],
    cwdMatches: options?.cwd === expected.cwd,
    windowsHideMatches: options?.windowsHide === true,
    stdioMatches: Array.isArray(options?.stdio) && options.stdio.length === 3 &&
      ['ignore', 'pipe', 'pipe'].every((v, i) => options.stdio[i] === v),
    optionKeysMatch: options !== null && typeof options === 'object' &&
      Object.keys(options).sort().join('|') === 'cwd|env|stdio|windowsHide',
    environmentCount: cap(envKeys.length, 23),
    environmentMatches: envKeys.length === expectedKeys.length &&
      envKeys.every((name) => expectedKeys.includes(name) && env[name] === expected.env[name]),
    bootstrapCount: cap(envKeys.filter((name) => name.startsWith('AGENTVAC_BOOTSTRAP_')).length, 6),
    bootstrapLocationsEmpty: EMPTY.every((name) => env?.[name] === ''),
  };
  const valid = tuple.length === 3 && shape.executableMatches && shape.fixedArgumentsMatch &&
    shape.scriptMatches && shape.cwdMatches && shape.windowsHideMatches && shape.stdioMatches &&
    shape.optionKeysMatch && shape.environmentMatches && shape.bootstrapLocationsEmpty;
  return { valid, shape };
}

function errorFamily(error) {
  const code = error?.code;
  return ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOMEM', 'EMFILE', 'ENFILE'].includes(code) ? code : 'OTHER';
}
function exitFamily(code) {
  if (code === null || code === undefined) return 'NO_EXIT_CODE';
  if (code === 0) return 'ZERO';
  if (code === 3) return 'SCRIPT_THREE';
  if (code === 4) return 'LOCALITY_FOUR';
  if (code === 4294901760 || code === -65536) return 'HOST_FFFF0000';
  return 'OTHER_EXIT';
}
function signalFamily(signal) {
  return signal === null || signal === undefined ? 'NONE' :
    ['SIGTERM', 'SIGKILL'].includes(signal) ? signal : 'OTHER_SIGNAL';
}

export function sanitizeHelper(value) {
  return {
    outcome: OUTCOMES.includes(value?.outcome) ? value.outcome : 'unknown-outcome',
    helperPhase: PHASES.includes(value?.helperPhase) ? value.helperPhase : 'unknown-phase',
    elapsedMs: cap(value?.elapsedMs, 60000),
    exitFamily: exitFamily(value?.exitCode),
    stdoutBytes: cap(value?.stdoutBytes, LIMITS.stdout + 1),
    stderrBytes: cap(value?.stderrBytes, LIMITS.stderr + 1),
  };
}

export function createObservation(expected) {
  const scanner = createTokenScanner();
  let launch = null, attempts = 0, forwarded = false, spawnError = 'NONE',
    stdoutBytes = 0, stderrBytes = 0, exitSeen = false, closeSeen = false,
    stdoutError = false, stderrError = false, observerFault = false, shapeBlocked = false,
    exit = 'NO_EXIT_CODE', signal = 'NONE', resolveClose;
  const closed = new Promise((resolve) => { resolveClose = resolve; });
  const safely = (fn) => (...args) => { try { fn(...args); } catch { observerFault = true; } };
  return {
    spawn(nativeSpawn, thisArg, tuple) {
      attempts = Math.min(attempts + 1, 2);
      try {
        const checked = inspectLaunch(tuple, expected);
        launch = checked.shape;
        if (attempts !== 1 || !checked.valid) { shapeBlocked = true; throw new Error('BLOCKED_LAUNCH_SHAPE'); }
      } catch (error) { shapeBlocked = true; throw error; }
      let child;
      try {
        child = Reflect.apply(nativeSpawn, thisArg, tuple);
        forwarded = true;
      } catch (error) {
        spawnError = errorFamily(error);
        throw error; // Preserve the original error object for the original helper.
      }
      // These listeners observe only. No kill, pipe, write, unref, setEncoding,
      // resume, pause, environment mutation, or result replacement is permitted.
      child.stdout?.on('data', safely((chunk) => {
        if (!Buffer.isBuffer(chunk)) { observerFault = true; return; }
        stdoutBytes = Math.min(LIMITS.stdout + 1, stdoutBytes + chunk.length);
      }));
      child.stderr?.on('data', safely((chunk) => {
        if (!Buffer.isBuffer(chunk)) { observerFault = true; return; }
        stderrBytes = Math.min(LIMITS.stderr + 1, stderrBytes + chunk.length);
        scanner.push(chunk);
      }));
      child.stdout?.once('error', safely(() => { stdoutError = true; }));
      child.stderr?.once('error', safely(() => { stderrError = true; }));
      child.once('error', safely((error) => { spawnError = errorFamily(error); }));
      child.once('exit', safely((code, term) => {
        exitSeen = true; exit = exitFamily(code); signal = signalFamily(term);
      }));
      child.once('close', safely((code, term) => {
        closeSeen = true; exit = exitFamily(code); signal = signalFamily(term);
        scanner.finish(); resolveClose();
      }));
      return child; // Identity, including kill behavior, is unchanged.
    },
    async awaitReaping(ms = LIMITS.reapingMs) {
      if (!forwarded || closeSeen) return;
      let timer;
      await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, Math.min(ms, LIMITS.reapingMs)); })]);
      clearTimeout(timer);
    },
    snapshot() {
      const tokens = scanner.snapshot();
      return {
        launchAttempts: attempts, launch, identicalTupleForwarded: forwarded, shapeBlocked,
        spawnErrorFamily: spawnError, stdoutBytes, stderrBytes, exitSeen, closeSeen,
        stdoutError, stderrError, observerFault, exitFamily: exit, signalFamily: signal,
        stderrFamily: stderrBytes === 0 ? 'NO_STDERR' :
          tokens.familyTokens.length === 0 ? 'NO_KNOWN_FAMILY' : 'KNOWN_FAMILY_TOKEN',
        ...tokens,
      };
    },
  };
}

let active = null;
export function armObservation(expected) {
  if (active !== null) throw new Error('OBSERVATION_ALREADY_ARMED');
  active = createObservation(expected);
  return active;
}
export function disarmObservation() { active = null; }
export function observeSpawn(nativeSpawn, thisArg, tuple) {
  if (active === null) throw new Error('BLOCKED_UNARMED_LAUNCH');
  return active.spawn(nativeSpawn, thisArg, tuple);
}
