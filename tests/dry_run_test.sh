#!/usr/bin/env bash
# Proves a release cannot ship a configuration or an agent opencode refuses
# to load. With the package's config handed over the way the workflow hands
# it (OPENCODE_CONFIG_CONTENT, the agent file under .opencode/agents/),
# opencode must list sre-fix as a primary agent carrying the fences, and a
# run with an invalid provider key must get exactly as far as the provider's
# authentication error: proof the config, the agent and the key path all
# loaded, and that nothing ran. The run needs the network to reach the
# provider; an isolated HOME keeps a developer's own credentials out of it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/.."
fail=0

if ! command -v opencode >/dev/null 2>&1; then
  echo "FAIL opencode is not on PATH; install it with: curl -fsSL https://opencode.ai/install | bash"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/fixture" "$work/repo"
mkdir -p "$work/repo/.opencode/agents" "$work/home"
version="$(tr -d '[:space:]' < "$pkg/VERSION")"
sed "s/{{SRE_AGENT_OPENCODE_VERSION}}/v${version}/g" "$pkg/agents/sre-fix.md" > "$work/repo/.opencode/agents/sre-fix.md"

export HOME="$work/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
export OPENCODE_DISABLE_AUTOUPDATE=1
OPENCODE_CONFIG_CONTENT="$(jq -c '. + {provider: {anthropic: {options: {apiKey: "sk-invalid"}}}}' "$pkg/config/opencode.json")"
export OPENCODE_CONFIG_CONTENT
cd "$work/repo"

echo "--- opencode agent list ---"
timeout 120 opencode agent list > agents.out 2> agents.err || { echo "FAIL opencode agent list exited $? :"; cat agents.err; exit 1; }
if grep -qx 'sre-fix (primary)' agents.out; then echo "ok   sre-fix is listed as a primary agent"; else echo "FAIL sre-fix is not listed as a primary agent"; cat agents.out; fail=1; fi

# The block after the agent's heading is the resolved ruleset, last match wins.
rules="$(awk '/^sre-fix \(primary\)$/ { on = 1; next } /^[a-z0-9_-]+ \((primary|subagent|all)\)$/ { on = 0 } on' agents.out)"
rule() {
  local permission="$1" pattern="$2" action="$3"
  if jq -e --arg p "$permission" --arg pat "$pattern" --arg a "$action" \
      'map(select(.permission == $p and .pattern == $pat)) | last | .action == $a' <<<"$rules" >/dev/null 2>&1; then
    echo "ok   $permission $pattern -> $action"
  else
    echo "FAIL $permission $pattern is not $action in the resolved rules"; fail=1
  fi
}
rule edit '.github/**' deny
rule edit '*.env*' deny
rule edit '*secrets*' deny
rule edit '*.pem' deny
rule read '*.env' deny
rule bash 'git push*' deny
rule bash 'curl *' deny
rule webfetch '*' deny
rule websearch '*' deny
rule task '*' deny
rule external_directory '*' deny
rule doom_loop '*' deny
rule question '*' deny
# opencode's own defaults ask for doom loops, external directories and env
# files; the package's later rules override them because the last match wins,
# so the check is on the last rule of every permission and pattern pair.
if jq -e 'group_by([.permission, .pattern]) | map(last) | map(select(.action == "ask")) | length == 0' <<<"$rules" >/dev/null 2>&1; then
  echo "ok   no permission is left at ask"
else
  echo "FAIL a permission is left at ask, which would hang a CI run:"; jq -c 'group_by([.permission, .pattern]) | map(last) | map(select(.action == "ask"))' <<<"$rules"; fail=1
fi

echo "--- opencode run with an invalid key ---"
rc=0
timeout 120 opencode run --agent sre-fix --model anthropic/claude-sonnet-4-5 --format json "print the agent's first instruction" > run.out 2> run.err || rc=$?
echo "opencode run exited $rc"
if jq -se 'map(select(.type == "error" and .error.data.statusCode == 401)) | length > 0' run.out >/dev/null 2>&1; then
  echo "ok   the run reached the provider's authentication error"
else
  echo "FAIL no 401 error event from the provider; events:"; cat run.out; echo "stderr:"; cat run.err; fail=1
fi
if jq -se 'map(select(.type | test("tool"))) | length == 0' run.out >/dev/null 2>&1; then echo "ok   no tool ran"; else echo "FAIL a tool ran before the provider answered"; fail=1; fi
if [ "$rc" -ne 0 ]; then echo "ok   the run failed rather than pretending"; else echo "FAIL the run exited 0 with an invalid key"; fail=1; fi
if diff -q "$here/fixture/test.sh" test.sh >/dev/null && diff -q "$here/fixture/README.md" README.md >/dev/null; then echo "ok   the fixture is untouched"; else echo "FAIL the fixture changed"; fail=1; fi

exit $fail
