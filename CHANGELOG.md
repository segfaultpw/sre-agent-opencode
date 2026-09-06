# Changelog

Versions follow semantic versioning. The major tag (`v1`) moves to every release of that major; a breaking change bumps the major, and its entry says what to change in your workflow.

## Unreleased

Initial package: the reusable workflow, the configuration, the sre-fix agent, the example.

The example workflow runs on OpenRouter's DeepSeek V4 Pro (`openrouter/deepseek/deepseek-v4-pro`): it supports tool calling, which the agent needs, at a fraction of a frontier model's price per token. Any provider in the mapping works by changing `model` and the secret.

In token mode (`use_github_token: true`) the workflow gives the runner the `github-actions[bot]` git identity and keeps the token in the checkout for the push, since the opencode action configures both only in App mode.

The opencode GitHub action is pinned at `anomalyco/opencode/github@v1.18.29`; a bump is recorded here. The pin covers the action only: it installs the current opencode release at run time and does not expose the install script's version option, so the binary is not pinned.
