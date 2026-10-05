#!/bin/bash
set -uo pipefail
cd /workspace/scratch/4f36639a43c1/AgentVac-next
export TMPDIR="$PWD/.qa"
export PATH="/workspace/scratch/4f36639a43c1/AgentVac/docs/native-linux/debian-tools/root/usr/bin:$PATH"
export DEBUG=pw:browser
node docs/native-linux-next/manual-suite.mjs > docs/native-linux-next/manual-run.log 2>&1
status=$?
printf '\nNative manual suite exit: %s\n' "$status" >> docs/native-linux-next/manual-run.log
exit "$status"
