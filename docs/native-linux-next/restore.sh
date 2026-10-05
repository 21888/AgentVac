#!/bin/bash
set -euo pipefail
cd /workspace/scratch/4f36639a43c1/AgentVac-next
python3 -u docs/native-linux-next/restore-standard.py 2>&1 | tee docs/native-linux-next/standard-trash-restore.log
