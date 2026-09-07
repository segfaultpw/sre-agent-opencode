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
# Those eight anchor at the first character, so they saw only the bare form.
# "curl x" was denied while "env curl x", "/usr/bin/curl x" and
# "HTTPS_PROXY=y curl x" were allowed, and "git push origin HEAD" was denied
# while "git -C /tmp/r push origin HEAD" was allowed. Those two are the denies
# that the claim about the runner being the only thing which touches git or
# the network rests on, so they take the same shape as every other family: a
# leading wildcard for a prefix, a wildcard after the binary for the flags.
expect '.permission.bash["*git *push *"]' deny
expect '.permission.bash["*git *remote *"]' deny
expect '.permission.bash["*curl *"]' deny
expect '.permission.bash["*wget *"]' deny
expect '.permission.bash["*ssh *"]' deny
expect '.permission.bash["*scp *"]' deny
expect '.permission.bash["*rm -rf *"]' deny
# The same careless step with its flags transposed, split, spelled out, or
# capitalised: -R is a valid rm flag and was allowed while -r was refused.
expect '.permission.bash["*rm -fr *"]' deny
expect '.permission.bash["*rm -fR *"]' deny
expect '.permission.bash["*rm -Rf *"]' deny
expect '.permission.bash["*rm -r *"]' deny
expect '.permission.bash["*rm -R *"]' deny
expect '.permission.bash["*rm -f *"]' deny
expect '.permission.bash["*rm --recursive*"]' deny
expect '.permission.bash["*rm --force*"]' deny
expect '.permission.bash["*sudo *"]' deny
# The ninth, and on the CI door it is a privilege escalation rather than a
# convenience: fix.yml puts GITHUB_TOKEN in the agent's environment, so
# "gh pr merge" and "gh api -X PUT" walk around the git push deny and the
# protected paths gate both, and the agent could merge its own pull request.
#
# One pattern per way of INVOKING it, rather than one for the two letters.
# "*gh *" denies "echo high five", and "* gh *" denies "grep gh file" and a
# commit message mentioning gh, which the agent has every reason to type while
# running the repository's own build. So: the bare form, both quoted forms
# (which slipped past all three of the previous patterns), any path form, an
# environment-variable prefix, and the env wrapper. "sudo gh" is covered by
# the sudo deny, and a backslash form is covered by the path one, since the
# matcher replaces a backslash with a slash in the resource as well as in the
# pattern. On the runner door this is the second line, the first being that
# the runner deletes GH_TOKEN and GITHUB_TOKEN from the environment it starts
# the agent in.
expect '.permission.bash["gh *"]' deny
expect ".permission.bash[\"*'gh' *\"]" deny
expect '.permission.bash["*\"gh\" *"]' deny
expect '.permission.bash["/*gh *"]' deny
expect '.permission.bash[".*/gh *"]' deny
expect '.permission.bash["*=* gh *"]' deny
expect '.permission.bash["*env gh *"]' deny
# The path forms anchor at the first character, because "*/gh *" denies
# "cat vendor/gh readme", where the path is an argument rather than the
# command. What that leaves open is a relative path with no leading dot, and
# an interpreter or a substitution producing the path, so the two subcommands
# that carry the escalation are denied wherever they appear: api is the
# universal one, since every REST call including a merge goes through it, and
# pr is the direct one.
expect '.permission.bash["*gh api *"]' deny
expect '.permission.bash["*gh pr *"]' deny
# And the three ways a shell is asked where the binary is, since a
# substitution that resolves it is its own command and can be refused there.
# Nothing needs to locate gh except something about to run it.
expect '.permission.bash["*which gh*"]' deny
expect '.permission.bash["*command -v gh*"]' deny
expect '.permission.bash["*type -p gh*"]' deny
# The mutating denies matter to a runner on a customer's machine, where the
# role the machine holds can reach live systems. They are a second line: the
# boundary is that role, and the read-only posture comes from granting one.
expect '.permission.bash["kubectl delete*"]' deny
expect '.permission.bash["kubectl apply*"]' deny
expect '.permission.bash["kubectl edit*"]' deny
expect '.permission.bash["kubectl patch*"]' deny
expect '.permission.bash["kubectl scale*"]' deny
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
# Every pattern above anchors at the first character, so it sees only a
# command whose binary comes first and whose verb comes second. An SRE types
# "kubectl -n prod delete pod x", and a command often carries an environment
# prefix; both resolved to allow. The shape below is immune to each: the
# leading "*" absorbs the prefix and the "*" after the binary absorbs the
# flags. A leading "*" is safe here because opencode asks about each command
# in the line separately, so it cannot reach across a "&&" into another one.
# The anchored patterns stay as well, since a redundant deny costs nothing.
#
# The verb carries the space that follows it, which is what keeps the reads
# open: "kubectl get volumeattachments", "kubectl get statefulset",
# "--show-labels", "--sort-by=cpu", a cluster-autoscaler and a runner pod all
# contain a verb as a substring and none of them is a mutation. A trailing
# " *" compiles to "( .*)?", so the bare verb is still denied.
expect '.permission.bash["*kubectl *delete *"]' deny
expect '.permission.bash["*kubectl *apply *"]' deny
expect '.permission.bash["*kubectl *edit *"]' deny
expect '.permission.bash["*kubectl *patch *"]' deny
expect '.permission.bash["*kubectl *exec *"]' deny
expect '.permission.bash["*kubectl *cordon *"]' deny
expect '.permission.bash["*kubectl *drain *"]' deny
expect '.permission.bash["*kubectl *create *"]' deny
expect '.permission.bash["*kubectl *replace *"]' deny
expect '.permission.bash["*kubectl *annotate *"]' deny
expect '.permission.bash["*kubectl *expose *"]' deny
expect '.permission.bash["*kubectl *taint *"]' deny
expect '.permission.bash["*kubectl *attach *"]' deny
expect '.permission.bash["*kubectl *debug *"]' deny
expect '.permission.bash["*kubectl *port-forward *"]' deny
expect '.permission.bash["*kubectl *scale *"]' deny
expect '.permission.bash["*kubectl *label *"]' deny
expect '.permission.bash["*kubectl *run *"]' deny
expect '.permission.bash["*kubectl *cp *"]' deny
expect '.permission.bash["*kubectl *certificate approve *"]' deny
# "kubectl proxy" needs no wildcard between the words, and must not have one:
# with one it denies "kubectl logs deploy/kube-proxy -n kube-system".
expect '.permission.bash["*kubectl proxy*"]' deny
# rollout by mutating subcommand, because "rollout status" and
# "rollout history" are reads and are how a deploy is watched.
expect '.permission.bash["*kubectl *rollout restart*"]' deny
expect '.permission.bash["*kubectl *rollout undo*"]' deny
expect '.permission.bash["*kubectl *rollout pause*"]' deny
expect '.permission.bash["*kubectl *rollout resume*"]' deny
# "kubectl set" by subcommand, because "*set*" denies every read of a
# statefulset, a replicaset or a daemonset. "set sa" is the documented alias
# of "set serviceaccount".
expect '.permission.bash["*kubectl *set image *"]' deny
expect '.permission.bash["*kubectl *set env *"]' deny
expect '.permission.bash["*kubectl *set resources *"]' deny
expect '.permission.bash["*kubectl *set selector *"]' deny
expect '.permission.bash["*kubectl *set serviceaccount *"]' deny
expect '.permission.bash["*kubectl *set sa *"]' deny
expect '.permission.bash["*kubectl *set subject *"]' deny
expect '.permission.bash["*helm *upgrade *"]' deny
expect '.permission.bash["*helm *install *"]' deny
expect '.permission.bash["*helm *uninstall *"]' deny
expect '.permission.bash["*helm *rollback *"]' deny
expect '.permission.bash["*terraform *apply *"]' deny
expect '.permission.bash["*terraform *destroy *"]' deny
expect '.permission.bash["*terraform *import *"]' deny
# terraform state by mutating subcommand: list, show and pull are reads.
expect '.permission.bash["*terraform *state rm*"]' deny
expect '.permission.bash["*terraform *state mv*"]' deny
expect '.permission.bash["*terraform *state push*"]' deny
expect '.permission.bash["*terraform *state replace-provider*"]' deny
for verb in create delete put update modify terminate start stop reboot attach detach \
            associate disassociate register deregister enable disable add remove reset \
            restore import copy cancel accept reject replace revoke authorize tag untag \
            publish upload invoke run send set; do
  expect ".permission.bash[\"*aws *${verb}-*\"]" deny
done
expect '.permission.bash["*aws *s3 cp*"]' deny
expect '.permission.bash["*aws *s3 mv*"]' deny
expect '.permission.bash["*aws *s3 rm*"]' deny
expect '.permission.bash["*aws *s3 sync*"]' deny
expect '.permission.bash["*aws *s3 mb*"]' deny
expect '.permission.bash["*aws *s3 rb*"]' deny
expect '.permission.bash["*aws *start-session*"]' deny
expect '.permission.bash["*aws *execute-command*"]' deny
# The mutating AWS calls the families structurally cannot see: the verb
# carries no hyphen, or its first word is not one of the family verbs.
expect '.permission.bash["*aws *configure set*"]' deny
expect '.permission.bash["*aws *lambda *invoke*"]' deny
expect '.permission.bash["*aws *sns *publish*"]' deny
expect '.permission.bash["*aws *cloudformation *deploy*"]' deny
expect '.permission.bash["*aws *execute-change-set*"]' deny
expect '.permission.bash["*aws *change-resource-record-sets*"]' deny
expect '.permission.bash["*aws *schedule-key-deletion*"]' deny
expect '.permission.bash["*aws *purge-queue*"]' deny
expect '.permission.bash["*aws *batch-write-item*"]' deny
expect '.permission.bash["*aws *failover-db-cluster*"]' deny
expect '.permission.bash["*aws *execute-policy*"]' deny
expect '.permission.bash["*aws *suspend-processes*"]' deny
expect '.permission.bash["*aws *release-address*"]' deny
expect '.permission.bash["*aws *request-spot-instances*"]' deny
# The reads the verbs above take with them, allowed back after the deny
# block. These cannot re-allow a mutation: get, describe, logs, top, explain
# and can-i are reads by definition, and a mutation chained after one of them
# is a second command, which opencode asks about separately.
expect '.permission.bash["kubectl get *"]' allow
expect '.permission.bash["kubectl describe *"]' allow
expect '.permission.bash["kubectl logs *"]' allow
expect '.permission.bash["kubectl top *"]' allow
expect '.permission.bash["kubectl explain *"]' allow
expect '.permission.bash["kubectl api-resources*"]' allow
expect '.permission.bash["kubectl auth can-i*"]' allow
expect '.permission.bash["kubectl version*"]' allow
expect '.permission.bash["kubectl cluster-info*"]' allow
expect '.permission.bash["terraform plan*"]' allow
expect '.permission.bash["terraform show*"]' allow
expect '.permission.bash["terraform output*"]' allow
expect '.permission.bash["terraform validate*"]' allow
expect '.permission.bash["terraform state list*"]' allow
expect '.permission.bash["terraform state show*"]' allow
expect '.permission.bash["terraform state pull*"]' allow
expect '.permission.bash["aws logs start-query*"]' allow
expect '.permission.bash["aws logs stop-query*"]' allow
expect '.permission.bash["aws cloudtrail start-query*"]' allow
expect '.permission.bash["aws cloudtrail cancel-query*"]' allow
# Every re-allow is anchored at its verb, and that is the rule this block
# lives by. The resource for a command carrying a substitution is that
# command's whole text, substitution included, so a re-allow with a wildcard
# before the verb is reachable from inside one: both
# "kubectl delete pod $(kubectl get pod -o name)" and
# "aws ec2 delete-security-group --group-id $(aws logs start-query ...)"
# would match the read re-allow, and findLast takes the allow over the deny.
# An anchored pattern cannot be reached that way. The cost is that the same
# read behind an inline credential prefix stays denied, which is a
# workstation habit rather than what a runner does: there the credentials
# come from the process environment or the task role, so the bare form is
# what gets typed.
if jq -e '.permission.bash | to_entries | map(select(.value == "allow" and .key != "*")) | map(select(.key | startswith("*"))) | length == 0' "$cfg" >/dev/null; then
  echo "ok   no re-allow starts with a wildcard"
else
  echo "FAIL a re-allow starts with a wildcard, which a command substitution can reach"; fail=1
fi
# Last match wins, so a deny placed before the catch-all would not fire, and
# a re-allow placed before a deny would be overruled by it.
if jq -e '.permission.bash | keys_unsorted | index("*") == 0' "$cfg" >/dev/null; then
  echo "ok   the bash catch-all comes before every deny"
else
  echo "FAIL the bash catch-all is not the first rule, so a later allow would win"; fail=1
fi
if jq -e '.permission.bash | [to_entries[].value] as $v
          | ($v | to_entries | map(select(.value == "deny")) | last | .key) as $lastdeny
          | ($v | to_entries | map(select(.value == "allow" and .key > 0)) | first | .key) as $firstallow
          | $firstallow > $lastdeny' "$cfg" >/dev/null; then
  echo "ok   every re-allow comes after every deny"
else
  echo "FAIL a re-allow sits before a deny, which overrules it"; fail=1
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
