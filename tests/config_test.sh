#!/usr/bin/env bash
# The fences are the package's whole contract with the customer, so each one
# is pinned by name: a key renamed by an edit would otherwise turn a deny
# into opencode's default, which is "ask", and "ask" in a CI run with nobody
# to answer hangs the job until its time bound.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$here/../config/opencode.json"
agent="$here/../agents/sre-fix.md"
fail=0

expect() {
  local path="$1" want="$2" got
  got="$(jq -r "$path" "$cfg")"
  if [ "$got" = "$want" ]; then echo "ok   $path = $want"; else echo "FAIL $path: expected $want, got $got"; fail=1; fi
}

if jq empty "$cfg" 2>/dev/null; then echo "ok   config parses"; else echo "FAIL config does not parse"; exit 1; fi
expect '.share' disabled
expect '.default_agent' sre-fix
expect '.instructions | join(",")' 'AGENTS.md,CONTRIBUTING.md'
expect '.permission.edit["*"]' allow
expect '.permission.edit[".github/**"]' deny
expect '.permission.edit["*.env*"]' deny
expect '.permission.edit["*secrets*"]' deny
expect '.permission.edit["*.pem"]' deny
# opencode compiles a pattern to an anchored regex with "*" as ".*" and "/"
# literal, so a "**/" prefix demands a slash and skips the repository root.
if jq -e '.permission.edit | keys | map(select(startswith("**/"))) | length == 0' "$cfg" >/dev/null; then
  echo "ok   no edit pattern starts with **/"
else
  echo "FAIL an edit pattern starts with **/ and cannot match a root-level file"; fail=1
fi
expect '.permission.read["*"]' allow
expect '.permission.read["*.env"]' deny
expect '.permission.read["*.env.*"]' deny
expect '.permission.read["*.env.example"]' allow
expect '.permission.bash["*"]' allow
expect '.permission.bash["git push*"]' deny
expect '.permission.bash["git remote*"]' deny
expect '.permission.bash["curl *"]' deny
expect '.permission.bash["wget *"]' deny
expect '.permission.bash["ssh *"]' deny
expect '.permission.bash["scp *"]' deny
expect '.permission.bash["rm -rf *"]' deny
expect '.permission.bash["sudo *"]' deny
expect '.permission.webfetch' deny
expect '.permission.websearch' deny
expect '.permission.task' deny
expect '.permission.external_directory' deny
expect '.permission.doom_loop' deny
expect '.permission.question' deny

# The agent file: frontmatter keys and the version placeholder the workflow fills.
check() {
  local pattern="$1" label="$2"
  if grep -q -- "$pattern" "$agent"; then echo "ok   $label"; else echo "FAIL $label"; fail=1; fi
}
check '^description: ' 'agent has a description'
check '^mode: primary$' 'agent is primary'
check '{{SRE_AGENT_OPENCODE_VERSION}}' 'agent carries the version placeholder'
check 'Declined:' 'agent knows the decline prefix'
check 'sre-agent:remediation' 'agent copies the platform marker'
check 'sre-agent-opencode:{{SRE_AGENT_OPENCODE_VERSION}}' 'agent writes the stamp line'
if grep -q 'git push\|open a pull request yourself\|never commit' "$agent"; then echo "ok   agent is told the action commits and pushes"; else echo "FAIL agent push contract"; fail=1; fi

if grep -q $'\xe2\x80\x94' "$agent" "$cfg" "$here/../README.md"; then echo "FAIL em dash present"; fail=1; else echo "ok   no em dash"; fi
exit $fail
