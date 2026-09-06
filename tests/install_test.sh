#!/usr/bin/env bash
# The bulk install writes a workflow into other people's repositories, so
# every path it can take is pinned here against a gh that answers from
# fixtures and records every write: a repository that has the file already is
# skipped rather than committed to, a protected default branch gets a pull
# request instead of a commit, a dry run records nothing, and a missing
# prerequisite refuses before the first write with the command that fixes it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/install.sh"
example="$here/../examples/opencode.yml"
fail=0

if [ -f "$script" ]; then echo "ok   script exists"; else echo "FAIL $script is missing"; exit 1; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/fixtures"
export FAKE_GH_DIR="$work/fixtures" FAKE_GH_LOG="$work/gh.log" FAKE_GH_WRITES="$work/writes.log"

# Answers a GET from fixtures/get_<endpoint with / ? & = as _>.json, records
# every write with its request body, and treats a missing fixture as a 404,
# which is how gh reports an absent secret, variable, file or branch.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "repo" ] && [ "$2" = "list" ]; then
  cat "$FAKE_GH_DIR/repo_list.json"
  exit 0
fi
if [ "$1" != "api" ]; then echo "unexpected gh call: $*" >&2; exit 9; fi
shift
method=GET
endpoint=""
headers=no
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    --input) shift 2 ;;
    -i|--include) headers=yes; shift ;;
    --paginate) shift ;;
    *) endpoint="$1"; shift ;;
  esac
done
if [ "${FAKE_GH_FORBIDDEN:-}" = "$endpoint" ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2
  exit 1
fi
key="$(printf '%s' "$endpoint" | tr '/?&=' '____')"
if [ "$method" != "GET" ]; then
  { printf '%s %s\n' "$method" "$endpoint"; cat; printf '\n'; } >> "$FAKE_GH_WRITES"
  if [ -f "$FAKE_GH_DIR/write_${key}.json" ]; then cat "$FAKE_GH_DIR/write_${key}.json"; else echo '{}'; fi
  exit 0
fi
if [ "$headers" = yes ]; then
  printf 'HTTP/2.0 200 OK\n'
  printf 'X-Oauth-Scopes: %s\n\n' "${FAKE_GH_SCOPES:-admin:org, repo, workflow}"
fi
if [ -f "$FAKE_GH_DIR/get_${key}.json" ]; then
  cat "$FAKE_GH_DIR/get_${key}.json"
else
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

reset_fixtures() {
  rm -f "$FAKE_GH_DIR"/*.json "$FAKE_GH_LOG" "$FAKE_GH_WRITES"
  : > "$FAKE_GH_LOG"
  : > "$FAKE_GH_WRITES"
  echo '{"login": "acme", "type": "Organization"}' > "$FAKE_GH_DIR/get_orgs_acme.json"
  echo '{"default_branch": "main", "id": 4242, "full_name": "acme/app"}' > "$FAKE_GH_DIR/get_repos_acme_app.json"
  echo '{"name": "main", "protected": false}' > "$FAKE_GH_DIR/get_repos_acme_app_branches_main.json"
  echo '{"total_count": 1, "installations": [{"id": 777, "app_slug": "opencode-agent", "repository_selection": "all"}]}' > "$FAKE_GH_DIR/get_orgs_acme_installations.json"
  echo '{"name": "OPENROUTER_API_KEY", "visibility": "all"}' > "$FAKE_GH_DIR/get_orgs_acme_actions_secrets_OPENROUTER_API_KEY.json"
  echo '{"name": "SRE_AGENT_BOT_LOGIN", "value": "sreagent-app[bot]", "visibility": "all"}' > "$FAKE_GH_DIR/get_orgs_acme_actions_variables_SRE_AGENT_BOT_LOGIN.json"
}

# A repository with no workflow yet and an unprotected default branch.
reset_fixtures
out="$(bash "$script" --owner acme app)"
if grep -q '^PUT repos/acme/app/contents/.github/workflows/opencode.yml$' "$FAKE_GH_WRITES"; then echo "ok   the workflow is written through the contents API"; else echo "FAIL no write: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
sent="$(sed -n '2,$p' "$FAKE_GH_WRITES" | jq -s '.[0]')"
if [ "$(jq -r '.message' <<<"$sent")" = "ci: run SRE Agent fix requests with opencode" ]; then echo "ok   the commit message is the one the platform expects"; else echo "FAIL message: $(jq -r '.message' <<<"$sent")"; fail=1; fi
if [ "$(jq -r '.branch' <<<"$sent")" = "main" ]; then echo "ok   the commit lands on the default branch"; else echo "FAIL branch: $(jq -r '.branch' <<<"$sent")"; fail=1; fi
if [ "$(jq -r '.content' <<<"$sent" | base64 -d)" = "$(cat "$example")" ]; then echo "ok   the content is the example workflow"; else echo "FAIL the content is not the example"; fail=1; fi
if [ "$(jq -r '.sha // "none"' <<<"$sent")" = "none" ]; then echo "ok   a new file is created without a sha"; else echo "FAIL a sha was sent for a file that does not exist"; fail=1; fi
if grep -qE '^acme/app +committed' <<<"$out"; then echo "ok   the table says the repository was committed to"; else echo "FAIL table: $out"; fail=1; fi

# The same repository a second time: byte-identical, so nothing is written.
reset_fixtures
jq -n --arg content "$(base64 < "$example" | tr -d '\n')" '{content: $content, sha: "abc123"}' > "$FAKE_GH_DIR/get_repos_acme_app_contents_.github_workflows_opencode.yml_ref_main.json"
out="$(bash "$script" --owner acme app)"
if [ ! -s "$FAKE_GH_WRITES" ]; then echo "ok   a repository that already has the workflow is not written to"; else echo "FAIL wrote: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
if grep -qE '^acme/app +skipped +already installed' <<<"$out"; then echo "ok   the table says why it was skipped"; else echo "FAIL table: $out"; fail=1; fi

# A workflow that differs is updated in place, which the contents API only
# allows with the file's current sha.
reset_fixtures
jq -n --arg content "$(printf 'name: opencode\n' | base64 | tr -d '\n')" '{content: $content, sha: "abc123"}' > "$FAKE_GH_DIR/get_repos_acme_app_contents_.github_workflows_opencode.yml_ref_main.json"
out="$(bash "$script" --owner acme app)"
sent="$(sed -n '2,$p' "$FAKE_GH_WRITES" | jq -s '.[0]')"
if [ "$(jq -r '.sha // "none"' <<<"$sent")" = "abc123" ]; then echo "ok   an existing file is replaced with its sha"; else echo "FAIL sha: $(jq -r '.sha // "none"' <<<"$sent")"; fail=1; fi

# A protected default branch cannot take a commit, so the change arrives as a
# pull request from a branch of its own.
reset_fixtures
echo '{"name": "main", "protected": true}' > "$FAKE_GH_DIR/get_repos_acme_app_branches_main.json"
echo '{"object": {"sha": "deadbeef"}}' > "$FAKE_GH_DIR/get_repos_acme_app_git_ref_heads_main.json"
echo '{"html_url": "https://github.com/acme/app/pull/9", "number": 9}' > "$FAKE_GH_DIR/write_repos_acme_app_pulls.json"
out="$(bash "$script" --owner acme app)"
if grep -q '^POST repos/acme/app/git/refs$' "$FAKE_GH_WRITES"; then echo "ok   a branch is created for the pull request"; else echo "FAIL no branch: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
if grep -q '^POST repos/acme/app/pulls$' "$FAKE_GH_WRITES"; then echo "ok   a pull request is opened"; else echo "FAIL no pull request: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
branch="$(grep -A1 '^POST repos/acme/app/git/refs$' "$FAKE_GH_WRITES" | tail -n 1 | jq -r '.ref')"
put="$(grep -A1 '^PUT repos/acme/app/contents/.github/workflows/opencode.yml$' "$FAKE_GH_WRITES" | tail -n 1 | jq -r '.branch')"
if [ "$branch" = "refs/heads/${put}" ]; then echo "ok   the commit lands on the branch that was created"; else echo "FAIL ref $branch, commit on $put"; fail=1; fi
if [ "$put" != "main" ]; then echo "ok   nothing is committed to the protected branch"; else echo "FAIL committed to the protected branch"; fail=1; fi
if grep -qE '^acme/app +pull request +https://github.com/acme/app/pull/9' <<<"$out"; then echo "ok   the table carries the pull request link"; else echo "FAIL table: $out"; fail=1; fi

# A dry run reports the same decisions and writes nothing.
reset_fixtures
out="$(bash "$script" --owner acme app --dry-run)"
if [ ! -s "$FAKE_GH_WRITES" ]; then echo "ok   a dry run writes nothing"; else echo "FAIL a dry run wrote: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
if grep -qE '^acme/app +would commit' <<<"$out"; then echo "ok   a dry run says what it would do"; else echo "FAIL table: $out"; fail=1; fi

# --all takes the repositories from the App installation the owner has.
reset_fixtures
echo '[{"name": "app", "isArchived": false}, {"name": "old", "isArchived": true}]' > "$FAKE_GH_DIR/repo_list.json"
out="$(bash "$script" --owner acme --all --dry-run)"
if grep -q '^acme/app ' <<<"$out" && ! grep -q '^acme/old ' <<<"$out"; then echo "ok   --all takes the owner's repositories and skips archived ones"; else echo "FAIL table: $out"; fail=1; fi

# A prerequisite that is missing refuses the whole run, before any write, and
# names the command that fixes it.
reset_fixtures
rm -f "$FAKE_GH_DIR/get_orgs_acme_actions_secrets_OPENROUTER_API_KEY.json"
rc=0
out="$(bash "$script" --owner acme app 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a missing provider secret refuses the run"; else echo "FAIL exited 0 without the secret"; fail=1; fi
if [ ! -s "$FAKE_GH_WRITES" ]; then echo "ok   nothing is written when a prerequisite is missing"; else echo "FAIL wrote: $(cat "$FAKE_GH_WRITES")"; fail=1; fi
if grep -qF 'gh secret set OPENROUTER_API_KEY --repo acme/app' <<<"$out"; then echo "ok   the refusal carries the command that fixes it"; else echo "FAIL output: $out"; fail=1; fi

reset_fixtures
rm -f "$FAKE_GH_DIR/get_orgs_acme_actions_variables_SRE_AGENT_BOT_LOGIN.json"
rc=0
out="$(bash "$script" --owner acme app 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'gh variable set SRE_AGENT_BOT_LOGIN' <<<"$out"; then echo "ok   a missing SRE_AGENT_BOT_LOGIN refuses the run with its command"; else echo "FAIL exit $rc: $out"; fail=1; fi

reset_fixtures
rm -f "$FAKE_GH_DIR/get_orgs_acme_installations.json"
rc=0
out="$(bash "$script" --owner acme app 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'the opencode App is not installed on acme' <<<"$out"; then echo "ok   an App the owner has not installed refuses the run"; else echo "FAIL exit $rc: $out"; fail=1; fi
if grep -qF 'https://github.com/apps/opencode-agent/installations/new' <<<"$out"; then echo "ok   the refusal says where to install the App"; else echo "FAIL output: $out"; fail=1; fi

# A token that may not read the owner's installations is not the same thing
# as an owner who never installed the App, and the report must not say it is.
reset_fixtures
rc=0
out="$(FAKE_GH_FORBIDDEN=orgs/acme/installations bash "$script" --owner acme app 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && grep -qF 'cannot be read with this token' <<<"$out"; then echo "ok   an unreadable installation list refuses rather than assuming"; else echo "FAIL exit $rc: $out"; fail=1; fi
if grep -qF 'gh auth refresh -h github.com -s admin:org' <<<"$out"; then echo "ok   the refusal asks for the scope that reads it"; else echo "FAIL output: $out"; fail=1; fi

# Token mode needs no App, and needs the pull request policy instead.
token_workflow="$work/token-opencode.yml"
sed 's|# use_github_token: true.*|use_github_token: true|' "$example" > "$token_workflow"
reset_fixtures
rm -f "$FAKE_GH_DIR/get_orgs_acme_installations.json"
echo '{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}' > "$FAKE_GH_DIR/get_repos_acme_app_actions_permissions_workflow.json"
rc=0
out="$(bash "$script" --owner acme app --workflow "$token_workflow" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   token mode refuses while Actions may not open pull requests"; else echo "FAIL exited 0 with the policy off"; fail=1; fi
if grep -qF 'gh api -X PUT repos/acme/app/actions/permissions/workflow' <<<"$out"; then echo "ok   the refusal carries the policy command for the repository"; else echo "FAIL output: $out"; fail=1; fi

reset_fixtures
rm -f "$FAKE_GH_DIR/get_orgs_acme_installations.json"
echo '{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": true}' > "$FAKE_GH_DIR/get_repos_acme_app_actions_permissions_workflow.json"
echo '{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": true}' > "$FAKE_GH_DIR/get_orgs_acme_actions_permissions_workflow.json"
rc=0
out="$(bash "$script" --owner acme app --workflow "$token_workflow")" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^PUT repos/acme/app/contents/.github/workflows/opencode.yml$' "$FAKE_GH_WRITES"; then echo "ok   token mode installs without the App once the policy allows it"; else echo "FAIL exit $rc: $out"; fail=1; fi

# A token that may not write workflow files would fail on the first repository.
reset_fixtures
rc=0
out="$(FAKE_GH_SCOPES='repo, admin:org' bash "$script" --owner acme app 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] && [ ! -s "$FAKE_GH_WRITES" ]; then echo "ok   a token without the workflow scope refuses before writing"; else echo "FAIL exit $rc: $out"; fail=1; fi
if grep -qF 'gh auth refresh' <<<"$out"; then echo "ok   the refusal says how to add the scope"; else echo "FAIL output: $out"; fail=1; fi

exit $fail
