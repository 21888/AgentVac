# Detached Windows PowerShell startup observation

This is a **source-only QA proposal**. It has not run on Windows. Production
acceptance remains false. It does not change or repair the production helper.

The hosted evidence is narrow: the ordinary temporary-parent locality call
returned `verified-local` after 3,446 ms, exit 0. Four later ACL calls returned
`helper-failed` before the helper's `started` marker, exit 4,294,901,760
(`0xffff0000`), with 284 stderr bytes each. Their elapsed times were 108, 53, 53,
and 52 ms. The available log does not contain those stderr bytes. The exit value
alone identifies neither an HRESULT nor the underlying cause.

## Design and boundaries

- `prepare.mjs` reads the exact hash-pinned `cursor-windows-acl.ts`. Its esbuild
  plugin substitutes **only that module's** `node:child_process` import. All
  other source routes are explicitly enumerated. The native adapter's own import
  still resolves to the real Node child-process module.
- `observer.mjs` validates the fixed executable, seven arguments, public script
  hash and length, four option keys, cwd, stdio, windowsHide, and the complete
  helper-filtered environment. It then passes the original executable, argument
  array, options object, receiver, and returned child through unchanged.
- The wrapper adds read-only listeners. It does not call kill, write, pipe,
  setEncoding, pause, resume, unref, or change environment variables. The original
  helper retains its own five-second timer, output limits, abort behavior,
  kill decision, phase recognition, ACL policy, and result classification.
- Original stdout buffering and JSON validation remain inside the unchanged
  helper. The observer does not retain stdout records. It counts bytes only.
- Stderr recognition uses finite-state match positions, fixed byte patterns,
  boolean byte classes and bounded counters. It never retains a raw chunk,
  decoded line, tail, arbitrary error message, matched text, or native record.
  Nothing writes native output to disk. Its report contains only fixed enums,
  booleans, bounded counts, and public source-script hash/length metadata.
- Tokens are recognized in ASCII/UTF-8, UTF-16LE and UTF-16BE, across arbitrary
  chunk boundaries. Fixed BOM and CLIXML preamble enums and zero-byte counts
  provide encoding evidence even when no error family is recognized. It does
  not parse or deserialize CLIXML. Localized, escaped or unsupported text can
  remain unknown; unknown content is never included in the result.

The family enums identify observed text tokens, **not a confirmed root cause**:
`MANAGED_POWERSHELL_LOAD`, `SHELL_INITIALIZATION`, `CLR_INITIALIZATION`.
The fixed HRESULT token set is `H8009001D`, `H80070002`, `H80070003`, `H80070005`,
`H80131500`, `H80131700`. Hexadecimal boundaries prevent recognizing a token
inside a longer hexadecimal value. Unknown HRESULTs are not copied out.
`HOST_FFFF0000` is an exit-family enum, separately recorded; it never produces
an HRESULT or startup-family inference by itself.

## Fixed native sequence, only after review

The native runner has no caller-selected data target. It performs at most four
unchanged-helper calls, sequentially, using the same filtered parent inputs:

1. Read-only locality validation of the ordinary OS temporary parent.
2. If and only if that succeeds and child close is observed, create one empty
   generated directory there and perform its locality check.
3. Perform one ACL check of that same generated directory, using its existing
   inherited ACL. No permission setup or repair takes place.
4. Perform one final locality check of that same generated directory.

Each actual call is recorded exactly once. Ordinary ACL/startup rejection does
not trigger a retry or suppress the scheduled final locality call. Source or
launch-shape mismatch, missing environment/spawn capability, observer fault or
unobserved child close stops further launches. A failed parent locality check
prevents fixture creation. No fallback directory, bootstrap change, provider
data, private copy, ACL modification or native GUI is involved.

After each helper result, a separate maximum two-second observation wait records
whether the child `exit` and `close` events arrived. This does not change the
helper timeout or kill/reaping decisions. A missing close is reported as
`BLOCKED / CHILD_CLOSE_UNOBSERVED`; an existing fixture is retained, and no later
helper is started. The observer cannot guarantee process termination: if the
original helper's kill does not close the process, its live handle may keep Node
running. The runner does not force-exit or claim it reaped that child.

After observed child closure the runner removes only the empty generated
directory using nonrecursive `rmdir`. Cleanup failure is a separate fixed
BLOCKED reason. Raw paths, SIDs, argv, environment values, arbitrary errors,
stdout ACL records and stderr are never report fields.

Every v2 receipt lists all four expected steps, including steps that did not run.
Each row contains the unchanged observed helper `outcome`, or `NOT_RUN` with the
explicit blocking reason. `verified`, `rejected`, `capabilityBlocked`,
`helperFailed` and `notRun` form five exclusive count buckets totaling four.
`failed` is the sum of rejection, capability-block and helper-failure counts.
`observed` counts attempted helper calls; `skipped` is always zero because this
fixed native sequence permits no optional skips. A missing case is `NOT_RUN`.

`missingEvidence` counts unattempted steps plus observed calls lacking a forwarded
launch, child-close evidence, or a functioning observer. It overlaps the outcome
buckets and does not change any helper verdict. For example, non-Windows
capability yields four `NOT_RUN / PLATFORM_NOT_WINDOWS` rows, zero observed calls,
and four missing-evidence cases. It does not invent four native spawn failures.

A complete sequence with any rejection or helper/capability failure is
`OBSERVED_WITH_BLOCKS / FIXED_SEQUENCE_COMPLETED_WITH_BLOCKS`, with process exit 2.
Only four verified observations with complete launch evidence produce
`OBSERVED_ALL_VERIFIED / FIXED_SEQUENCE_COMPLETE`, exit 0. Any early stop or
cleanup block remains `BLOCKED`, exit 2. These statuses describe this diagnostic
sequence only. Every receipt explicitly contains `productionAccepted:false`;
neither a diagnostic exit 0 nor green source tests establish app acceptance.
Counters saturate at stderr 16,385, stdout 65,537, and elapsed 60,000 ms. The
scanner examines at most 16,384 stderr bytes. Instrumentation adds bounded
listener/scan overhead, so this proves launch/result equivalence under the fake
traces, not identical wall-clock scheduling on Windows.

## Reviewed source and generated bundle pins

`source-lock.json` fixes the helper SHA-256/length, public PowerShell script
SHA-256/UTF-16 length, and esbuild 0.25.12. The public hosted base revision is
provenance from the prior publication receipt; this detached input has no local
Git metadata. Runtime checks require exact helper bytes and exactly one matching
helper record in `SOURCE-SHA256.json`. The publication process separately pins
its newly generated full source manifest. It must not reuse the old whole-
manifest hash as a circular runtime gate.

`artifact-lock.json` fixes every runtime source file plus the expected generated
bundle hash/length. It is the reviewed trust lock. Keep its reviewed bytes in the
outer publication manifest. Native `prepare.mjs` verifies the source artifacts,
builds in memory, compares the result to the expected bundle pin, and only then
writes `helper.observed.mjs`. It never creates or rewrites the trust lock.

Publish only the names in `publish-files.json`; **omit the generated bundle**,
local freeze tool, test logs and local evidence. `freeze-local.mjs` is for local
review maintenance only. Any source edit requires a new local freeze, retest,
and review before publication; never run that freeze tool on hosted QA.

From the published `qa/windows-acl-startup` folder, using already installed
dependencies in the pinned source checkout:

```text
node prepare.mjs --source-dir ../..
node --test tests.mjs
```

Only after the proposal has been reviewed and a Windows run authorized:

```text
node run.mjs --run-reviewed-windows --source-dir ../..
```

No command installs anything or launches CI. Non-Windows invocation returns
`BLOCKED / PLATFORM_NOT_WINDOWS` without running PowerShell or creating a fixture.
An unexpected launcher/build failure produces a fixed error code, not its raw
exception. Missing capability and recognized startup-family evidence are separate.

## Upstream context

[PowerShell issue 3545](https://github.com/PowerShell/PowerShell/issues/3545)
reports a managed PowerShell startup failure under `-UseNewEnvironment`.
[Issue 4671](https://github.com/PowerShell/PowerShell/issues/4671) discusses
missing standard variables in that mode. These are relevant hypotheses for
choosing the fixed recognizers; they do not establish the AgentVac failure's
cause. This proposal does not add environment variables or alter bootstrap.
