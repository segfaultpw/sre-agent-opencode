#!/usr/bin/env bash
# Prints, one JSON object per line, every open pull request the current run
# opened. The opencode action names its branch opencode/issue<N>-<timestamp>,
# so the candidates are the refs with that prefix, kept when the pull request
# was created after the run started. The author is logged and never filtered
# on: gh reports a bot as app/<slug>, and a token the customer supplies has an
# identity of its own, so an allowlist here would silently skip a pull request.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${SRE_AGENT_RUN_STARTED:?SRE_AGENT_RUN_STARTED is required}"

prefix="opencode/issue${ISSUE_NUMBER}-"

gh api "repos/${GITHUB_REPOSITORY}/git/matching-refs/heads/${prefix}" --paginate --jq '.[].ref' \
  | while IFS= read -r ref; do
      branch="${ref#refs/heads/}"
      [[ "$branch" == "$prefix"* ]] || continue
      gh pr list --repo "$GITHUB_REPOSITORY" --state open --head "$branch" \
        --json number,title,body,isDraft,createdAt,author,headRefName \
        | jq -c --arg since "$SRE_AGENT_RUN_STARTED" '.[] | select(.createdAt >= $since)'
    done \
  | while IFS= read -r pr; do
      echo "pull request #$(jq -r '.number' <<<"$pr") on $(jq -r '.headRefName' <<<"$pr") by $(jq -r '.author.login' <<<"$pr")" >&2
      printf '%s\n' "$pr"
    done
