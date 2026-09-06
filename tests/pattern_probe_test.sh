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
  local command="$1" want="$2" label="${3:-$1}" got
  got="$(fence_resolve "$cfg" "$command" bash)"
  if [ "$got" = "$want" ]; then echo "ok   bash $label -> $want"; else echo "FAIL bash $label: expected $want, got $got"; fail=1; fi
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

# Each family in three forms, because an anchored pattern sees only the
# first: bare, flags before the verb, and an environment prefix. The second
# and third are how an operator actually types these, and an anchored
# pattern alone answered allow for both.
cmd_probe 'kubectl -n prod delete pod web-0' deny
cmd_probe 'KUBECONFIG=/tmp/kc kubectl delete pod web-0' deny
cmd_probe 'kubectl --context prod apply -f manifest.yaml' deny
cmd_probe 'KUBECONFIG=/tmp/kc kubectl apply -f manifest.yaml' deny
cmd_probe 'helm -n prod upgrade web ./chart' deny
cmd_probe 'HELM_NAMESPACE=prod helm upgrade web ./chart' deny
cmd_probe 'terraform -chdir=infra apply' deny
cmd_probe 'TF_WORKSPACE=prod terraform apply -auto-approve' deny
cmd_probe 'aws --region us-east-1 ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'AWS_PROFILE=prod aws ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'aws --profile prod ssm start-session --target i-0' deny
cmd_probe 'AWS_PROFILE=prod aws ecs execute-command --cluster c --command /bin/sh' deny

# The doors the first round missed.
cmd_probe 'kubectl -n prod set image deploy/web web=img:2' deny
cmd_probe 'kubectl create -f manifest.yaml' deny
cmd_probe 'kubectl -n prod replace -f manifest.yaml' deny
cmd_probe 'kubectl -n prod label pod web-0 team=core' deny
cmd_probe 'kubectl -n prod annotate pod web-0 note=x' deny
cmd_probe 'kubectl -n prod expose deploy/web --port 80' deny
cmd_probe 'kubectl -n prod run tmp --image=busybox' deny
cmd_probe 'kubectl taint nodes node-0 key=value:NoSchedule' deny
cmd_probe 'kubectl cp web-0:/var/log/app.log ./app.log' deny
cmd_probe 'kubectl -n prod attach web-0 -i' deny
cmd_probe 'kubectl -n prod port-forward svc/web 8080:80' deny
cmd_probe 'kubectl proxy' deny
cmd_probe 'kubectl proxy --port=8001' deny
cmd_probe 'helm -n prod rollback web 3' deny
cmd_probe 'terraform import aws_instance.web i-0' deny
cmd_probe 'terraform state rm aws_instance.web' deny
cmd_probe 'aws configure set region us-east-1' deny
cmd_probe 'aws lambda invoke --function-name f out.json' deny
cmd_probe 'aws sns publish --topic-arn arn --message x' deny
cmd_probe 'aws s3 mb s3://new-bucket' deny
cmd_probe 'aws s3 rb s3://old-bucket' deny
cmd_probe 'aws cloudformation deploy --template-file x.yml --stack-name s' deny
cmd_probe 'aws cloudformation execute-change-set --change-set-name c' deny
cmd_probe 'aws route53 change-resource-record-sets --hosted-zone-id z' deny
cmd_probe 'aws kms schedule-key-deletion --key-id k' deny
cmd_probe 'aws sqs purge-queue --queue-url u' deny
cmd_probe 'aws dynamodb batch-write-item --request-items x' deny
cmd_probe 'aws rds failover-db-cluster --db-cluster-identifier c' deny
cmd_probe 'aws autoscaling execute-policy --policy-name p' deny
cmd_probe 'aws autoscaling suspend-processes --auto-scaling-group-name g' deny
cmd_probe 'aws ec2 release-address --allocation-id a' deny
cmd_probe 'aws ec2 request-spot-instances --spot-price 0.01' deny

# The reads that a substring would have taken with it. Each of these is a
# command an operator runs while diagnosing, and each is why the verb above
# carries the space after it, or is written by subcommand.
cmd_probe 'kubectl get statefulset web -n prod' allow
cmd_probe 'kubectl get replicaset -n prod' allow
cmd_probe 'kubectl get daemonsets -A' allow
cmd_probe 'kubectl logs -n kube-system cluster-autoscaler-abc' allow
cmd_probe 'kubectl logs -n kube-system kube-proxy-abc' allow
cmd_probe 'kubectl get pods --show-labels -n prod' allow
cmd_probe 'kubectl top pods --sort-by=cpu -n prod' allow
cmd_probe 'kubectl logs gitlab-runner-0 -n ci' allow
cmd_probe 'aws --region us-east-1 logs get-log-events --log-group-name /ecs/app' allow
cmd_probe 'aws s3api get-object --bucket b --key k out.json' allow
cmd_probe 'aws s3 ls s3://bucket/prefix' allow

# The four reads allowed back after the deny block, because the denied verb
# is the only read path for that data.
cmd_probe 'aws logs start-query --log-group-name /ecs/app --query-string fields' allow
cmd_probe 'aws logs stop-query --query-id q' allow
cmd_probe 'aws cloudtrail start-query --query-statement select' allow
cmd_probe 'aws cloudtrail cancel-query --query-id q' allow
# Those four are anchored while the denies are not, and that asymmetry is
# deliberate: a deny may over-reach, an allow may not. The cost is here, in
# the open: with a flag before the service the re-allow does not fire and
# the family's deny stands.
cmd_probe 'aws --region us-east-1 logs start-query --log-group-name /ecs/app' deny
# A re-allow is the last rule, so a command that begins with one and chains a
# denied command after it resolves to allow. That is the same class as
# "sh -c" and a written script: the list is not a boundary, and the README
# says so rather than leaving it to be discovered.
cmd_probe 'aws logs start-query --log-group-name /app && kubectl delete pod web-0' allow

# The class of read the families catch, which the README names rather than
# pretending it is one command: a read whose own verb is a mutating word,
# and a read whose arguments carry one.
cmd_probe 'aws logs start-live-tail --log-group-identifiers arn' deny
cmd_probe 'aws logs filter-log-events --log-group-name /app --filter-pattern "failed to delete-object"' deny

# opencode anchors the whole command string and compiles with the s flag, so
# a rule that cannot match from the first character does not match a later
# line, and a leading ".*" crosses a newline. A line-oriented probe answered
# deny for the first of these, which the real binary allows.
cmd_probe $'echo hello\nsudo systemctl restart nginx' allow 'a two-line command whose second line alone would be denied'
cmd_probe $'kubectl get pods\nkubectl delete pod web-0' deny 'a two-line command reached by the leading wildcard'

exit $fail
