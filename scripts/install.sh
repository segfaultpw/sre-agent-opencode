#!/usr/bin/env bash
# Installs the caller workflow in many repositories at once, from a clone of
# this package, as the owner of the repositories.
#
# The file written is examples/opencode.yml byte for byte, so a repository
# that already has it is skipped rather than committed to, and a repository
# whose default branch is protected gets a pull request instead of a commit.
# Everything the run needs on the GitHub side is checked and reported before
# the first write, each gap with the command that closes it, because a
# half-installed fleet is worse than one that refused: a workflow whose secret
# or variable is missing fails on the customer's first fix request instead of
# here.
set -euo pipefail

APP_SLUG=opencode-agent
APP_URL=https://github.com/apps/opencode-agent
WORKFLOW_PATH=.github/workflows/opencode.yml
BOT_LOGIN_VARIABLE=SRE_AGENT_BOT_LOGIN
COMMIT_MESSAGE="ci: run SRE Agent fix requests with opencode"
PR_BRANCH=sre-agent/opencode-runner
PR_BODY="Runs SRE Agent fix requests on this repository's own runner through segfaultpw/sre-agent-opencode. A fix request arrives as a /opencode comment on a tracking issue and ends in a draft pull request. SRE Agent comments as a GitHub App, and the opencode action refuses a run whose commenting user holds no collaborator permission, so the workflow relays that comment to itself as a workflow_dispatch and the run starts from there; a member of this repository who comments /opencode starts a run directly. The default branch is protected, so this arrives as a pull request rather than a commit."

here="$(cd "$(dirname "$0")" && pwd)"
workflow="$here/../examples/opencode.yml"
owner=""
all=no
dry_run=no
repos=()

usage() {
  cat <<'USAGE'
usage: install.sh --owner <owner> [--all | <repo> ...] [--workflow <file>] [--dry-run]

  --owner <owner>     the organization or user the repositories belong to
  --all               every repository the opencode App reaches, or, in token
                      mode, every repository of the owner; archived ones are
                      left out
  --workflow <file>   the workflow to install, examples/opencode.yml by default
  --dry-run           report what would happen and write nothing
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2:-}"; shift 2 ;;
    --all) all=yes; shift ;;
    --workflow) workflow="${2:-}"; shift 2 ;;
    --dry-run) dry_run=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "unknown option ${1}" >&2; usage >&2; exit 2 ;;
    *) repos+=("$1"); shift ;;
  esac
done

if [ -z "$owner" ]; then echo "--owner is required" >&2; usage >&2; exit 2; fi
if [ ! -f "$workflow" ]; then echo "no workflow file at ${workflow}" >&2; exit 2; fi
workflow="$(cd "$(dirname "$workflow")" && pwd)/$(basename "$workflow")"
named=${#repos[@]}
if [ "$all" = yes ] && [ "$named" -gt 0 ]; then
  echo "--all takes the repository list from GitHub; do not name repositories as well" >&2
  exit 2
fi
if [ "$all" = no ] && [ "$named" -eq 0 ]; then
  echo "name at least one repository, or pass --all" >&2
  usage >&2
  exit 2
fi

# What the file itself says it needs: the model decides which provider the
# reusable workflow maps the secret to, the provider_key line names the secret
# the caller repository must hold, and use_github_token decides whether the
# opencode App or the Actions pull request policy is the prerequisite. Reading
# them from the file means a customized copy is checked for what it actually
# uses, not for what the example used.
model="$(sed -n 's/^[[:space:]]*model:[[:space:]]*//p' "$workflow" | head -n 1 | sed 's/[[:space:]]*$//; s/^"//; s/"$//')"
secret="$(sed -n 's/.*provider_key:[^{]*{{[[:space:]]*secrets\.\([A-Za-z0-9_]*\).*/\1/p' "$workflow" | head -n 1)"
token_mode=no
if grep -Eq '^[[:space:]]*use_github_token:[[:space:]]*true' "$workflow"; then token_mode=yes; fi
if [ -z "$model" ]; then echo "${workflow} names no model" >&2; exit 2; fi
if [ -z "$secret" ]; then echo "${workflow} passes no provider_key secret" >&2; exit 2; fi
if ! provider_var="$(bash "$here/provider_env.sh" "$model")"; then exit 2; fi
content_b64="$(base64 < "$workflow" | tr -d '\n')"

ok_lines=()
missing_lines=()
pass() { ok_lines+=("$1"); }
lack() { missing_lines+=("$1"$'\n'"           fix: $2"); }

# gh prints an API failure on stderr and exits non-zero, and an absent secret,
# variable, file or branch is a 404, so a failed read here means "not there"
# rather than "stop".
absent_or() {
  gh api "$@" 2>/dev/null || true
}

mode_label="App mode"
if [ "$token_mode" = yes ]; then mode_label="token mode"; fi

# The token itself comes first: GitHub refuses to create or update a file
# under .github/workflows/ for an OAuth token without the workflow scope, and
# it refuses at the write, one repository at a time.
scopes="$(gh api -i /user 2>/dev/null | tr -d '\r' | sed -n 's/^[Xx]-[Oo]auth-[Ss]copes:[[:space:]]*//p' | head -n 1 || true)"
if [ -z "$scopes" ]; then
  pass "the token's scopes are not listed, so it is not an OAuth token; a fine-grained token needs Workflows: write"
elif [[ ",$(printf '%s' "$scopes" | tr -d ' ')," == *",workflow,"* ]]; then
  pass "the token may write workflow files"
else
  lack "the token has no workflow scope, so GitHub refuses every write under .github/workflows/" \
    "gh auth refresh -h github.com -s workflow"
fi

# The App installation, read once for the owner. /user/installations would
# answer this too, but only for a GitHub App user token, and gh's own OAuth
# token is refused there, so the organization endpoint is the one an owner can
# actually use.
app_selection=""
app_installation=""
app_refused=no
owner_is_org=unknown
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
installations=""
if ! installations="$(gh api "orgs/${owner}/installations" --paginate 2>"$errors")"; then
  installations=""
  # A token without admin:org is refused rather than answered "none", and the
  # two must not be reported as the same thing.
  if grep -qiE '40[13]|forbidden' "$errors"; then app_refused=yes; fi
fi
if [ -n "$installations" ]; then
  owner_is_org=yes
  app="$(jq -s --arg slug "$APP_SLUG" '[.[].installations[]] | map(select(.app_slug == $slug)) | first // empty' <<<"$installations")"
  if [ -n "$app" ]; then
    app_selection="$(jq -r '.repository_selection' <<<"$app")"
    app_installation="$(jq -r '.id' <<<"$app")"
  fi
elif [ -n "$(absent_or "orgs/${owner}")" ]; then
  owner_is_org=yes
else
  owner_is_org=no
fi

# The repositories the installation covers, when the owner chose some rather
# than all. The endpoint needs a GitHub App user token, so it can be refused;
# that is reported rather than assumed either way.
selected_repos=""
selected_readable=unknown
if [ "$app_selection" = selected ]; then
  selected_repos="$(absent_or "/user/installations/${app_installation}/repositories" --paginate)"
  if [ -n "$selected_repos" ]; then
    selected_readable=yes
    selected_repos="$(jq -sr '[.[].repositories[].name] | .[]' <<<"$selected_repos")"
  else
    selected_readable=no
  fi
fi

if [ "$token_mode" = no ]; then
  if [ -n "$app_selection" ]; then
    pass "the opencode App is installed on ${owner} for ${app_selection} repositories"
  elif [ "$app_refused" = yes ]; then
    lack "the App installations of ${owner} cannot be read with this token, so the opencode App is unproven" \
      "gh auth refresh -h github.com -s admin:org"
  elif [ "$owner_is_org" = yes ]; then
    lack "the opencode App is not installed on ${owner}, and App mode needs it" \
      "install it at ${APP_URL}/installations/new, or set use_github_token: true in ${workflow}"
  else
    pass "${owner} is not an organization, so the App installation cannot be read here; confirm it at ${APP_URL}"
  fi
fi

if [ "$all" = yes ]; then
  if [ "$app_selection" = selected ] && [ "$selected_readable" = yes ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      repos+=("$name")
    done <<<"$selected_repos"
  else
    listed="$(gh repo list "$owner" --limit 1000 --json name,isArchived)"
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      repos+=("$name")
    done < <(jq -r '.[] | select(.isArchived | not) | .name' <<<"$listed")
  fi
  if [ "${#repos[@]}" -eq 0 ]; then echo "no repositories found for ${owner}" >&2; exit 1; fi
fi

# The organization can hold the secret, the variable and the policy for every
# repository at once, so each is read once and only the repositories it does
# not cover are checked one by one.
org_secret=no
org_variable=no
org_policy=unknown
if [ "$owner_is_org" = yes ]; then
  if [ -n "$(absent_or "orgs/${owner}/actions/secrets/${secret}")" ]; then org_secret=yes; fi
  if [ -n "$(absent_or "orgs/${owner}/actions/variables/${BOT_LOGIN_VARIABLE}")" ]; then org_variable=yes; fi
  if [ "$token_mode" = yes ]; then
    policy="$(absent_or "orgs/${owner}/actions/permissions/workflow")"
    if [ -n "$policy" ]; then org_policy="$(jq -r '.can_approve_pull_request_reviews' <<<"$policy")"; fi
  fi
fi
if [ "$org_secret" = yes ]; then pass "the provider secret ${secret} is an organization secret of ${owner}"; fi
if [ "$org_variable" = yes ]; then pass "${BOT_LOGIN_VARIABLE} is an organization variable of ${owner}"; fi
if [ "$token_mode" = yes ] && [ "$org_policy" = false ]; then
  lack "${owner} does not allow GitHub Actions to create pull requests, which token mode needs" \
    "gh api -X PUT orgs/${owner}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true"
fi

# Everything read per repository, before anything is written, so the report is
# complete and the run can still refuse.
slugs=()
branches=()
actions=()
reasons=()
file_shas=()

for repo in "${repos[@]}"; do
  slug="${owner}/${repo}"
  info="$(absent_or "repos/${slug}")"
  if [ -z "$info" ]; then
    lack "${slug} cannot be read with this token" "gh repo view ${slug}"
    continue
  fi
  branch="$(jq -r '.default_branch' <<<"$info")"
  repo_id="$(jq -r '.id' <<<"$info")"

  if [ "$token_mode" = no ]; then
    case "$app_selection" in
      all | "") : ;;
      selected)
        if [ "$selected_readable" = yes ]; then
          if ! grep -qxF "$repo" <<<"$selected_repos"; then
            lack "the opencode App installation on ${owner} does not include ${slug}" \
              "gh api -X PUT /user/installations/${app_installation}/repositories/${repo_id}"
          fi
        else
          lack "the opencode App installation on ${owner} covers selected repositories and this token cannot read the selection, so ${slug} is unproven" \
            "gh api -X PUT /user/installations/${app_installation}/repositories/${repo_id}"
        fi
        ;;
    esac
  fi

  if [ "$org_secret" = no ] && [ -z "$(absent_or "repos/${slug}/actions/secrets/${secret}")" ]; then
    lack "${slug} has no ${secret} secret, and ${owner} has no organization secret of that name" \
      "gh secret set ${secret} --repo ${slug}"
  fi
  if [ "$org_variable" = no ] && [ -z "$(absent_or "repos/${slug}/actions/variables/${BOT_LOGIN_VARIABLE}")" ]; then
    lack "${slug} has no ${BOT_LOGIN_VARIABLE} variable, and ${owner} has no organization variable of that name" \
      "gh variable set ${BOT_LOGIN_VARIABLE} --repo ${slug} --body 'sreagent-app[bot]'"
  fi
  if [ "$token_mode" = yes ]; then
    policy="$(absent_or "repos/${slug}/actions/permissions/workflow")"
    if [ -z "$policy" ] || [ "$(jq -r '.can_approve_pull_request_reviews' <<<"$policy")" != true ]; then
      lack "${slug} does not allow GitHub Actions to create pull requests, which token mode needs" \
        "gh api -X PUT repos/${slug}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true"
    fi
  fi

  action=commit
  reason="$branch"
  file_sha=""
  existing="$(absent_or "repos/${slug}/contents/${WORKFLOW_PATH}?ref=${branch}")"
  if [ -n "$existing" ]; then
    file_sha="$(jq -r '.sha // empty' <<<"$existing")"
    if [ "$(jq -r '.content // ""' <<<"$existing" | tr -d '\n')" = "$content_b64" ]; then
      action=skip
      reason="already installed"
    fi
  fi
  if [ "$action" = commit ]; then
    branch_info="$(absent_or "repos/${slug}/branches/${branch}")"
    if [ -n "$branch_info" ] && [ "$(jq -r '.protected' <<<"$branch_info")" = true ]; then
      action=pull_request
      reason="${branch} is protected"
    fi
  fi

  slugs+=("$slug")
  branches+=("$branch")
  actions+=("$action")
  reasons+=("$reason")
  file_shas+=("$file_sha")
done

counted="${#repos[@]} repositories"
if [ "${#repos[@]}" -eq 1 ]; then counted="1 repository"; fi
echo "Prerequisites for ${counted} of ${owner} (${mode_label}, model ${model}, provider key ${secret} as ${provider_var})"
for line in ${ok_lines[@]+"${ok_lines[@]}"}; do printf '  %-8s %s\n' ok "$line"; done
for line in ${missing_lines[@]+"${missing_lines[@]}"}; do printf '  %-8s %s\n' missing "$line"; done
if [ "${#missing_lines[@]}" -gt 0 ]; then
  echo
  echo "refusing to install anywhere until every prerequisite above is met; nothing was written" >&2
  exit 1
fi
echo

put_body() {
  jq -nc --arg message "$COMMIT_MESSAGE" --arg content "$content_b64" --arg branch "$1" --arg sha "$2" \
    '{message: $message, content: $content, branch: $branch} + (if $sha == "" then {} else {sha: $sha} end)'
}

# Called from an "if", where set -e does not apply, so every step says on its
# own whether it worked rather than trusting the shell to stop.
open_pull_request() {
  local slug="$1" base="$2" base_sha head_sha existing url
  base_sha="$(absent_or "repos/${slug}/git/ref/heads/${base}" | jq -r '.object.sha // empty')"
  if [ -z "$base_sha" ]; then return 1; fi
  if [ -z "$(absent_or "repos/${slug}/git/ref/heads/${PR_BRANCH}")" ]; then
    if ! jq -nc --arg ref "refs/heads/${PR_BRANCH}" --arg sha "$base_sha" '{ref: $ref, sha: $sha}' \
      | gh api -X POST "repos/${slug}/git/refs" --input - >/dev/null; then return 1; fi
  fi
  head_sha=""
  existing="$(absent_or "repos/${slug}/contents/${WORKFLOW_PATH}?ref=${PR_BRANCH}")"
  if [ -n "$existing" ]; then head_sha="$(jq -r '.sha // empty' <<<"$existing")"; fi
  if ! put_body "$PR_BRANCH" "$head_sha" | gh api -X PUT "repos/${slug}/contents/${WORKFLOW_PATH}" --input - >/dev/null; then return 1; fi
  url="$(jq -nc --arg title "$COMMIT_MESSAGE" --arg head "$PR_BRANCH" --arg base "$base" --arg body "$PR_BODY" \
    '{title: $title, head: $head, base: $base, body: $body}' \
    | gh api -X POST "repos/${slug}/pulls" --input - 2>/dev/null | jq -r '.html_url // empty' || true)"
  if [ -z "$url" ]; then
    # The branch may already carry an open pull request from an earlier run.
    url="$(absent_or "repos/${slug}/pulls?head=${owner}:${PR_BRANCH}&state=open" | jq -r '.[0].html_url // empty')"
  fi
  if [ -z "$url" ]; then return 1; fi
  printf '%s\n' "$url"
}

failed=0
results=()
i=0
while [ "$i" -lt "${#slugs[@]}" ]; do
  slug="${slugs[$i]}"
  branch="${branches[$i]}"
  action="${actions[$i]}"
  reason="${reasons[$i]}"
  file_sha="${file_shas[$i]}"
  i=$((i + 1))

  case "$action" in
    skip)
      results+=("${slug}"$'\t'"skipped"$'\t'"${reason}")
      continue
      ;;
    pull_request)
      if [ "$dry_run" = yes ]; then
        results+=("${slug}"$'\t'"would open a pull request"$'\t'"${reason}")
        continue
      fi
      echo "${slug}: opening a pull request against ${branch}"
      if url="$(open_pull_request "$slug" "$branch")"; then
        results+=("${slug}"$'\t'"pull request"$'\t'"${url}")
      else
        results+=("${slug}"$'\t'"failed"$'\t'"the pull request could not be opened")
        failed=1
      fi
      ;;
    commit)
      if [ "$dry_run" = yes ]; then
        results+=("${slug}"$'\t'"would commit"$'\t'"${reason}")
        continue
      fi
      echo "${slug}: committing to ${branch}"
      if put_body "$branch" "$file_sha" | gh api -X PUT "repos/${slug}/contents/${WORKFLOW_PATH}" --input - >/dev/null; then
        results+=("${slug}"$'\t'"committed"$'\t'"${branch}")
      else
        results+=("${slug}"$'\t'"failed"$'\t'"the commit was refused")
        failed=1
      fi
      ;;
  esac
done

echo
printf '%-40s %-26s %s\n' repository action reason
for row in ${results[@]+"${results[@]}"}; do
  IFS=$'\t' read -r slug action reason <<<"$row"
  printf '%-40s %-26s %s\n' "$slug" "$action" "$reason"
done

exit "$failed"
