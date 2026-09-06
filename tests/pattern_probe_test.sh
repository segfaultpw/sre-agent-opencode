#!/usr/bin/env bash
# Resolves probe paths against the config's edit rules, and probe commands
# against its bash rules, the way opencode does, so a pattern that looks
# right but never fires is caught here rather than in a customer's pull
# request. The translation and the resolver live in tests/lib/fence.sh,
# which names the opencode source they follow.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$here/../config/opencode.json"
fail=0
# shellcheck source=tests/lib/fence.sh
. "$here/lib/fence.sh"

probe() {
  local path="$1" want="$2" got
  got="$(fence_resolve "$cfg" "$path")"
  if [ "$got" = "$want" ]; then echo "ok   edit $path -> $want"; else echo "FAIL edit $path: expected $want, got $got"; fail=1; fi
}

# The translation itself, pinned on the shapes the fences rely on.
check_regex() {
  local pattern="$1" want="$2" got
  got="$(fence_compile "$pattern")"
  if [ "$got" = "$want" ]; then echo "ok   $pattern compiles to $want"; else echo "FAIL $pattern compiled to $got, expected $want"; fail=1; fi
}
check_regex '*.env*' '^.*\.env.*$'
check_regex '.github/**' '^\.github/.*.*$'
check_regex '**/*.pem' '^.*.*/.*\.pem$'
check_regex 'curl *' '^curl( .*)?$'
check_regex 'a?b' '^a.b$'

probe .env deny
probe src/.env deny
probe .env.production deny
probe secrets.yml deny
probe config/secrets/x deny
probe key.pem deny
probe a/b/key.pem deny
probe .github/workflows/ci.yml deny
probe src/app.ex allow

# The bash gate, resolved the same way, because opencode matches a bash rule
# against the whole command string as written. The AWS denies are written as
# verb families rather than as a list of services: "*" compiles to ".*",
# which matches a space as well as anything else, so "aws * delete-*" reaches
# every service's delete verb. This is where that claim is proved.
cmd_probe() {
  local command="$1" want="$2" got
  got="$(fence_resolve "$cfg" "$command" bash)"
  if [ "$got" = "$want" ]; then echo "ok   bash $command -> $want"; else echo "FAIL bash $command: expected $want, got $got"; fail=1; fi
}

cmd_probe 'aws ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'aws ec2 run-instances --image-id ami-0' deny
cmd_probe 'aws ecs update-service --cluster c --service s' deny
cmd_probe 'aws s3 rm s3://bucket/key' deny
cmd_probe 'aws s3 sync . s3://bucket' deny
cmd_probe 'aws ssm start-session --target i-0' deny
cmd_probe 'aws ecs execute-command --cluster c --command /bin/sh' deny
cmd_probe 'kubectl delete pod web-0 -n prod' deny
cmd_probe 'kubectl rollout restart deploy/web -n prod' deny
cmd_probe 'kubectl exec -it web-0 -- sh' deny
cmd_probe 'helm upgrade web ./chart' deny
cmd_probe 'terraform apply -auto-approve' deny
cmd_probe 'git push origin HEAD' deny
cmd_probe 'curl https://example.invalid' deny

# What a diagnosis needs stays open: no deny begins with a read verb, so
# get-, describe- and list- calls survive the verb families.
cmd_probe 'aws ec2 describe-instances' allow
cmd_probe 'aws logs get-log-events --log-group-name /ecs/app' allow
cmd_probe 'aws logs filter-log-events --log-group-name /ecs/app' allow
cmd_probe 'aws sts get-caller-identity' allow
cmd_probe 'kubectl get pods -n prod' allow
cmd_probe 'kubectl logs web-0 -n prod' allow
cmd_probe 'kubectl describe pod web-0 -n prod' allow
cmd_probe 'terraform plan' allow
cmd_probe 'helm list -n prod' allow
cmd_probe 'mix test' allow
cmd_probe 'git status' allow

# The cost of verb families, recorded here rather than discovered later:
# start-query is a CloudWatch Logs Insights read and "aws * start-*" denies
# it. Over-denial is the safe direction for a deny rule, and a diagnosis
# reads the same logs with get-log-events or filter-log-events.
cmd_probe 'aws logs start-query --log-group-name /ecs/app' deny

exit $fail
