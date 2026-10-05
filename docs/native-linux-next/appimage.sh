#!/bin/bash
set -uo pipefail
cd /workspace/scratch/4f36639a43c1/AgentVac-next
export TMPDIR="$PWD/.qa"
mkdir -p "$PWD/.qa/appimage-profile"
timeout 20s release-next/linux/AgentVac-0.1.0.AppImage "--user-data-dir=$PWD/.qa/appimage-profile" > docs/native-linux-next/appimage-run.log 2>&1
status=$?
printf '\nAppImage normal launch exit: %s\n' "$status" >> docs/native-linux-next/appimage-run.log
exit "$status"
