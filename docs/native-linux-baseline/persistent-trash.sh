#!/bin/sh
set -eu
export TMPDIR="$PWD/.qa"
export AGENTVAC_QA_OUT="$PWD/docs/native-linux/persistent-trash-sandboxed"
mkdir -p "$TMPDIR" "$AGENTVAC_QA_OUT"
node docs/native-linux/package-trash-qa.mjs > "$AGENTVAC_QA_OUT/run.log" 2>&1
