#!/usr/bin/env bash
# Appends the tracking issue's marker line, and the version stamp, to the
# comment the action left when the run declined, the way the post-step
# appends both to a pull request body. SRE Agent ends the remediation row the
# marker names; a decline without one falls back to the newest dispatched row,
# which is the wrong row when the request was superseded while the run was
# going. The comment edited is the newest one beginning "Declined:" that this
# run's clock covers, and an issue body carrying no marker leaves the comment
# exactly as the action wrote it: the stamp alone tells the platform nothing
# and the comment is on the customer's issue.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${SRE_AGENT_RUN_STARTED:?SRE_AGENT_RUN_STARTED is required}"
: "${SRE_AGENT_OPENCODE_VERSION:?SRE_AGENT_OPENCODE_VERSION is required}"
issue_body="${ISSUE_BODY:-}"

marker="$(grep -oE '<!-- sre-agent:remediation:[^>]*-->' <<<"$issue_body" | head -n 1 || true)"
if [ -z "$marker" ]; then
  echo "no marker line in the issue body; the decline comment is left as the action wrote it"
  exit 0
fi
stamp="<!-- sre-agent-opencode:${SRE_AGENT_OPENCODE_VERSION} -->"

# --paginate prints one array per page, so the pages are merged here with
# jq -s rather than through --jq, which runs per page and could not pick the
# newest comment across pages.
comments="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${ISSUE_NUMBER}/comments?per_page=100" --paginate)"
target="$(jq -s --arg since "$SRE_AGENT_RUN_STARTED" '
  (add // [])
  | map(select((.body // "") | startswith("Declined:")))
  | map(select(.created_at >= $since))
  | last // empty' <<<"$comments")"
if [ -z "$target" ]; then
  echo "no Declined: comment from this run on issue #${ISSUE_NUMBER}"
  exit 0
fi

id="$(jq -r '.id' <<<"$target")"
body="$(jq -r '.body' <<<"$target")"
tail=""
if [[ "$body" != *"$marker"* ]]; then
  tail="${tail}${marker}"$'\n'
fi
if [[ "$body" != *"$stamp"* ]]; then
  tail="${tail}${stamp}"$'\n'
fi
if [ -z "$tail" ]; then
  echo "decline comment ${id} already carries the marker and the stamp"
  exit 0
fi

jq -n --arg body "${body}"$'\n\n'"${tail}" '{body: $body}' \
  | gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" --input - >/dev/null
echo "marked decline comment ${id} for SRE Agent"
