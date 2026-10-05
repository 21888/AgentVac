# Isolated Linux observed-argv collection

This is a narrow adapter for stable observed argument bytes. It is not an
immutable launch attestation, an application lock, or permission to terminate a
process. The provider policy must leave all absent/failed observations unknown.

## Public boundary

- `collectLinuxArgumentObservations(requests, signal?)` accepts at most 64
  PID/optional expected parent, executable-path and start-ID requests. Valid
  batches preserve input order/length. Malformed batches of at most 64 yield
  `invalid-request`; oversized/non-array batches return no observations.
- Public callers cannot choose a helper, executable, environment, timeout,
  proc path or loader. The helper is the packaged
  `dist-electron/process-argv-worker.cjs`, also used by the fixed source and
  `.qa/native-harness` layouts. Packaged ASAR paths map to `asar.unpacked`.
- The main-process graph imports no proc/filesystem collector. `process.execPath`
  starts the worker without a shell or PATH lookup, with fixed heap and minimal
  environment values. It does not inherit environment, `NODE_OPTIONS`, execArgv
  or caller-controlled switches. All proc calls use the worker's separate
  libuv pool.

## Lifetime and transport bounds

Two owned workers may exist at once. A monotonic 5-second host deadline covers
the entire batch. Timeout, abort, protocol error and child errors return only
refusals promptly and target the retained `ChildProcess` handle with SIGKILL.
Admission remains occupied until `close`, including after `exit`, kill success,
kill failure or a returned refusal. No signal uses a PID supplied by a caller or
worker result. Successful observations are released only after a zero-status
child `close` and a complete validated protocol.

`shutdownLinuxArgumentObservationWorkers()` waits at most 500 ms and returns
`{closed,pending}`. It permanently closes admission before snapshotting jobs, so
concurrent/later collection requests cannot escape the drain. A pending child remains owned and retains its slot; shutdown
does not claim it was reaped. The normal process-exit hook retries only owned
handles. Worker EOF and heartbeat watchdogs handle loss of its parent pipe.
These are not universal OS guarantees: an uninterruptible kernel syscall can
delay process death, and a blocked JavaScript event loop can delay timers.

The wire protocol uses a bounded request and individual result frames, not
unbounded child IPC object deserialization. Limits are 640 KiB per request,
144 KiB per result frame and 64 frames plus a small terminator allowance per
response. A fixed-size frame buffer is reused. JSON parsing rejects duplicate
decoded keys (including escaped aliases), excessive depth/nodes/keys/items,
malformed Unicode, extra fields, PID/order/identity conflicts and trailing data.
Results are reconstructed from an allowlist. Omitted result indices remain
unavailable. Raw arguments and native errors are never logged or included in
error messages. Arguments necessarily cross the private worker pipe for the
requested observation; returned strings remain sensitive in-memory data.

## Proc scope and limitation

The worker-only collector is adapted from the separately reviewed Linux
development collector. It pins proc/PID directories, applies no-follow final
opens, checks file type/device, reads executable link metadata without opening
the executable, and compares PID/start/parent/executable/memory-bound metadata
around two exact-length NUL-byte snapshots. Limits remain 65,536 bytes and 512
arguments. UTF-8/control-data problems, short reads, redaction, exit, permission
failures and detected changes are refused. Neither `environ` nor executable
contents are opened.

Linux exposes mutable argv memory. The setproctitle branch can expose bytes
beyond the original argument area, so this collector never probes beyond the
observed argument span. Repeated reads cannot exclude every hostile boundary
change, same-path exec or ABA mutation. The caller must retain the observed-only
meaning and the existing conservative provider policy.

## Verification

The focused host suite exercises real owned Node/Python children with spaced
and extensionless entries, literal later script names, precise metadata/vector
round-trips, CJS main/ESM harness helper resolution, strict protocol faults,
pending-close saturation, deadlines, cancellation, bounded never-close shutdown,
parent EOF and closure of every directly spawned test process. PID-reuse and
permission races remain deterministic tests in the original collector suite;
no foreign process or vendor data is used. Node-based Linux execution is tested;
this suite does not claim an Electron-binary, packaged-distribution or other-OS
validation.

Primary references:

- [Node child-process events](https://nodejs.org/api/child_process.html): `close`
  follows process termination and stdio closure; a kill request is not proof of
  exit. The host uses separate result and ownership lifetimes.
- [Electron environment variables](https://www.electronjs.org/docs/latest/api/environment-variables):
  `ELECTRON_RUN_AS_NODE` selects Node behavior; no GUI worker is required.
- [Kernel proc documentation](https://docs.kernel.org/filesystems/proc.html):
  retained proc descriptors do not redirect to a replacement PID owner.
- [Linux cmdline interface](https://man7.org/linux/man-pages/man5/proc_pid_cmdline.5.html)
  and [kernel implementation](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/base.c):
  mutable argv and setproctitle limitations.
