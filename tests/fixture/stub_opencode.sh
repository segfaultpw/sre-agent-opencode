#!/usr/bin/env bash
# Stands in for the opencode binary in tests/runner_test.sh. It records what
# the runner handed it, then plays one of the endings a real run can have,
# emitting the same "--format json" event lines the binary emits: one object
# per line with a type, and a text event carrying the assistant's message.
#
# The recording is the point. The runner strips its own credentials from the
# agent's environment, and the only way to prove that from outside is to have
# the agent say what it could see.
set -euo pipefail

brief="$(cat)"
mode="${STUB_OPENCODE_MODE:-fix}"

if [ -n "${STUB_OPENCODE_LOG:-}" ]; then
  {
    printf 'argv: %s\n' "$*"
    printf 'cwd: %s\n' "$PWD"
    printf 'brief_bytes: %s\n' "${#brief}"
    printf 'default_agent: %s\n' "$(printf '%s' "${OPENCODE_CONFIG_CONTENT:-}" | jq -r '.default_agent // "missing"')"
    printf 'bash_fence: %s\n' "$(printf '%s' "${OPENCODE_CONFIG_CONTENT:-}" | jq -r '.permission.bash["git push*"] // "missing"')"
    printf 'autoupdate_disabled: %s\n' "${OPENCODE_DISABLE_AUTOUPDATE:-missing}"
    if [ -n "${SRE_API_KEY+set}" ]; then printf 'sees_SRE_API_KEY: yes\n'; else printf 'sees_SRE_API_KEY: no\n'; fi
    if [ -n "${SRE_GITHUB_TOKEN+set}" ]; then printf 'sees_SRE_GITHUB_TOKEN: yes\n'; else printf 'sees_SRE_GITHUB_TOKEN: no\n'; fi
  } >> "$STUB_OPENCODE_LOG"
fi

if [ -n "${STUB_OPENCODE_BRIEF_OUT:-}" ]; then
  printf '%s' "$brief" > "$STUB_OPENCODE_BRIEF_OUT"
fi

emit() {
  jq -cn --arg t "$1" '{type: "text", timestamp: 0, sessionID: "stub", part: {type: "text", text: $t}}'
}

case "$mode" in
  fix)
    printf 'a line the fix added\n' >> README.md
    emit "Raised the connection pool ceiling in README.md so the service stops refusing checkouts under load. Ran bash test.sh and it passed."
    ;;
  protected)
    # What a shell can do that the edit fence cannot see: the gate is what
    # catches this, after the run and before anything is published.
    mkdir -p .github/workflows
    printf 'on: push\n' > .github/workflows/exfil.yml
    emit "Added a workflow that publishes the build."
    ;;
  decline)
    emit "Declined: the brief describes a saturation alert whose cause is outside this repository. No change here would clear it, so the working tree is as I found it."
    ;;
  diagnose)
    emit "The failures come from the checkout service exhausting its database pool during the nightly reindex. The change belongs in acme/checkout, whose pool size is set in its own deployment configuration."
    ;;
  nochange)
    emit "Read the brief and the repository and found the behaviour already correct on this branch."
    ;;
  leak)
    # An agent that writes a credential into its own final message. That
    # message becomes the report's summary and the pull request body, so it
    # has to go through the same redaction as the lines the runner writes
    # itself. The value arrives in STUB_OPENCODE_LEAK, because the runner's
    # own variables are stripped from this process.
    printf 'a line the fix added\n' >> README.md
    emit "Raised the pool ceiling. For the record the token is ${STUB_OPENCODE_LEAK:-nothing}."
    ;;
  provider_error)
    # What a wrong or exhausted provider key looks like, and the commonest way
    # a real run ends without an answer: an error event and a non-zero exit,
    # which is exactly what tests/dry_run_test.sh sees from the real binary.
    jq -cn '{type: "error", timestamp: 0, sessionID: "stub", error: {name: "ProviderAuthError", data: {message: "User not found."}}}'
    echo "opencode: the provider refused the key" >&2
    exit 1
    ;;
  hang)
    sleep "${STUB_OPENCODE_SLEEP:-60}"
    ;;
  *)
    echo "unknown stub mode: $mode" >&2
    exit 9
    ;;
esac

exit "${STUB_OPENCODE_EXIT:-0}"
