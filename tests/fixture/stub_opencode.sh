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
    printf 'aws_env: %s\n' "$(env | cut -d= -f1 | grep -E '^(AWS_|ECS_CONTAINER_METADATA_URI)' | LC_ALL=C sort | tr '\n' ' ')"
    if [ -n "${SRE_AGENT_AWS_ACCESS+set}" ]; then printf 'sees_SRE_AGENT_AWS_ACCESS: yes\n'; else printf 'sees_SRE_AGENT_AWS_ACCESS: no\n'; fi
    if [ -d .sre-agent-memory ]; then
      printf 'memory_files: %s\n' "$(cd .sre-agent-memory && find . \( -type f -o -type l \) | LC_ALL=C sort | sed 's#^\./##' | tr '\n' ' ')"
    else
      printf 'memory_files: absent\n'
    fi
  } >> "$STUB_OPENCODE_LOG"
fi

# What the agent can reach from where it runs, for tests/uid_split_test.sh: the
# account it runs as, what it can read of the runner and of the memory, and a
# process it leaves behind for the runner to clean up.
if [ -n "${STUB_OPENCODE_PROBE:-}" ]; then
  ws="${STUB_PROBE_WORKSPACE:?}"
  allowed() { if "$@" >/dev/null 2>&1; then echo allowed; else echo denied; fi; }
  {
    printf 'id: %s:%s\n' "$(id -u)" "$(id -g)"
    printf 'groups: %s\n' "$(grep '^Groups:' /proc/self/status | cut -f2 | tr -d ' ')"
    printf 'cap_eff: %s\n' "$(grep '^CapEff:' /proc/self/status | cut -f2)"
    printf 'home: %s\n' "$HOME"
    printf 'aws_env: %s\n' "$(env | cut -d= -f1 | grep -E '^(AWS_|ECS_CONTAINER_METADATA_URI)' | LC_ALL=C sort | tr '\n' ' ')"
    printf 'runner_environ: %s\n' "$(if cat "/proc/$PPID/environ" >/dev/null 2>&1; then echo readable; else echo denied; fi)"
    printf 'memory_list: %s\n' "$(allowed ls "$ws/memory")"
    printf 'memory_write: %s\n' "$(allowed bash -c ": >> '$ws/memory/acme/app/NOTES.md'")"
    printf 'other_read: %s\n' "$(allowed ls "$ws/repos/acme/other")"
    printf 'other_write: %s\n' "$(allowed bash -c ": > '$ws/repos/acme/other/planted'")"
    printf 'own_write: %s\n' "$(allowed bash -c ": >> README.md")"
    printf 'home_write: %s\n' "$(allowed bash -c ": >> '$HOME/probe'")"
    if [ -d .git ]; then
      printf 'git_status: %s\n' "$(if "${STUB_PROBE_GIT:?}" status --porcelain >/dev/null 2>&1; then echo ok; else echo failed; fi)"
    else
      echo 'git_status: ok'
    fi
  } >> "$STUB_OPENCODE_PROBE"
  setsid sleep 300 </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" > "${STUB_PROBE_SURVIVOR:?}"
fi

if [ -n "${STUB_OPENCODE_BRIEF_OUT:-}" ]; then
  printf '%s' "$brief" > "$STUB_OPENCODE_BRIEF_OUT"
fi

# What a run can do to the notes the runner copied in. The edits include the
# ones the runner must refuse (a symlink, a name outside the allowed set, a file
# outside NOTES.md and scripts/, an oversized NOTES.md), because the bounds are
# the runner's to enforce, not the agent's to keep.
case "${STUB_OPENCODE_MEMORY:-}" in
  edit)
    mkdir -p .sre-agent-memory/scripts
    printf 'the pool ceiling is 40 on the primary\n' >> .sre-agent-memory/NOTES.md
    printf '#!/usr/bin/env bash\n# checks the pool on the primary\necho ok\n' > .sre-agent-memory/scripts/check.sh
    rm -f .sre-agent-memory/scripts/old.sh
    ln -s /etc/passwd .sre-agent-memory/scripts/link.sh
    printf 'x\n' > ".sre-agent-memory/scripts/bad name"
    printf 'x\n' > .sre-agent-memory/stray.txt
    ;;
  big)
    head -c 70000 /dev/zero | tr '\0' 'a' > .sre-agent-memory/NOTES.md
    ;;
  wipe)
    rm -rf .sre-agent-memory
    ;;
  link)
    rm -rf .sre-agent-memory
    ln -s /etc .sre-agent-memory
    ;;
  copyout)
    # Memory content under another name: no path rule can see this, so the
    # runner compares what it is about to stage with what the memory holds.
    mkdir -p docs
    cp .sre-agent-memory/NOTES.md docs/notes-copy.md
    ;;
esac

emit() {
  local text="$1"
  if [ -n "${STUB_OPENCODE_MEMORY_SUMMARY:-}" ]; then
    text="${text}"$'\n\n## Memory\n'"${STUB_OPENCODE_MEMORY_SUMMARY}"
  fi
  if [ -n "${STUB_OPENCODE_TAIL:-}" ]; then
    text="${text}"$'\n\n'"${STUB_OPENCODE_TAIL}"
  fi
  jq -cn --arg t "$text" '{type: "text", timestamp: 0, sessionID: "stub", part: {type: "text", text: $t}}'
}

case "$mode" in
  fix)
    printf 'a line the fix added\n' >> README.md
    emit "Raised the connection pool ceiling in README.md so the service stops refusing checkouts under load. Ran bash test.sh and it passed."
    ;;
  titled)
    # What a model writes when it ignores the brief's title rule: a tag and
    # a header with an upper case type, then the explanation.
    printf 'a line the fix added\n' >> README.md
    emit "$(printf '[numaris] Feat(sso)!: allow the new IdP\n\nAdded the IdP to the allow list and ran bash test.sh.')"
    ;;
  untitled)
    printf 'a line the fix added\n' >> README.md
    emit "<!-- nothing to say -->"
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
  escape)
    # A grandchild in a session of its own, holding the pipes this process's
    # death would otherwise close. The runner kills the process group, which
    # misses it, so the child's "close" event never arrives: the shape where
    # waiting for the stream to end means never reporting the request at all.
    # setsid is what puts it outside the group. A plain background job would
    # be killed with its parent and would prove nothing.
    setsid sleep "${STUB_OPENCODE_SLEEP:-120}" &
    sleep "${STUB_OPENCODE_SLEEP:-120}"
    ;;
  *)
    echo "unknown stub mode: $mode" >&2
    exit 9
    ;;
esac

exit "${STUB_OPENCODE_EXIT:-0}"
