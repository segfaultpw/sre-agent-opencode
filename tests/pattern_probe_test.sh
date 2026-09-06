#!/usr/bin/env bash
# Resolves probe paths against the config's edit rules, and probe command
# lines against its bash rules, the way opencode does, so a pattern that
# looks right but never fires is caught here rather than in a customer's
# pull request. The translation, the resolver and the sub-command model live
# in tests/lib/fence.sh, which names the binary code they follow.
#
# Every command below is written the way an operator types it. A probe case
# chosen because it passes proves nothing: the first version of this file
# probed a kube-proxy POD name, which passed, while the form an operator
# actually types, "kubectl logs deploy/kube-proxy", was denied.
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
check_regex '*kubectl *delete *' '^.*kubectl .*delete( .*)?$'

probe .env deny
probe src/.env deny
probe .env.production deny
probe secrets.yml deny
probe config/secrets/x deny
probe key.pem deny
probe a/b/key.pem deny
probe .github/workflows/ci.yml deny
probe src/app.ex allow
# The matcher replaces "\" with "/" in the resource as well as in the
# pattern, so a Windows-style path is judged by the same rules.
probe '.github\workflows\ci.yml' deny

# The bash gate. opencode parses the command line and asks about each command
# in it, denying the call when any one of them resolves to deny, so these
# probes go through the sub-command model rather than through one string.
cmd_probe() {
  local command="$1" want="$2" label="${3:-$1}" got
  got="$(fence_resolve_bash "$cfg" "$command")"
  if [ "$got" = "$want" ]; then echo "ok   bash $label -> $want"; else echo "FAIL bash $label: expected $want, got $got"; fail=1; fi
}

# Each family bare, with flags before the verb, and with an environment
# prefix. The second and third are how an operator types these, and an
# anchored pattern alone answered allow for both.
cmd_probe 'kubectl delete pod web-0 -n prod' deny
cmd_probe 'kubectl -n prod delete pod web-0' deny
cmd_probe 'KUBECONFIG=/tmp/kc kubectl delete pod web-0' deny
cmd_probe 'kubectl --context prod apply -f manifest.yaml' deny
cmd_probe 'KUBECONFIG=/tmp/kc kubectl apply -f manifest.yaml' deny
cmd_probe 'helm upgrade web ./chart' deny
cmd_probe 'helm -n prod upgrade web ./chart' deny
cmd_probe 'HELM_NAMESPACE=prod helm upgrade web ./chart' deny
cmd_probe 'terraform apply -auto-approve' deny
cmd_probe 'terraform -chdir=infra apply' deny
cmd_probe 'TF_WORKSPACE=prod terraform apply -auto-approve' deny
cmd_probe 'aws ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'aws --region us-east-1 ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'AWS_PROFILE=sreagent aws ec2 delete-security-group --group-id sg-0' deny
cmd_probe 'aws ssm start-session --target i-0' deny
cmd_probe 'aws --profile sreagent ssm start-session --target i-0' deny
cmd_probe 'AWS_PROFILE=sreagent aws ecs execute-command --cluster c --command /bin/sh' deny

# The rest of the mutating doors.
cmd_probe 'aws ec2 run-instances --image-id ami-0' deny
cmd_probe 'aws ecs update-service --cluster c --service s' deny
cmd_probe 'aws s3 rm s3://bucket/key' deny
cmd_probe 'aws s3 sync . s3://bucket' deny
cmd_probe 'aws s3 mb s3://new-bucket' deny
cmd_probe 'aws s3 rb s3://old-bucket' deny
cmd_probe 'aws configure set region us-east-1' deny
cmd_probe 'aws lambda invoke --function-name f out.json' deny
cmd_probe 'aws sns publish --topic-arn arn --message x' deny
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
cmd_probe 'kubectl -n prod set image deploy/web web=img:2' deny
cmd_probe 'kubectl -n prod set sa deploy/web builder' deny
cmd_probe 'kubectl create -f manifest.yaml' deny
cmd_probe 'kubectl -n prod replace -f manifest.yaml' deny
cmd_probe 'kubectl -n prod label pod web-0 team=core' deny
cmd_probe 'kubectl -n prod annotate pod web-0 note=x' deny
cmd_probe 'kubectl -n prod expose deploy/web --port 80' deny
cmd_probe 'kubectl -n prod run tmp --image=busybox' deny
cmd_probe 'kubectl -n prod debug pod/web-0 --image=busybox' deny
cmd_probe 'kubectl certificate approve csr-0' deny
cmd_probe 'kubectl taint nodes node-0 key=value:NoSchedule' deny
cmd_probe 'kubectl cp web-0:/var/log/app.log ./app.log' deny
cmd_probe 'kubectl -n prod attach web-0 -i' deny
cmd_probe 'kubectl -n prod port-forward svc/web 8080:80' deny
cmd_probe 'kubectl proxy --port=8001' deny
cmd_probe 'kubectl -n prod rollout restart deploy/web' deny
cmd_probe 'kubectl -n prod rollout undo deploy/web' deny
cmd_probe 'kubectl -n prod exec -it web-0 -- sh' deny
cmd_probe 'kubectl -n prod scale deploy/web --replicas=0' deny
cmd_probe 'kubectl drain node-0 --ignore-daemonsets' deny
cmd_probe 'helm -n prod rollback web 3' deny
cmd_probe 'terraform -chdir=infra state rm aws_instance.web' deny
cmd_probe 'terraform import aws_instance.web i-0' deny
cmd_probe 'git push origin HEAD' deny
cmd_probe 'curl https://example.invalid' deny

# The reads an operator runs while diagnosing. Every one of these was denied
# by some earlier shape of this list, which is why each is pinned.
cmd_probe 'kubectl get pods -n prod' allow
cmd_probe 'kubectl get statefulset web -n prod' allow
cmd_probe 'kubectl get replicaset -n prod' allow
cmd_probe 'kubectl get daemonsets -A' allow
cmd_probe 'kubectl get volumeattachments' allow
cmd_probe 'kubectl get clusterrole edit' allow
cmd_probe 'kubectl auth can-i create pods -n prod' allow
cmd_probe 'kubectl logs deploy/kube-proxy -n kube-system' allow
cmd_probe 'kubectl logs -n kube-system deploy/cluster-autoscaler' allow
cmd_probe 'kubectl logs gitlab-runner-0 -n ci' allow
cmd_probe 'kubectl describe statefulset sample -n prod' allow
cmd_probe 'kubectl get pods --show-labels -n prod' allow
cmd_probe 'kubectl top pods --sort-by=cpu -n prod' allow
cmd_probe 'kubectl rollout status deploy/web -n prod' allow
cmd_probe 'kubectl rollout history deploy/web -n prod' allow
cmd_probe 'kubectl explain pod.spec' allow
cmd_probe 'kubectl api-resources' allow
cmd_probe 'kubectl version --short' allow
cmd_probe 'kubectl cluster-info' allow
cmd_probe 'terraform plan' allow
cmd_probe 'terraform show -json' allow
cmd_probe 'terraform output -json' allow
cmd_probe 'terraform validate' allow
cmd_probe 'terraform state list' allow
cmd_probe 'terraform state show aws_instance.web' allow
cmd_probe 'helm list -n prod' allow
cmd_probe 'aws ec2 describe-instances' allow
cmd_probe 'aws --region us-east-1 logs get-log-events --log-group-name /ecs/app' allow
cmd_probe 'aws logs filter-log-events --log-group-name /ecs/app' allow
cmd_probe 'aws sts get-caller-identity' allow
cmd_probe 'aws s3api get-object --bucket b --key k out.json' allow
cmd_probe 'aws s3 ls s3://bucket/prefix' allow
cmd_probe 'mix test' allow
cmd_probe 'git status' allow

# The four reads allowed back after the deny block, in the three forms this
# organisation's own runbook produces. They carry the leading wildcard the
# denies carry, or the profile prefix every AWS command here is written with
# would leave them dead.
cmd_probe 'aws logs start-query --log-group-name /ecs/app --query-string fields' allow
cmd_probe 'aws --region us-east-1 logs start-query --log-group-name /ecs/app' allow
cmd_probe 'AWS_PROFILE=sreagent aws logs start-query --log-group-name /ecs/app' allow
cmd_probe 'aws logs stop-query --query-id q' allow
cmd_probe 'AWS_PROFILE=sreagent aws logs stop-query --query-id q' allow
cmd_probe 'aws cloudtrail start-query --query-statement select' allow
cmd_probe 'AWS_PROFILE=sreagent aws cloudtrail start-query --query-statement select' allow
cmd_probe 'aws cloudtrail cancel-query --query-id q' allow
cmd_probe 'AWS_PROFILE=sreagent aws cloudtrail cancel-query --query-id q' allow

# The kubectl and terraform read re-allows are anchored instead, so that a
# mutation carrying a read inside a command substitution cannot reach them:
# the binary judges the outer command by its whole text, substitution
# included. The cost is that the same read behind an inline environment
# prefix stays denied when a deny caught it, which is the second case here.
cmd_probe 'kubectl delete pod $(kubectl get pod -o name -n prod)' deny
cmd_probe 'KUBECONFIG=/tmp/kc kubectl get clusterrole edit' deny

# What the parse buys: a denied command chained after an allowed one is still
# denied, because each command in the line is asked about separately.
cmd_probe 'aws logs start-query --log-group-name /app && kubectl delete pod web-0' deny
cmd_probe 'kubectl get pods -n prod && kubectl delete pod web-0 -n prod' deny
cmd_probe $'echo hello\nsudo systemctl restart nginx' deny 'a two-line command whose second line is denied'
cmd_probe $'kubectl get pods\nkubectl delete pod web-0' deny 'a two-line command with a denied second line'
cmd_probe 'kubectl get pods -n prod | grep web' allow
cmd_probe 'kubectl get pods -o name | xargs kubectl delete pod' deny

# The over-denial the whole-command resource still buys: an allowed read
# whose arguments carry a mutating verb is one command node, and the pattern
# sees the arguments too. The README names this class rather than one case.
cmd_probe 'aws logs start-live-tail --log-group-identifiers arn' deny
cmd_probe 'aws logs filter-log-events --log-group-name /app --filter-pattern "failed to delete-object"' deny

exit $fail
