#!/usr/bin/env bash
# Reads changed paths on stdin, one per line, prints every protected one and
# exits 1 when any was printed, 0 otherwise. It mirrors the edit fence in
# config/opencode.json: the whole checkout-relative path is matched, "*"
# crosses slashes as it does in opencode's matcher, and the shapes are the
# fence's own, .github/ at the root plus *.env*, *secrets* and *.pem. The
# fence is opencode's edit tool gate; the agent also runs a shell, which can
# write a file without any tool, so the pull request's own file list is
# judged here, after the push, where nothing can walk around it.
set -euo pipefail

flagged=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    .github/* | *.env* | *secrets* | *.pem)
      printf '%s\n' "$path"
      flagged=1
      ;;
  esac
done
exit "$flagged"
