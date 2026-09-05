#!/usr/bin/env bash
# The diff gate judges what a pull request actually changed, so its verdict
# is pinned path by path: a flagged path is printed and fails the gate, a
# clean list passes, and an empty list passes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/protected_paths.sh"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

flagged() {
  local path="$1" got rc=0
  got="$(printf '%s\n' "$path" | bash "$script")" || rc=$?
  if [ "$rc" -eq 1 ] && [ "$got" = "$path" ]; then echo "ok   flags $path"; else echo "FAIL $path: expected exit 1 printing the path, got exit $rc with '$got'"; fail=1; fi
}

clean() {
  local path="$1" got rc=0
  got="$(printf '%s\n' "$path" | bash "$script")" || rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$got" ]; then echo "ok   passes $path"; else echo "FAIL $path: expected exit 0 with no output, got exit $rc with '$got'"; fail=1; fi
}

flagged .github/workflows/x.yml
flagged .env
flagged src/.env.production
flagged config/secrets/x
flagged config/secrets.yml
flagged deploy.pem
flagged a/b/key.pem

clean src/app.ex
clean README.md
clean docs/environment.md
clean lib/pemdas.ex

rc=0
got="$(printf '' | bash "$script")" || rc=$?
if [ "$rc" -eq 0 ] && [ -z "$got" ]; then echo "ok   an empty list passes"; else echo "FAIL empty list: exit $rc, '$got'"; fail=1; fi

rc=0
got="$(printf 'src/app.ex\n.env\nREADME.md\nconfig/secrets.yml\n' | bash "$script")" || rc=$?
if [ "$rc" -eq 1 ] && [ "$got" = $'.env\nconfig/secrets.yml' ]; then echo "ok   a mixed list prints only the protected paths"; else echo "FAIL mixed list: exit $rc, '$got'"; fail=1; fi

exit $fail
