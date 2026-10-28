#!/usr/bin/env bash
# The diff gate judges what a pull request actually changed, so its verdict
# is pinned path by path: a flagged path is printed and fails the gate, a
# clean list passes, and an empty list passes. The shapes are the edit
# fence's, matched against the whole path, so anything the fence would have
# refused the file tools is refused here after the fact as well.
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
flagged config/app-secrets.json
flagged my_secrets_dir/x.txt
flagged app.secrets.yml
flagged values-secrets.yaml
# It merely contains "secrets", but the fence denies it, so the gate does too.
flagged docs/secretsauce.md
flagged deploy.pem
flagged a/b/key.pem

# The runner copies an agent's notes into .sre-agent-memory/ and removes the
# copy before it stages anything. A copy that survived (or one a repository
# tracks) must still never reach a pull request, so the gate refuses a staged
# .sre-agent-memory path at any depth. The edit fence does not name it, which
# is why tests/gate_agreement_test.sh does not list it.
flagged .sre-agent-memory/NOTES.md
flagged .sre-agent-memory/scripts/check.sh
flagged .sre-agent-memory/x
flagged services/api/.sre-agent-memory/NOTES.md

clean src/app.ex
clean README.md
clean docs/environment.md
clean lib/pemdas.ex
clean docs/.sre-agent-memory.md
clean .sre-agent-memory-notes/x

rc=0
got="$(printf '' | bash "$script")" || rc=$?
if [ "$rc" -eq 0 ] && [ -z "$got" ]; then echo "ok   an empty list passes"; else echo "FAIL empty list: exit $rc, '$got'"; fail=1; fi

rc=0
got="$(printf 'src/app.ex\n.env\nREADME.md\nconfig/secrets.yml\n' | bash "$script")" || rc=$?
if [ "$rc" -eq 1 ] && [ "$got" = $'.env\nconfig/secrets.yml' ]; then echo "ok   a mixed list prints only the protected paths"; else echo "FAIL mixed list: exit $rc, '$got'"; fail=1; fi

rc=0
got="$(printf 'src/app.ex\n.sre-agent-memory/NOTES.md\n' | bash "$script" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && [ "$got" = ".sre-agent-memory/NOTES.md" ]; then echo "ok   a staged .sre-agent-memory path is refused"; else echo "FAIL .sre-agent-memory list: exit $rc, '$got'"; fail=1; fi

# The list the gate judges is built by git, and git's default listing QUOTES a name that holds a non-ASCII or
# special character ("\"...\\303\\251...\""), which begins with a quote and so matches no prefix rule: a workflow file with
# such a name passed the gate. The runner lists staged names with core.quotePath=false and -z; this proves, in a
# scratch repository, that the real name reaches the gate and is refused, and that the default listing is the one
# that would have slipped through (so the runner must not go back to it). The default is pinned with
# core.quotePath=true because a machine may set it false globally, and the assertion must hold on any machine.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git -C "$scratch" init -q .
mkdir -p "$scratch/.github/workflows" "$scratch/src"
printf 'on: push\n' > "$scratch/.github/workflows/caf$(printf '\303\251').yml"
printf 'x\n' > "$scratch/src/app.ex"
git -C "$scratch" add -A
rc=0
got="$(git -C "$scratch" -c core.quotePath=true diff --cached --name-only | bash "$script")" || rc=$?
if [ "$rc" -eq 0 ]; then echo "ok   the default listing quotes the name and the gate's .github/ rule does not see it (the hole the runner's listing closes)"; else echo "FAIL the default listing no longer hides the name: exit $rc, '$got'"; fail=1; fi
rc=0
got="$(git -C "$scratch" -c core.quotePath=false diff --cached --name-only -z --no-renames | tr '\0' '\n' | bash "$script")" || rc=$?
if [ "$rc" -eq 1 ] && [ "$got" = ".github/workflows/caf$(printf '\303\251').yml" ]; then echo "ok   the runner's listing (-z, quotePath off) hands the gate the real name, which it refuses"; else echo "FAIL runner listing: exit $rc, '$got'"; fail=1; fi

exit $fail
