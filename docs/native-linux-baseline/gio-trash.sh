#!/bin/sh
set -eu
export TMPDIR="$PWD/.qa"
export AGENTVAC_QA_OUT="$PWD/docs/native-linux/persistent-trash-gio"
export PATH="$PWD/docs/native-linux/debian-tools/root/usr/bin:$PATH"
export DEBUG=pw:browser
mkdir -p "$TMPDIR" "$AGENTVAC_QA_OUT"
gio version > "$AGENTVAC_QA_OUT/gio-version.log"
node docs/native-linux/package-trash-qa.mjs > "$AGENTVAC_QA_OUT/run.log" 2>&1
