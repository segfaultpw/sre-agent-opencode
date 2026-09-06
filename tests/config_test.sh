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
# The mutating denies matter to a runner on a customer's machine, where the
# role the machine holds can reach live systems. They are a second line: the
# boundary is that role, and the read-only posture comes from granting one.
expect '.permission.bash["kubectl delete*"]' deny
expect '.permission.bash["kubectl apply*"]' deny
expect '.permission.bash["kubectl edit*"]' deny
expect '.permission.bash["kubectl patch*"]' deny
expect '.permission.bash["kubectl scale*"]' deny
expect '.permission.bash["kubectl rollout*"]' deny
expect '.permission.bash["kubectl exec*"]' deny
expect '.permission.bash["kubectl cordon*"]' deny
expect '.permission.bash["kubectl drain*"]' deny
expect '.permission.bash["helm upgrade*"]' deny
expect '.permission.bash["helm install*"]' deny
expect '.permission.bash["helm uninstall*"]' deny
expect '.permission.bash["terraform apply*"]' deny
expect '.permission.bash["terraform destroy*"]' deny
# AWS is denied by verb family rather than by service, because a list of
# services is a list that goes stale. "*" compiles to ".*", which matches a
# space, so "aws * delete-*" reaches "aws ec2 delete-security-group";
# tests/pattern_probe_test.sh proves that rather than assuming it.
for verb in create delete put update modify terminate start stop reboot attach detach \
            associate disassociate register deregister enable disable add remove reset \
            restore import copy cancel accept reject replace revoke authorize tag untag \
            publish upload invoke run send set; do
  expect ".permission.bash[\"aws * ${verb}-*\"]" deny
done
# The four s3 verbs and the two session doors carry no verb prefix.
expect '.permission.bash["aws s3 cp*"]' deny
expect '.permission.bash["aws s3 mv*"]' deny
expect '.permission.bash["aws s3 rm*"]' deny
expect '.permission.bash["aws s3 sync*"]' deny
expect '.permission.bash["aws ssm start-session*"]' deny
expect '.permission.bash["aws ecs execute-command*"]' deny
# Last match wins, so a deny placed before the catch-all would not fire.
if jq -e '.permission.bash | keys_unsorted | index("*") == 0' "$cfg" >/dev/null; then
  echo "ok   the bash catch-all comes before every deny"
else
  echo "FAIL the bash catch-all is not the first rule, so a later allow would win"; fail=1
fi
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
# One prompt serves both doors. Two copies would drift, and the CI door's
# live proof is what validated these steps.
check 'workflow or runner that runs you' 'agent names both doors'
check 'no repository was resolved' 'agent knows the untargeted case'
if grep -q "this repository's own CI" "$agent"; then echo "FAIL agent still assumes it was started by CI"; fail=1; else echo "ok   agent does not assume the CI door"; fi
if grep -q 'git push\|open a pull request yourself\|never commit' "$agent"; then echo "ok   agent is told the action commits and pushes"; else echo "FAIL agent push contract"; fail=1; fi

if grep -q $'\xe2\x80\x94' "$agent" "$cfg" "$here/../README.md"; then echo "FAIL em dash present"; fail=1; else echo "ok   no em dash"; fi
exit $fail
