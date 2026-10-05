#!/bin/sh
set -eu
node docs/native-linux/source-sandboxed-e2e.mjs > docs/native-linux/source-sandboxed-run.log 2>&1
sh docs/native-linux/persistent-trash.sh
