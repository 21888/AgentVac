#!/bin/sh
date -u
printf '\nDesktop environment\n'
printf 'DISPLAY=%s\nXDG_CURRENT_DESKTOP=%s\nTMPDIR=%s\nHOME=%s\n' "$DISPLAY" "$XDG_CURRENT_DESKTOP" "$TMPDIR" "$HOME"
printf '\nTrash helper availability\n'
for helper in gio gvfs-trash trash-put kioclient5 kioclient; do command -v "$helper" || true; done
printf '\nRelevant desktop packages\n'
dpkg-query -W gvfs gvfs-backends gvfs-daemons libfuse2 libfuse2t64 libglib2.0-bin 2>/dev/null || true
printf '\nTrash backend process names\n'
ps -eo comm= | grep -E 'gvfs|dbus|thunar|Thunar' || true
printf '\nGenerated fixture batch and trash directories\n'
ls -ld /dev/shm/codex-orbit-desktop/runtime-G33Hzr/agentvac-demo-QtpxaY/.agentvac-quarantine/fa254d1c-ee7b-467e-8d2d-deae1af54fa4 "$HOME/.local/share/Trash" /dev/shm/.Trash /dev/shm/.Trash-1000 2>/dev/null || true
if command -v gio >/dev/null 2>&1; then
  printf '\nNative Trash read-only inventory\n'
  gio info -a access::can-trash /dev/shm/codex-orbit-desktop/runtime-G33Hzr/agentvac-demo-QtpxaY/.agentvac-quarantine/fa254d1c-ee7b-467e-8d2d-deae1af54fa4
  gio list trash:///
fi
