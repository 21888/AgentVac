import { readFile, mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifacts, verifySource } from './pins.mjs';

const EXPECTED_STEPS = ['PARENT_LOCALITY', 'FIXTURE_LOCALITY_BEFORE', 'FIXTURE_ACL', 'FIXTURE_LOCALITY_AFTER'];
const VERIFIED = ['verified-local', 'verified-private'];
const REJECTED = ['locality-rejected', 'acl-rejected'];
const CAPABILITY_BLOCKED = ['not-windows', 'invalid-target', 'invalid-environment', 'spawn-failed'];

// Reporting only: preserve every actual helper classification, list every
// expected case, and explicitly account for the calls that never ran.
export function finalizeReceipt(report) {
  const observations = report.steps ?? [];
  const counts = { expected: 4, observed: 0, verified: 0, rejected: 0,
    capabilityBlocked: 0, helperFailed: 0, failed: 0, skipped: 0, notRun: 0, missingEvidence: 0 };
  const steps = EXPECTED_STEPS.map((step) => {
    const actual = observations.find((item) => item.step === step);
    if (!actual) {
      counts.notRun++; counts.missingEvidence++;
      return { step, execution: 'NOT_RUN', outcome: 'NOT_RUN', reason: report.reason,
        launchEvidenceComplete: false, helper: null, observation: null };
    }
    counts.observed++;
    const outcome = actual.helper.outcome;
    let reason;
    if (VERIFIED.includes(outcome)) { counts.verified++; reason = 'HELPER_VERIFIED'; }
    else if (REJECTED.includes(outcome)) { counts.rejected++; reason = 'HELPER_REJECTED'; }
    else if (CAPABILITY_BLOCKED.includes(outcome)) { counts.capabilityBlocked++; reason = 'HELPER_CAPABILITY_BLOCK'; }
    else { counts.helperFailed++; reason = 'HELPER_DID_NOT_VERIFY'; }
    const evidence = actual.observation;
    const launchEvidenceComplete = evidence.identicalTupleForwarded && evidence.closeSeen && !evidence.observerFault;
    if (!launchEvidenceComplete) counts.missingEvidence++;
    if (evidence.identicalTupleForwarded && !evidence.closeSeen) reason = 'CHILD_CLOSE_UNOBSERVED';
    else if (evidence.shapeBlocked) reason = 'LAUNCH_SHAPE';
    else if (evidence.observerFault) reason = 'OBSERVER_FAULT';
    return { ...actual, execution: 'OBSERVED', outcome, reason, launchEvidenceComplete };
  });
  counts.failed = counts.rejected + counts.capabilityBlocked + counts.helperFailed;
  let status = report.status, reason = report.reason;
  if (status === 'OBSERVED') {
    const blocked = counts.rejected + counts.capabilityBlocked + counts.helperFailed + counts.notRun + counts.missingEvidence > 0;
    status = blocked ? 'OBSERVED_WITH_BLOCKS' : 'OBSERVED_ALL_VERIFIED';
    reason = blocked ? 'FIXED_SEQUENCE_COMPLETED_WITH_BLOCKS' : 'FIXED_SEQUENCE_COMPLETE';
  }
  return { ...report, format: 'agentvac-acl-startup-observation-v2', status, reason,
    productionAccepted: false, counts, steps };
}

export function blockedReceipt(reason) {
  return finalizeReceipt({ status: 'BLOCKED', reason, fixtureCreated: false, fixtureRemoved: false, steps: [] });
}

export function receiptExitCode(report) { return report.status === 'OBSERVED_ALL_VERIFIED' ? 0 : 2; }

// This controller is dependency-injected only for non-native unit tests.
// The executable path below always supplies the actual unchanged pinned helper.
export async function runFixedSequence(config) { return finalizeReceipt(await collectSequence(config)); }

async function collectSequence({ helper, observer, lock, parent, env, createFixture, removeFixture }) {
  const steps = [];
  const report = { format: 'agentvac-acl-startup-observation-v1', status: 'BLOCKED', productionAccepted: false,
    reason: 'UNFINISHED', fixtureCreated: false, fixtureRemoved: false, steps };
  const inputs = observer.filteredInputs(env());
  const canonicalize = helper.canonicalizeCursorSnapshotWindowsPath;
  const targetParent = canonicalize(parent);
  if (!targetParent) { report.reason = 'TEMP_PARENT_SHAPE'; return report; }
  let target;
  let allClosed = true;
  const sample = async (step, candidate, mode) => {
    if (!observer.sameInputs(inputs, observer.filteredInputs(env()))) {
      report.reason = 'FILTERED_INPUTS_CHANGED'; return false;
    }
    let expected;
    try { expected = observer.expectedLaunch(canonicalize, inputs, candidate, mode, lock); }
    catch { report.reason = 'MISSING_ENVIRONMENT_CAPABILITY'; return false; }
    const observation = observer.armObservation(expected);
    let value;
    try {
      value = mode === 'locality'
        ? await helper.inspectCursorSnapshotWindowsLocalityDetailed(candidate, false)
        : await helper.inspectCursorSnapshotWindowsAclDetailed(candidate, true);
      await observation.awaitReaping();
    } catch {
      report.reason = 'UNEXPECTED_HELPER_EXCEPTION';
    } finally { observer.disarmObservation(); }
    const launch = observation.snapshot();
    const safe = observer.sanitizeHelper(value);
    steps.push({ step, helper: safe, observation: launch });
    if (launch.identicalTupleForwarded && !launch.closeSeen) {
      allClosed = false; report.reason = 'CHILD_CLOSE_UNOBSERVED'; return false;
    }
    if (launch.shapeBlocked) { report.reason = 'LAUNCH_SHAPE'; return false; }
    if (launch.observerFault) { report.reason = 'OBSERVER_FAULT'; return false; }
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EMFILE', 'ENFILE', 'EINVAL'].includes(launch.spawnErrorFamily)) {
      report.reason = 'MISSING_SPAWN_CAPABILITY'; return false;
    }
    if (!value || ['not-windows', 'invalid-environment', 'invalid-target', 'spawn-failed'].includes(safe.outcome)) {
      report.reason = 'HELPER_CAPABILITY_BLOCK'; return false;
    }
    return true;
  };
  // The existing ordinary temp parent must pass the unchanged native locality
  // helper before the sole filesystem creation. No fallback parent is tried.
  if (!(await sample('PARENT_LOCALITY', targetParent, 'locality'))) return report;
  if (steps[0].helper.outcome !== 'verified-local') {
    report.reason = 'PARENT_LOCALITY_UNVERIFIED'; return report;
  }
  try {
    target = await createFixture(targetParent);
    report.fixtureCreated = true;
    if (canonicalize(target) !== target || path.win32.dirname(target) !== targetParent ||
        !/^agentvac-acl-startup-[A-Za-z0-9]+$/.test(path.win32.basename(target))) {
      report.reason = 'FIXTURE_SHAPE'; return report;
    }
    for (const [step, mode] of [
      ['FIXTURE_LOCALITY_BEFORE', 'locality'], ['FIXTURE_ACL', 'acl'], ['FIXTURE_LOCALITY_AFTER', 'locality'],
    ]) {
      if (!(await sample(step, target, mode))) return report;
    }
    report.status = 'OBSERVED';
    report.reason = 'FIXED_SEQUENCE_COMPLETE';
    return report;
  } catch {
    report.reason = 'FIXTURE_CAPABILITY'; return report;
  } finally {
    // Empty generated directory only; no recursion, ACL change, private copy,
    // alternate destination, retry, or fixture deletion while close is unknown.
    if (report.fixtureCreated && allClosed) {
      try { await removeFixture(target); report.fixtureRemoved = true; }
      catch { report.status = 'BLOCKED'; report.reason = 'FIXTURE_CLEANUP_CAPABILITY'; }
    }
  }
}

export async function runReviewedWindows(sourceRoot, root) {
  try { await verifyArtifacts(root); }
  catch { return blockedReceipt('ARTIFACT_PIN'); }
  let lock;
  try {
    lock = JSON.parse(await readFile(path.join(root, 'source-lock.json'), 'utf8'));
    await verifySource(sourceRoot, lock);
  } catch { return blockedReceipt('SOURCE_PIN'); }
  if (process.platform !== 'win32') return blockedReceipt('PLATFORM_NOT_WINDOWS');
  const observer = await import('./observer.mjs');
  const helper = await import('./helper.observed.mjs');
  const report = await runFixedSequence({
    helper, observer, lock, parent: os.tmpdir(), env: () => process.env,
    createFixture: (parent) => mkdtemp(path.win32.join(parent, 'agentvac-acl-startup-')),
    removeFixture: (target) => rmdir(target),
  });
  return { ...report, sourcePinned: true, bundlePinned: true,
    sourceScriptSha256: lock.scriptSha256, sourceScriptUtf16Bytes: lock.scriptUtf16Bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== '--run-reviewed-windows' || process.argv[3] !== '--source-dir')
      throw new Error('INPUT');
    const report = await runReviewedWindows(path.resolve(process.argv[4]), path.dirname(fileURLToPath(import.meta.url)));
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = receiptExitCode(report);
  } catch {
    process.stdout.write(JSON.stringify(blockedReceipt('UNEXPECTED_HARNESS_ERROR')) + '\n');
    process.exitCode = 2;
  }
}
