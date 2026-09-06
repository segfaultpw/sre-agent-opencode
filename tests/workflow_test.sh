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
for needle in 'failure()' "steps.opencode.outcome == 'failure'" 'inputs.use_github_token' 'github.event.issue.number'; do
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
for needle in '!inputs.dry_run' 'github.event.issue.number' "steps.mark.outputs.pull_requests == '0'"; do
  if [[ "$decline" == *"$needle"* ]]; then
    echo "ok   the decline step's guard names $needle"
  else
    echo "FAIL the decline step's guard is missing $needle (got '${decline}')"; fail=1
  fi
done

# The issue's text reaches both post-steps through the environment only, never
# through an expression inside the script the runner executes.
for step in 'Mark the pull request for SRE Agent' 'Mark the decline comment for SRE Agent'; do
  passed="$(awk -v step="- name: $step" 'index($0, step) { found = 1 } found && /ISSUE_BODY:/ { print; exit }' "$wf")"
  if [[ "$passed" == *'ISSUE_BODY: ${{ github.event.issue.body }}'* ]]; then
    echo "ok   the step \"$step\" reads the issue body from the environment"
  else
    echo "FAIL the step \"$step\" does not pass ISSUE_BODY (got '${passed}')"; fail=1
  fi
done

exit $fail
