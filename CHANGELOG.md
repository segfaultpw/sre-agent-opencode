# Changelog

Versions follow semantic versioning. The major tag (`v1`) moves to every release of that major; a breaking change bumps the major, and its entry says what to change in your workflow.

## Unreleased

Initial package: the reusable workflow, the configuration, the sre-fix agent, the example.

The opencode GitHub action is pinned at `anomalyco/opencode/github@v1.18.29`; a bump is recorded here. The pin covers the action only: it installs the current opencode release at run time and does not expose the install script's version option, so the binary is not pinned.
