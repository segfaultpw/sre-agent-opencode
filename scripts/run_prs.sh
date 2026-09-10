#!/usr/bin/env bash
# Prints, one JSON object per line, every open pull request the current run
# could have opened, each with a "mine" field saying whether it is this run's
# own. The opencode action names the branch after the event that started the
# run: opencode/issue<N>-<timestamp> for a comment, and
# opencode/dispatch-<hex>-<timestamp> for the workflow_dispatch the relay
# fires, whose payload carries no issue at all. So the prefix follows
# GITHUB_EVENT_NAME the way the action's own choice of prefix does, and the
# candidates are the refs with that prefix, kept when the pull request was
# created after the run started. The author is logged and never filtered on:
# gh reports a bot as app/<slug>, and a token the customer supplies has an
# identity of its own, so an allowlist here would silently skip a pull request.
#
# A dispatch branch carries no issue number, so two runs of one repository
# overlapping in time each see the other's branches, and "mine" is what tells
# them apart: the action ends every body it opens with a link to its own run,
# and this run's link is what it looks for. A comment-started run needs no
# such test: its branch carries the issue number, and the caller's concurrency
# group allows one run per issue, so every candidate there is this run's.
#
# What the caller does with a pull request that is not this run's differs by
# caller, which is why the field is reported rather than filtered here. The
# marking step must skip it: marking it would put this run's card key and
# marker line on another run's work and the platform would adopt the wrong
# one. The diff gate must still inspect it, because a pull request that
# touched a protected path has to be closed whichever run opened it; only the
# VERDICT belongs to the run that opened it.
set -euo pipefail

if [ "$#" -gt 0 ]; then
  echo "usage: run_prs.sh" >&2
  exit 2
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${SRE_AGENT_RUN_STARTED:?SRE_AGENT_RUN_STARTED is required}"

prefix="opencode/issue${ISSUE_NUMBER}-"
tell=""
if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  prefix="opencode/dispatch-"
  : "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required to tell this run apart from another one}"
  # The footer link's closing parenthesis is part of the test, so that run 555
  # is not read out of a link to run 5551. An agent talked into writing another
  # run's link into the answer it proposes would be claimed by that run as
  # well as by this one, and the cost of that is a pull request two runs mark;
  # it would also have to guess a run id it is never told, since the
  # environment holds its own.
  tell="/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})"
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
      mine=true
      if [ -n "$tell" ] && [[ "$(jq -r '.body // ""' <<<"$pr")" != *"$tell"* ]]; then
        mine=false
      fi
      if [ "$mine" = true ]; then
        echo "pull request #${number} on ${branch} by $(jq -r '.author.login' <<<"$pr")" >&2
      else
        echo "pull request #${number} on ${branch} links another run of this repository" >&2
      fi
      jq -c --argjson mine "$mine" '. + {mine: $mine}' <<<"$pr"
    done
