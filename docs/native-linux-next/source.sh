#!/bin/bash
set -uo pipefail
cd /workspace/scratch/4f36639a43c1/AgentVac-next
export TMPDIR="$PWD/.qa"
export AGENTVAC_NATIVE_FIXTURE_BASE="$PWD/.qa"
export PATH="/workspace/scratch/4f36639a43c1/AgentVac/docs/native-linux/debian-tools/root/usr/bin:$PATH"
export DEBUG=pw:browser
out="$PWD/docs/native-linux-next"
sha256sum scripts/desktop-e2e.mjs dist-electron/*.cjs release-next/linux/linux-unpacked/resources/app.asar > "$out/source-input-sha256.txt"
node scripts/desktop-e2e.mjs > "$out/source-run.log" 2>&1
status=$?
cp docs/native-ci/next-linux-x64.json "$out/source-results.json"
printf '\nNative source suite exit: %s\n' "$status" >> "$out/source-run.log"
exit "$status"
