#!/usr/bin/env bash
# Reads changed paths on stdin, one per line, prints every protected one and
# exits 1 when any was printed, 0 otherwise. Protected: a path under .github/,
# or any path component matching *.env*, secrets* or *.pem, the same shapes
# as the edit fence. The fence is opencode's edit tool gate; the agent also
# runs a shell, which can write a file without any tool, so the pull request's
# own file list is judged here, after the push, where nothing can walk around it.
set -euo pipefail

flagged=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  protected=0
  case "$path" in
    .github/*) protected=1 ;;
  esac
  if [ "$protected" -eq 0 ]; then
    IFS=/ read -r -a parts <<<"$path"
    for part in "${parts[@]}"; do
      case "$part" in
        *.env* | secrets* | *.pem)
          protected=1
          break
          ;;
      esac
    done
  fi
  if [ "$protected" -eq 1 ]; then
    printf '%s\n' "$path"
    flagged=1
  fi
done
exit "$flagged"
