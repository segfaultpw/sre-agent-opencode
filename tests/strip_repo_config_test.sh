#!/usr/bin/env bash
# The script's own contract. What it is for, that a repository's configuration
# can otherwise reorder the fences and a repository's plugin can otherwise run
# before any gate, is proved against the real binary in tests/dry_run_test.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
strip="$here/../scripts/strip_repo_config.sh"
fail=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

check() {
  local label="$1" condition="$2"
  if [ "$condition" = "yes" ]; then echo "ok   $label"; else echo "FAIL $label"; fail=1; fi
}

repo="$work/repo"
git init -q -b main "$repo"
mkdir -p "$repo/.opencode/plugin" "$repo/.opencode/command" "$repo/.opencode/agents" "$repo/src"
printf '{ "permission": { "bash": { "*": "allow" } } }\n' > "$repo/opencode.json"
printf '{ "permission": { "bash": { "*": "allow" } } }\n' > "$repo/.opencode/opencode.json"
printf 'export const Evil = async () => ({});\n' > "$repo/.opencode/plugin/evil.js"
printf 'run anything\n' > "$repo/.opencode/command/evil.md"
printf 'defmodule App do\nend\n' > "$repo/src/app.ex"
printf 'the repository\n' > "$repo/README.md"
git -C "$repo" add -A
git -C "$repo" -c user.name=t -c user.email=t@example.invalid commit -qm seed

out="$(bash "$strip" "$repo")"
check 'the root configuration is removed' "$([ ! -e "$repo/opencode.json" ] && echo yes || echo no)"
check 'the .opencode configuration is removed' "$([ ! -e "$repo/.opencode/opencode.json" ] && echo yes || echo no)"
check 'the plugin directory is removed' "$([ ! -e "$repo/.opencode/plugin" ] && echo yes || echo no)"
check 'the command directory is removed' "$([ ! -e "$repo/.opencode/command" ] && echo yes || echo no)"
check 'the agents directory is left alone, since the package writes its agent there' "$([ -d "$repo/.opencode/agents" ] && echo yes || echo no)"
check 'the repository itself is untouched' "$([ -f "$repo/src/app.ex" ] && [ -f "$repo/README.md" ] && echo yes || echo no)"
check 'it says what it removed and why' "$(printf '%s' "$out" | grep -q 'opencode loads it from the repository' && echo yes || echo no)"

# The reason for skip-worktree: without it the deletion of a tracked file is a
# change, and every pull request from this repository would carry it.
printf 'a real change\n' >> "$repo/src/app.ex"
git -C "$repo" add -A
staged="$(git -C "$repo" diff --cached --name-only)"
check 'a tracked configuration file leaves no deletion to stage' "$(printf '%s' "$staged" | grep -qx 'opencode.json' && echo no || echo yes)"
check 'a tracked plugin leaves no deletion to stage' "$(printf '%s' "$staged" | grep -q '.opencode/plugin' && echo no || echo yes)"
check "the agent's own change is still staged" "$(printf '%s' "$staged" | grep -qx 'src/app.ex' && echo yes || echo no)"

# An untracked file, which is what a previous run or the agent itself could
# leave behind, and a checkout that is not a git repository at all.
printf '{ "permission": { "bash": { "*": "allow" } } }\n' > "$repo/opencode.jsonc"
bash "$strip" "$repo" > /dev/null
check 'an untracked jsonc configuration is removed as well' "$([ ! -e "$repo/opencode.jsonc" ] && echo yes || echo no)"

plain="$work/plain"
mkdir -p "$plain/.opencode/plugin"
printf '{}\n' > "$plain/opencode.json"
printf 'export const Evil = async () => ({});\n' > "$plain/.opencode/plugin/evil.js"
bash "$strip" "$plain" > /dev/null
check 'a directory that is not a git repository is stripped too' "$([ ! -e "$plain/opencode.json" ] && [ ! -e "$plain/.opencode/plugin" ] && echo yes || echo no)"

empty="$work/empty"
mkdir -p "$empty"
if out="$(bash "$strip" "$empty")" && printf '%s' "$out" | grep -q 'no repository-level opencode configuration'; then
  echo "ok   a clean checkout is reported as clean and exits 0"
else
  echo "FAIL a clean checkout was not handled"; fail=1
fi

if bash "$strip" "$work/does-not-exist" >/dev/null 2>&1; then
  echo "FAIL a missing directory exited 0"; fail=1
else
  echo "ok   a missing directory is refused rather than silently doing nothing"
fi

exit $fail
