#!/usr/bin/env bash
# Prints, one JSON object per line, every open pull request the current run
# opened. The opencode action names the branch after the event that started
# the run: opencode/issue<N>-<timestamp> for a comment, and
# opencode/dispatch-<hex>-<timestamp> for the workflow_dispatch the relay
# fires, whose payload carries no issue at all. So the prefix follows
# GITHUB_EVENT_NAME the way the action's own choice of prefix does, and the
# candidates are the refs with that prefix, kept when the pull request was
# created after the run started. The author is logged and never filtered on:
# gh reports a bot as app/<slug>, and a token the customer supplies has an
# identity of its own, so an allowlist here would silently skip a pull request.
#
# A dispatch branch carries no issue number, so two runs of one repository
# overlapping in time each see the other's branches. --mine keeps only the
# pull request whose body links THIS run, which the action writes itself as
# the footer of every body it opens. The marking step passes it, because
# marking another run's pull request would put this run's card key and marker
# line on it and the platform would adopt the wrong one. The diff gate passes
# nothing: there the safe direction is to inspect one pull request too many
# rather than one too few, and the gate only ever closes one that touched a
# protected path.
set -euo pipefail

mine=no
case "${1:-}" in
  --mine) mine=yes ;;
  "") : ;;
  *)
    echo "usage: run_prs.sh [--mine]" >&2
    exit 2
    ;;
esac

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${SRE_AGENT_RUN_STARTED:?SRE_AGENT_RUN_STARTED is required}"

prefix="opencode/issue${ISSUE_NUMBER}-"
tell=""
if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  prefix="opencode/dispatch-"
  if [ "$mine" = yes ]; then
    : "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required to tell this run apart from another one}"
    tell="/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  fi
fi

gh api "repos/${GITHUB_REPOSITORY}/git/matching-refs/heads/${prefix}" --paginate --jq '.[].ref' \
  | while IFS= read -r ref; do
      branch="${ref#refs/heads/}"
      [[ "$branch" == "$prefix"* ]] || continue
      gh pr list --repo "$GITHUB_REPOSITORY" --state open --head "$branch" \
        --json number,title,body,isDraft,createdAt,author,headRefName \
        | jq -c --arg since "$SRE_AGENT_RUN_STARTED" '.[] | select(.createdAt >= $since)'
    done \
  | while IFS= read -r pr; do
      number="$(jq -r '.number' <<<"$pr")"
      branch="$(jq -r '.headRefName' <<<"$pr")"
      if [ -n "$tell" ] && [[ "$(jq -r '.body // ""' <<<"$pr")" != *"$tell"* ]]; then
        echo "pull request #${number} on ${branch} links another run and is left to it" >&2
        continue
      fi
      echo "pull request #${number} on ${branch} by $(jq -r '.author.login' <<<"$pr")" >&2
      printf '%s\n' "$pr"
    done
