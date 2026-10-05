#!/bin/sh
out="$PWD/docs/native-linux/persistent-trash-gio/trash-inventory.log"
{
  date -u
  "$PWD/docs/native-linux/debian-tools/root/usr/bin/gio" trash --list
  printf 'gio_list_exit=%s\n' "$?"
  printf '\nExact generated-batch system metadata\n'
  cat "$HOME/.local/share/Trash/info/cebcf7c1-d379-4b16-9957-42a2832e18d0.trashinfo"
  printf '\nExact generated-batch presence\n'
  ls -ld "$HOME/.local/share/Trash/files/cebcf7c1-d379-4b16-9957-42a2832e18d0"
} > "$out" 2>&1
