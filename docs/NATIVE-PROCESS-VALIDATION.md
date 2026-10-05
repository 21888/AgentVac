# Process-guard validation changes (unreleased)

The provider mutation guard is still conservative. An incomplete inventory or
unattributed runtime remains blocked; successful file fixtures do not establish
compatibility with an installed vendor runtime.

## Enumeration correctness

- macOS uses `/bin/ps -A -o <fields>` explicitly. Apple's `-e` semantics vary
  between UNIX2003 and legacy compatibility modes; the latter can select
  environment output. No environment disclosure was observed in our runs. The
  change removes that flag ambiguity. Linux retains its separate `-eo` form.
- Linux runtime hints identify candidates such as Node's `MainThread`; they do
  not exclude a PID. A bounded owned child collects stable PID/parent/start,
  executable and argument observations. Missing, inaccessible, oversized or
  changing observations remain unknown. All proc filesystem work is outside the
  main process; cancellation retains child ownership until close.
- Application-owned helper exclusions continue to require the existing exact
  executable/parent-chain checks. There is no fixture PID or process-name bypass.

Apple references: [ps option implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.c),
[ps manual](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.1).

## Same native fixture, plain compiled driver

`scripts/build-native-provider-harness.mjs` bundles the original
`native-provider-regression.mjs` and its TypeScript dependencies with esbuild.
The workflow launches the resulting absolute `.mjs` path with ordinary Node,
without a tsx loader or preload. The original fixture implementation is unchanged:
real Electron preload/IPC, production guards and sandbox settings still apply.

Before any fixture or application launch, the driver verifies its bundle hash,
the separate process-worker hash and their local source hashes. Its local evidence records these hashes,
revision/run identity and Node-normalized `process.argv`/`execArgv`. These are not
claimed to be immutable raw OS launch arguments. Unexpected runtime flags,
`NODE_OPTIONS`, extra operands or source drift refuse the run. CI requires this
receipt in addition to successful mutation/restart/recovery evidence.

This removes the harness's explicit loader ambiguity. It does not guarantee a
clear inventory: other unattributed runtimes still block. A plain Node 24 Linux
child can itself appear as `MainThread`, requiring a valid current observation.
Such blocks remain failures of the required mutation gate, never passes or skips.

## Separate argv research

The Linux current-observation path is integrated in this unreleased development
snapshot and still requires final review/native acceptance. Windows and macOS
collectors remain separate research modules. Stable observations cannot prove immutable launch identity,
exclude a deliberately disguised same-user process, or prevent a new writer
starting later. Source identity revalidation, durable journals and non-overwriting
recovery remain necessary. The macOS environment-capable native-buffer privacy
boundary is unresolved and its collector remains disabled. The Linux path neither
reads nor verifies a process environment. Hidden imports through environment
variables or arbitrary script code are outside argv attribution; explicit
all-clients-closed confirmation and filesystem guards remain required.
