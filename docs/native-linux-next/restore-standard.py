"""Invoke official Debian trash-restore for this exact generated batch only."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

project = Path('/workspace/scratch/4f36639a43c1/AgentVac-next')
result = json.loads((project / 'docs/native-linux-next/trash-roundtrip-results.json').read_text())
assert result['fixtureOnly'] is True
assert result['stage'] == 'awaiting_standard_system_trash_restore'
batch = Path(result['batchDirectory'])
batch_id = result['batchId']
assert re.fullmatch(r'[0-9a-f-]{36}', batch_id)
assert batch.name == batch_id
assert str(batch).startswith(str(project / '.qa/manual-'))
assert batch.parent.name == '.agentvac-quarantine'
assert not batch.exists()
trash = Path.home() / '.local/share/Trash'
info = trash / 'info' / (batch_id + '.trashinfo')
payload = trash / 'files' / batch_id
raw = info.read_text()
original = [unquote(line[5:]) for line in raw.splitlines() if line.startswith('Path=')]
assert original == [str(batch)]
assert payload.is_dir()
print('Exact generated Trash entry:', payload)
print(raw)
print('Restoring through unmodified Debian trash-restore; no other entry is selected.', flush=True)
base = Path('/workspace/scratch/4f36639a43c1/AgentVac/docs/native-linux/debian-tools/trash-root/usr')
env = dict(os.environ)
env['PYTHONPATH'] = str(base / 'lib/python3/dist-packages')
subprocess.run([sys.executable, '-u', str(base / 'bin/trash-restore'), '--sort', 'path', str(batch)], env=env, check=True)
assert batch.is_dir()
print('Official standard XDG Trash restoration completed.', flush=True)
