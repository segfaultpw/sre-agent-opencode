# Changelog

Versions follow semantic versioning. The major tag (`v1`) moves to every release of that major; a breaking change bumps the major, and its entry says what to change in your workflow.

## Unreleased

One agent prompt now serves both doors. It no longer says it is running inside a repository's own CI, because a runner started on a machine you own runs the same agent under the same fences, and two copies of the prompt would drift. It also gains a step for a request that resolved no repository: investigate with the read-only commands available, answer with a diagnosis, the evidence for it and the repository the change probably belongs in, and change nothing.

The prompt's untargeted step says what it keeps of the pull request contract: the version stamp, so the answer says which version produced it, and not the marker line, which has no card to tie an answer to when there is no pull request.

The bash gate refuses the mutating cloud and cluster commands as well: the `kubectl` write verbs (`delete`, `apply`, `create`, `replace`, `edit`, `patch`, `scale`, `exec`, `cordon`, `drain`, `label`, `annotate`, `expose`, `run`, `debug`, `taint`, `cp`, `attach`, `port-forward`, `proxy`, `certificate approve`, `rollout restart`, `undo`, `pause`, `resume`, and `set` by subcommand); `helm upgrade`, `install`, `uninstall` and `rollback`; `terraform apply`, `destroy`, `import`, and `state rm`, `mv`, `push` and `replace-provider`; the AWS CLI's 37 mutating verb families, written as `*aws *<verb>-*` so a service the CLI adds later is covered without a new rule; the writing `aws s3` verbs; `aws configure set`, `aws ssm start-session` and `aws ecs execute-command`; and the mutating calls whose verb carries no hyphen, such as `lambda invoke`, `sns publish` and `cloudformation deploy`. Every pattern tolerates flags before the verb and an environment prefix in front of the command, which is how these are typed in practice; an anchored pattern alone allowed `kubectl -n prod delete pod x`.

opencode parses a command line and asks about each command in it, denying the call when any one of them is denied, so a refused command is not admitted by being chained after an allowed one. What a pattern sees is that command as written, arguments included, which is why the reads needed care: a verb written as a bare substring took `kubectl get volumeattachments`, `kubectl logs deploy/kube-proxy` and `terraform state list` with it. The mutating subcommand is named wherever a family also holds reads, and the read verbs are allowed again after the deny block: `kubectl get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `auth can-i`, `version` and `cluster-info`; `terraform plan`, `show`, `output`, `validate`, `state list`, `state show` and `state pull`; and four AWS reads whose data has no other read path, `aws logs start-query` and `stop-query` and `aws cloudtrail start-query` and `cancel-query`, since a Logs Insights query is the only aggregating read of a log group and a Lake query the only read of an event data store. Every re-allow is anchored at its verb, because a command carrying a substitution is judged by its whole text and a re-allow with a wildcard in front of the verb can be reached from inside one; the cost is that the same read behind an inline credential prefix stays denied, and on a runner the credentials come from the process environment or the machine's role rather than from a prefix. A read whose own verb is a mutating word, such as `aws logs start-live-tail`, and a read whose arguments carry one are still refused. Over-denial is the safe direction for a deny rule.

The list is a speed bump and not a boundary: an interpreter such as `sh -c` or `python -c`, or a script the agent writes and then runs, is a single command whose contents no pattern here describes. It stops a careless step. What holds is the role granted to the machine the agent runs on.

## v1.1.0

A run that declines now marks its comment. When the action opened no pull request and left a comment beginning `Declined:` on the tracking issue, the workflow appends the issue's marker line and the version stamp to that comment, as it already does to a pull request body. SRE Agent ends the remediation the marker names; a decline without one fell back to the most recently dispatched request, which is the wrong one when a request was superseded while the run was going. An issue body carrying no marker leaves the comment as the action wrote it.

`scripts/install.sh` installs the caller workflow across an organization. Given an owner and either a list of repositories or `--all`, it skips a repository whose `.github/workflows/opencode.yml` is already byte-identical to the file it would write, commits it on the default branch otherwise, and opens a pull request instead when that branch is protected. It reports every prerequisite once with the command that closes it, and refuses before the first write when one is missing: the token's `workflow` scope, the opencode App installation or the Actions pull request policy, the provider secret, and the `SRE_AGENT_BOT_LOGIN` variable. `--dry-run` writes nothing.

## v1.0.1

A workflow pinned at a tag now installs the package. `job.workflow_sha` carries the annotated tag object's sha when the caller pins `@v1` or `@v1.0.0`, and the raw host serves commits only, so every fetch answered 404 and the run stopped at the install step. The workflow dereferences such a sha through the API before fetching, and the release workflow now points the major tag at the commit rather than at the release's tag object, so the common case needs no API call at all. Pins at a branch or a commit were never affected.

## v1.0.0

Initial package: the reusable workflow, the configuration, the sre-fix agent, the example.

The example workflow runs on OpenRouter's DeepSeek V4 Pro (`openrouter/deepseek/deepseek-v4-pro`): it supports tool calling, which the agent needs, at a fraction of a frontier model's price per token. Any provider in the mapping works by changing `model` and the secret.

In token mode (`use_github_token: true`) the workflow gives the runner the `github-actions[bot]` git identity and keeps the token in the checkout for the push, since the opencode action configures both only in App mode. Token mode also needs "Allow GitHub Actions to create and approve pull requests" enabled for the repository, and at the organization when the organization restricts it; the README's first install step carries the two API calls, and a failure-only step in the workflow names the setting when a run hits it.

The opencode GitHub action is pinned at `anomalyco/opencode/github@v1.18.29`; a bump is recorded here. The pin covers the action only: it installs the current opencode release at run time and does not expose the install script's version option, so the binary is not pinned.
