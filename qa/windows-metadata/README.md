# AgentVac read-only Windows metadata helper: staged research

Status: source staged; Linux policy/parser tests pass. **Windows compilation and native Windows execution have not run. Not integrated, published, installed, enabled, or production-accepted.** This standalone directory is the only modified tree. A separate partial smoke proposal and fixture-only restricted-token experiment are staged under `docs/SMOKE-PROPOSAL.md`; neither has been run on Windows.

The helper replaces the proposed runtime PowerShell metadata bootstrap with a small source-built C++ executable using static MSVC CRT. It reads one framed request from a pipe and produces one fixed-size sanitized frame. It has no content-read, create, write-target, delete, chmod/ACL-write, elevation, privilege-enable, network, shell, module-loading, discovery, or logging path. It only writes its response to its stdout pipe. It opens targets with FILE_READ_ATTRIBUTES plus READ_CONTROL when necessary. GetSecurityInfo evaluates the handle opened by the native locality walk.

Start here:
- `docs/POLICY-AND-PROTOCOL.md`: exact policy and binary contract
- `docs/IDENTITY-CONTRACT.md`: what identity proves and the required pre-write integration contract
- `docs/WINDOWS-ACCEPTANCE.md`: standard-account build, fixture and safety acceptance gates
- `results/linux-tests.log`: actual Linux evidence
- `results/native-status.json`: actual native status, NOT_RUN

## Linux checks

Run `bash scripts/test-linux.sh`. Requires preinstalled g++ and Node 24; downloads nothing. It builds only two pure test tools under this directory's `build/`. The differential test reads the unchanged policy source in the sibling corrected development tree and verifies its SHA-256. The Windows translation unit is not compiled by this command.

Observed: 26,040 C++/existing-TypeScript policy comparisons, 522 path comparisons, malformed UTF-8/UTF-16/frame cases, response validation, binding and restricted-token-prefix checks; 50,000 deterministic bounded parser inputs under AddressSanitizer and UBSan. LeakSanitizer is disabled because this sandbox is ptrace-supervised; its first attempted execution was blocked by that runtime limitation. There is no claim of a leak-sanitizer pass.

## Scope boundaries

- Existing policy SHA-256: `497f00ba1caedfccb02e0ac69a1812cfaf6b37b301334c177cffb71f4f6a8dfd`.
- There is no reviewed executable receipt or native binary here. A build provenance file is not permission to run or trust an executable.
- `transport.mjs` requires an exact reviewed absolute helper path, expected binary hash, source-tree hash, review ID, trusted SystemRoot and pre-established trusted local/non-reparse installation. No PATH lookup, arbitrary command, command-line path input, Powershell fallback or fallback destination.
- `GetDriveTypeW` on the internally-derived GLOBALROOT volume root must be proven on supported native runners. Failure remains rejection; do not add a DOS/UNC fallback.
- A path-based native snapshot alone does not authorize writing private bytes. See the identity contract before app integration.
