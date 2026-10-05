#!/bin/bash
set -euo pipefail
export PYTHONPATH="$PWD/docs/native-linux/debian-tools/trash-root/usr/lib/python3/dist-packages${PYTHONPATH:+:$PYTHONPATH}"
batch="$PWD/.qa/agentvac-demo-57fOo5/.agentvac-quarantine/cebcf7c1-d379-4b16-9957-42a2832e18d0"
test ! -e "$batch"
test -d "$HOME/.local/share/Trash/files/cebcf7c1-d379-4b16-9957-42a2832e18d0"
grep -Fx "Path=$batch" "$HOME/.local/share/Trash/info/cebcf7c1-d379-4b16-9957-42a2832e18d0.trashinfo"
python3 -c 'import sys, psutil; print("Interpreter:", sys.executable); print("psutil:", psutil.__version__)'
python3 -u docs/native-linux/debian-tools/trash-root/usr/bin/trash-restore --sort path "$batch" 2>&1 | tee docs/native-linux/persistent-trash-gio/standard-trash-restore.log
printf 'Official standard Trash restore exited successfully.\n' | tee -a docs/native-linux/persistent-trash-gio/standard-trash-restore.log
