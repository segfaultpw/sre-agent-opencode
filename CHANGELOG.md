# Changelog

Versions follow semantic versioning. The major tag (`v1`) moves to every release of that major; a breaking change bumps the major, and its entry says what to change in your workflow.

## Unreleased

A run that declines now marks its comment. When the action opened no pull request and left a comment beginning `Declined:` on the tracking issue, the workflow appends the issue's marker line and the version stamp to that comment, as it already does to a pull request body. SRE Agent ends the remediation the marker names; a decline without one fell back to the most recently dispatched request, which is the wrong one when a request was superseded while the run was going. An issue body carrying no marker leaves the comment as the action wrote it.

`scripts/install.sh` installs the caller workflow across an organization. Given an owner and either a list of repositories or `--all`, it skips a repository whose `.github/workflows/opencode.yml` is already byte-identical to the file it would write, commits it on the default branch otherwise, and opens a pull request instead when that branch is protected. It reports every prerequisite once with the command that closes it, and refuses before the first write when one is missing: the token's `workflow` scope, the opencode App installation or the Actions pull request policy, the provider secret, and the `SRE_AGENT_BOT_LOGIN` variable. `--dry-run` writes nothing.

## v1.0.1

A workflow pinned at a tag now installs the package. `job.workflow_sha` carries the annotated tag object's sha when the caller pins `@v1` or `@v1.0.0`, and the raw host serves commits only, so every fetch answered 404 and the run stopped at the install step. The workflow dereferences such a sha through the API before fetching, and the release workflow now points the major tag at the commit rather than at the release's tag object, so the common case needs no API call at all. Pins at a branch or a commit were never affected.

## v1.0.0

Initial package: the reusable workflow, the configuration, the sre-fix agent, the example.

The example workflow runs on OpenRouter's DeepSeek V4 Pro (`openrouter/deepseek/deepseek-v4-pro`): it supports tool calling, which the agent needs, at a fraction of a frontier model's price per token. Any provider in the mapping works by changing `model` and the secret.

In token mode (`use_github_token: true`) the workflow gives the runner the `github-actions[bot]` git identity and keeps the token in the checkout for the push, since the opencode action configures both only in App mode. Token mode also needs "Allow GitHub Actions to create and approve pull requests" enabled for the repository, and at the organization when the organization restricts it; the README's first install step carries the two API calls, and a failure-only step in the workflow names the setting when a run hits it.

The opencode GitHub action is pinned at `anomalyco/opencode/github@v1.18.29`; a bump is recorded here. The pin covers the action only: it installs the current opencode release at run time and does not expose the install script's version option, so the binary is not pinned.
