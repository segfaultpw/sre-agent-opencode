#!/usr/bin/env bash
# shellcheck disable=SC2016
# The patterns are workflow expressions quoted literally on purpose.
# Pins the token-mode plumbing in fix.yml that the end-to-end proof found
# missing: the opencode action configures a git identity and a push credential
# only in App mode, so in token mode the checkout must keep the token and a
# guarded step must give the runner an identity before the action runs. The
# guard matters: an unconditional local identity would override the global
# one the action sets in App mode and change who authors those commits.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
wf="$here/../.github/workflows/fix.yml"
fail=0

check() {
  local pattern="$1" label="$2"
  if grep -qF -- "$pattern" "$wf"; then echo "ok   $label"; else echo "FAIL $label: '$pattern' not in fix.yml"; fail=1; fi
}

check 'token: ${{ secrets.token || github.token }}' 'the checkout receives the token the pull request is opened with'
check 'persist-credentials: ${{ inputs.use_github_token }}' 'the checkout keeps credentials in token mode only'
check '- name: Give the token an identity' 'the identity step exists'
check 'git config user.name "github-actions[bot]"' 'the identity step sets the bot user name'
check 'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"' 'the identity step sets the bot email'

# The identity step is guarded by the token-mode input: the "if:" line that
# follows its name must name inputs.use_github_token.
guard="$(awk '/- name: Give the token an identity/ { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
if [[ "$guard" == *'if: ${{ inputs.use_github_token }}'* ]]; then
  echo "ok   the identity step runs in token mode only"
else
  echo "FAIL the identity step is not guarded by inputs.use_github_token (got '${guard}')"; fail=1
fi

check 'repos/segfaultpw/sre-agent-opencode/git/tags/${ref}' 'an annotated tag is dereferenced to its commit'
check 'id: opencode' 'the action step is addressable by the diagnostic step'
check '- name: Explain a refused pull request' 'the diagnostic step exists'
check 'GitHub Actions is not permitted to create or approve pull requests' 'the diagnostic step knows the policy message'
check 'Allow GitHub Actions to create and approve pull requests' 'the diagnostic step names the setting'

# The diagnostic step runs only after the action failed in token mode, so a
# green run never pays for it and an App-mode failure is not mislabelled.
diag="$(awk '/- name: Explain a refused pull request/ { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
for needle in 'failure()' "steps.opencode.outcome == 'failure'" 'inputs.use_github_token' "env.ISSUE_NUMBER != ''"; do
  if [[ "$diag" == *"$needle"* ]]; then
    echo "ok   the diagnostic step's guard names $needle"
  else
    echo "FAIL the diagnostic step's guard is missing $needle (got '${diag}')"; fail=1
  fi
done

# The identity must not be set anywhere unguarded, such as the install step.
if [ "$(grep -c 'git config user.name' "$wf")" -eq 1 ]; then
  echo "ok   the identity is set in one place"
else
  echo "FAIL git config user.name appears more than once in fix.yml"; fail=1
fi

# The checkout's own opencode configuration is merged with the package's and
# keeps its key order, so it can hold the package's denies at its own indexes
# and let its catch-all win, and a file under .opencode/plugin runs before any
# gate. Both doors strip those paths, and the CI door fetches the script at
# the workflow's own commit like every other one.
check 'curl -fsSL "$base/scripts/strip_repo_config.sh"' 'the strip script is fetched at the workflow commit'
check 'bash /tmp/sre-agent-strip_repo_config.sh .' 'the checkout is stripped before opencode runs'
strip_line="$(grep -n 'bash /tmp/sre-agent-strip_repo_config.sh' "$wf" | cut -d: -f1 | head -1)"
agent_line="$(grep -n 'SRE_AGENT_OPENCODE_VERSION}}/v' "$wf" | cut -d: -f1 | head -1)"
if [ -n "$strip_line" ] && [ -n "$agent_line" ] && [ "$strip_line" -lt "$agent_line" ]; then
  echo "ok   the strip runs before the package writes its own agent into .opencode"
else
  echo "FAIL the strip runs after the agent is written, where it would delete it"; fail=1
fi

# The decline path: the marking step publishes how many pull requests the run
# opened, and the decline step runs only when that number is zero, so a run
# that ended in a pull request never edits a comment as well.
check 'curl -fsSL "$base/scripts/decline_comment.sh"' 'the decline script is fetched at the workflow commit'
check 'id: mark' 'the marking step is addressable by the decline step'
check 'pull_requests=0' 'the marking step reports a run that opened none'
check '- name: Mark the decline comment for SRE Agent' 'the decline step exists'
check 'bash /tmp/sre-agent-decline_comment.sh' 'the decline step runs the fetched script'

decline="$(awk '/- name: Mark the decline comment for SRE Agent/ { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
for needle in '!inputs.dry_run' "env.ISSUE_NUMBER != ''" "steps.mark.outputs.pull_requests == '0'"; do
  if [[ "$decline" == *"$needle"* ]]; then
    echo "ok   the decline step's guard names $needle"
  else
    echo "FAIL the decline step's guard is missing $needle (got '${decline}')"; fail=1
  fi
done

# The issue's text reaches both post-steps through the environment only, never
# through an expression inside the script the runner executes, and it names
# both doors: the event of a run the relay dispatched carries no issue, so
# there the body is the one the brief step read off the issue.
for step in 'Mark the pull request for SRE Agent' 'Mark the decline comment for SRE Agent'; do
  passed="$(awk -v step="- name: $step" 'index($0, step) { found = 1 } found && /ISSUE_BODY:/ { print; exit }' "$wf")"
  for needle in 'steps.brief.outputs.body' 'github.event.issue.body'; do
    if [[ "$passed" == *"$needle"* ]]; then
      echo "ok   the step \"$step\" reads the issue body from the environment, ${needle} included"
    else
      echo "FAIL the step \"$step\" does not pass ISSUE_BODY from ${needle} (got '${passed}')"; fail=1
    fi
  done
done

# The relay door. SRE Agent's App cannot start a run by commenting: the
# opencode action asks GitHub for the commenting user's collaborator
# permission on every run a user event starts, in App mode and in token mode
# alike, and an App holds no permission level, so the run failed before the
# agent read anything. Upstream skips that check for repository events, so the
# example relays the App's comment as a workflow_dispatch of the same file.
# A dispatched run carries no issue and no comment, so the issue number
# arrives as an input and the brief, the title and the marker line are read
# off the issue.
ex="$here/../examples/opencode.yml"
readme="$here/../README.md"

check_ex() {
  local pattern="$1" label="$2"
  if grep -qF -- "$pattern" "$ex"; then echo "ok   $label"; else echo "FAIL $label: '$pattern' not in examples/opencode.yml"; fail=1; fi
}

# The lines of one job of a workflow file, of one 4-space key inside it, and
# of its "if:", which spans lines.
job_block() {
  awk -v job="^  $1:" '$0 ~ job { in_job = 1; next } in_job && /^  [a-z_-]+:/ { exit } in_job { print }' "$2"
}
job_key_block() {
  job_block "$1" "$3" | awk -v key="^    $2:" '$0 ~ key { in_key = 1; next } in_key && /^    [a-z_-]+:/ { exit } in_key { print }'
}
job_if() {
  job_block "$1" "$2" | awk '/^    if:/ { in_if = 1; print; next } in_if && /^    [a-z_-]+:/ { exit } in_if { print }'
}

check_ex 'workflow_dispatch:' 'the example takes a workflow_dispatch as well as a comment'
check_ex '      issue_number:' 'the dispatch carries the issue the run answers'
check_ex '      comment_id:' 'the dispatch carries the comment it answers'
for job in relay fix; do
  if grep -q "^  ${job}:" "$ex"; then echo "ok   the example declares the ${job} job"; else echo "FAIL the example has no ${job} job"; fail=1; fi
done

relay_if="$(job_if relay "$ex")"
for needle in "github.event_name == 'issue_comment'" 'vars.SRE_AGENT_BOT_LOGIN' '/opencode' '/oc'; do
  if [[ "$relay_if" == *"$needle"* ]]; then
    echo "ok   the relay job's guard names $needle"
  else
    echo "FAIL the relay job's guard is missing $needle (got '${relay_if}')"; fail=1
  fi
done

# Starting a run is all the relay may do: it holds the one permission
# workflow_dispatch needs and none of the ones the run itself needs.
relay_perms="$(job_key_block relay permissions "$ex" | sed 's/^ *//; /^$/d')"
if [ "$relay_perms" = "actions: write" ]; then
  echo "ok   the relay job holds actions: write and nothing else"
else
  echo "FAIL the relay job's permissions are not exactly 'actions: write' (got '${relay_perms}')"; fail=1
fi

check_ex 'gh workflow run opencode.yml' 'the relay dispatches this same workflow file'
check_ex '--ref "$DEFAULT_BRANCH"' 'the dispatch names the default branch, the only copy GitHub registers the trigger from'
check_ex '-f issue_number=' 'the dispatch passes the issue number'
check_ex '-f comment_id=' 'the dispatch passes the comment id'

fix_if="$(job_if fix "$ex")"
for needle in "github.event_name == 'workflow_dispatch'" 'OWNER' 'MEMBER' 'COLLABORATOR'; do
  if [[ "$fix_if" == *"$needle"* ]]; then
    echo "ok   the fix job's guard names $needle"
  else
    echo "FAIL the fix job's guard is missing $needle (got '${fix_if}')"; fail=1
  fi
done
if [[ "$fix_if" == *SRE_AGENT_BOT_LOGIN* ]]; then
  echo "FAIL the fix job still admits the bot login, whose run the action refuses"; fail=1
else
  echo "ok   the fix job no longer admits the bot login, whose run the action refuses"
fi
check_ex 'issue_number: ${{ inputs.issue_number }}' 'the fix job passes the dispatched issue number on'
check_ex 'comment_id: ${{ inputs.comment_id }}' 'the fix job passes the dispatched comment id on'

# fix.yml takes both, typed and empty by default, so a comment-started run
# passes nothing and behaves as it did.
for name in issue_number comment_id; do
  block="$(awk -v key="^      ${name}:" '$0 ~ key { in_key = 1; next } in_key && /^ {0,6}[a-z_]+:/ { exit } in_key { print }' "$wf")"
  if [[ "$block" == *'type: string'* ]] && [[ "$block" == *'default: ""'* ]]; then
    echo "ok   fix.yml takes ${name} as a string defaulting to empty"
  else
    echo "FAIL fix.yml does not declare ${name} as an empty string input (got '${block}')"; fail=1
  fi
done

# One resolver, and the concurrency group, which cannot read env. Every other
# reader of the issue number reads the resolved value, so the two doors cannot
# drift apart.
issue_refs="$(grep -c 'github\.event\.issue\.number' "$wf" || true)"
resolvers="$(grep 'github\.event\.issue\.number' "$wf" | sed 's/^ *//' || true)"
if [ "$issue_refs" -eq 2 ] && grep -q '^ISSUE_NUMBER:' <<<"$resolvers" && grep -q '^group:' <<<"$resolvers"; then
  echo "ok   the event's issue number is read by the resolver and the concurrency group only"
else
  echo "FAIL github.event.issue.number is read ${issue_refs} times: ${resolvers}"; fail=1
fi
check "ISSUE_NUMBER: \${{ inputs.issue_number != '' && inputs.issue_number || github.event.issue.number }}" 'the resolver prefers the relayed input and falls back to the event'

for step in 'Explain a refused pull request' 'Close a pull request that touched a protected path' 'Mark the pull request for SRE Agent' 'Mark the decline comment for SRE Agent'; do
  guard="$(awk -v step="- name: $step" 'index($0, step) { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
  if [[ "$guard" == *"env.ISSUE_NUMBER != ''"* ]]; then
    echo "ok   the step \"$step\" is guarded by the resolved issue number"
  else
    echo "FAIL the step \"$step\" is not guarded by env.ISSUE_NUMBER (got '${guard}')"; fail=1
  fi
done

# The action's prompt is mandatory on a dispatched run and there is no comment
# to read it from, so the brief is the issue's own body.
check '- name: Read the brief from the issue' 'the dispatch door reads the brief from the issue'
check 'id: brief' 'the brief step is addressable by the steps that need the issue'
check 'gh issue view "$ISSUE_NUMBER"' 'the brief is read at the resolved issue number'
check 'The text below is the brief. Follow its contract.' 'the prompt says what the text below it is'
check '/dev/urandom' 'the heredoc delimiter is random, because the issue body is text an attacker can write'
brief_guard="$(awk '/- name: Read the brief from the issue/ { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
for needle in "github.event_name == 'workflow_dispatch'" "env.ISSUE_NUMBER != ''"; do
  if [[ "$brief_guard" == *"$needle"* ]]; then
    echo "ok   the brief step's guard names $needle"
  else
    echo "FAIL the brief step's guard is missing $needle (got '${brief_guard}')"; fail=1
  fi
done
check "prompt: \${{ inputs.prompt != '' && inputs.prompt || steps.brief.outputs.prompt }}" 'the brief reaches the action only where there is no comment to read'

# The card key comes off the issue title on both doors.
title_passed="$(awk '/- name: Mark the pull request for SRE Agent/ { found = 1 } found && /ISSUE_TITLE:/ { print; exit }' "$wf")"
for needle in 'steps.brief.outputs.title' 'github.event.issue.title'; do
  if [[ "$title_passed" == *"$needle"* ]]; then
    echo "ok   the marking step reads the issue title from the environment, ${needle} included"
  else
    echo "FAIL the marking step does not pass ISSUE_TITLE from ${needle} (got '${title_passed}')"; fail=1
  fi
done

# A dispatched run's branch carries no issue number, so two runs of one
# repository see each other's. The marking step takes only the pull request
# whose body links this run, because marking another one would put this run's
# card key and marker line on it; the diff gate takes every candidate, because
# there over-inclusion only ever closes a pull request that touched a
# protected path.
mark_lookup="$(awk '/- name: Mark the pull request for SRE Agent/ { found = 1 } found && /run_prs\.sh/ { print; exit }' "$wf")"
if [[ "$mark_lookup" == *'run_prs.sh --mine'* ]]; then
  echo "ok   the marking step marks this run's own pull request only"
else
  echo "FAIL the marking step does not pass --mine (got '${mark_lookup}')"; fail=1
fi
gate_lookup="$(awk '/- name: Close a pull request that touched a protected path/ { found = 1 } found && /run_prs\.sh/ { print; exit }' "$wf")"
if [[ "$gate_lookup" != *'--mine'* ]]; then
  echo "ok   the diff gate inspects every candidate pull request"
else
  echo "FAIL the diff gate narrows its list to this run (got '${gate_lookup}')"; fail=1
fi

# The relay holds actions: write, so it cannot react to the comment it
# relayed; this job already writes issues, and the reaction is what tells the
# person watching the issue that the request was picked up.
check '- name: React to the comment the relay answered' 'the dispatched run reacts to the comment the relay answered'
react_guard="$(awk '/- name: React to the comment the relay answered/ { found = 1; next } found && /^ *if:/ { print; exit }' "$wf")"
for needle in "github.event_name == 'workflow_dispatch'" "inputs.comment_id != ''"; do
  if [[ "$react_guard" == *"$needle"* ]]; then
    echo "ok   the reaction step's guard names $needle"
  else
    echo "FAIL the reaction step's guard is missing $needle (got '${react_guard}')"; fail=1
  fi
done

# The README names the action pin, and the pin is what a reader checks a run
# against, so the two cannot drift.
pin_wf="$(sed -n 's#.*uses: anomalyco/opencode/github@\(v[0-9.]*\).*#\1#p' "$wf" | head -n 1)"
pin_readme="$(grep -oE 'anomalyco/opencode/github@v[0-9.]+' "$readme" | head -n 1 | sed 's/.*@//' || true)"
if [ -n "$pin_wf" ] && [ "$pin_wf" = "$pin_readme" ]; then
  echo "ok   the README names the action pin fix.yml runs (${pin_wf})"
else
  echo "FAIL fix.yml pins '${pin_wf}' and the README says '${pin_readme}'"; fail=1
fi

exit $fail
