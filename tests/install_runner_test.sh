#!/usr/bin/env bash
# The systemd install: the unit, and the installer that puts it in place.
#
# The installer creates an account and writes to /etc on a machine that is
# about to hold live credentials, so every path it can take is pinned here
# against stubs on PATH, with the assertions on what was written: the unit
# lands byte for byte, the environment file is a template with no value in it
# and an operator's own file is never overwritten, the package is root-owned,
# and anything absent refuses before the first write rather than half way
# through.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/.."
script="$pkg/runner/install-runner.sh"
unit="$pkg/runner/sre-agent-fix-runner.service"
service=sre-agent-fix-runner
state_dir=/var/lib/sre-agent-fix-runner
env_file=/etc/sre-agent-fix-runner/env
unit_file=/etc/systemd/system/sre-agent-fix-runner.service
fail=0

for f in "$script" "$unit"; do
  if [ -f "$f" ]; then echo "ok   $(basename "$f") exists"; else echo "FAIL $f is missing"; exit 1; fi
done

echo "--- the unit runs the runner unprivileged, restarted, and fenced ---"
u() {
  local pattern="$1" label="$2"
  if grep -qxF -- "$pattern" "$unit"; then echo "ok   $label"; else echo "FAIL $label: '$pattern' is not a line of the unit"; fail=1; fi
}
u "User=${service}" 'it runs as the dedicated account'
u "Group=${service}" 'it runs as the dedicated group'
u "WorkingDirectory=${state_dir}" 'it works in the state directory'
u "EnvironmentFile=${env_file}" 'it reads the environment file the installer writes'
u "Restart=always" 'it comes back, because a queued fix request waits for it'
u "NoNewPrivileges=yes" 'it cannot gain privileges'
u "PrivateTmp=yes" 'it gets a private /tmp'
u "ProtectSystem=strict" 'the filesystem is read-only to it'
u "ProtectHome=yes" 'it cannot read anybody home directory'
u "ReadWritePaths=${state_dir}" 'the state directory is writable'

# ProtectSystem=strict means the writable list is the whole of what this
# service may change, so a second entry is a decision, not a detail.
if [ "$(grep -c '^ReadWritePaths=' "$unit")" -eq 1 ]; then
  echo "ok   the state directory is the only writable path"
else
  echo "FAIL more than one ReadWritePaths: $(grep '^ReadWritePaths=' "$unit")"; fail=1
fi

# ProtectHome hides /home, so a home directory there would be invisible to the
# process and opencode's own state would have nowhere to go.
if grep -qxF "Environment=HOME=${state_dir}" "$unit"; then
  echo "ok   HOME is inside the one writable path, which ProtectHome makes necessary"
else
  echo "FAIL HOME is not set to ${state_dir}"; fail=1
fi

# The same entrypoint the image starts through: one refusal, two installs.
if grep -qxF 'ExecStart=/opt/sre-agent-opencode/runner/entrypoint.sh' "$unit"; then
  echo "ok   it starts through the entrypoint the container image starts through"
else
  echo "FAIL ExecStart is not the entrypoint: $(grep '^ExecStart=' "$unit")"; fail=1
fi

# Restart=always on a runner whose API key is refused would poll for ever.
if grep -q '^StartLimitBurst=' "$unit" && grep -q '^StartLimitIntervalSec=' "$unit"; then
  echo "ok   a runner that cannot start ends in failed rather than restarting for ever"
else
  echo "FAIL there is no start limit, so a refused key restarts without end"; fail=1
fi

# systemd ignores a directive it does not know, so a misspelled hardening line
# looks present in the file and does nothing at run time. Where systemd is
# installed, it is the one that says whether it understood them.
if command -v systemd-analyze >/dev/null 2>&1; then
  verify="$(systemd-analyze verify "$unit" 2>&1 || true)"
  if grep -qiE 'unknown key|failed to parse' <<<"$verify"; then
    echo "FAIL systemd did not understand the unit: ${verify}"; fail=1
  else
    echo "ok   systemd understands every directive in the unit"
  fi
else
  echo "skip systemd-analyze is not installed here, so systemd did not read the unit"
fi

echo "--- the installer ---"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
real_id="$(command -v id)"

# Every privileged command the installer reaches for, recording what it was
# asked to do. id answers 0 by default, which is how the rest of the script is
# reachable at all from a test that is not root.
cat > "$work/bin/id" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-u" ]; then printf '%s\n' "\${STUB_ID_UID:-0}"; exit 0; fi
exec "$real_id" "\$@"
EOF
for tool in systemctl groupadd useradd chown; do
  cat > "$work/bin/$tool" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "$tool" "\$*" >> "\$STUB_LOG"
EOF
done
# getent answers "no such account" unless a case says otherwise, so the happy
# path creates the account and a second run does not.
cat > "$work/bin/getent" <<'EOF'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >> "$STUB_LOG"
if [ "${STUB_ACCOUNT_EXISTS:-no}" = yes ]; then
  printf '%s:x:999:999:::\n' "$2"
  exit 0
fi
exit 2
EOF
for tool in node git gh opencode; do
  cat > "$work/bin/$tool" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
done
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
export STUB_LOG="$work/stub.log"
bash_bin="$(command -v bash)"

# The commands the installer runs that are not stubbed, so a case can hand it a
# PATH holding nothing but the stubs it wants and still leave the script able
# to copy a file. Without this, "opencode is missing" could only be tested on a
# machine that happens not to have opencode.
mkdir -p "$work/coreutils"
for c in dirname install cp rm mv find chmod cat bash; do ln -s "$(command -v "$c")" "$work/coreutils/$c"; done

root=""
out=""
rc=0
install_into() {
  root="$work/$1"
  mkdir -p "$root"
  : > "$STUB_LOG"
  rc=0
  out="$(bash "$script" --prefix "$root" 2>&1)" || rc=$?
}

install_into first
if [ "$rc" -eq 0 ]; then echo "ok   a complete clone installs"; else echo "FAIL the installer exited $rc: $out"; fail=1; fi
if cmp -s "$unit" "${root}${unit_file}"; then echo "ok   the unit is installed byte for byte"; else echo "FAIL the unit at ${root}${unit_file} is not the one in the repository"; fail=1; fi
for relative in VERSION config/opencode.json agents/sre-fix.md scripts/protected_paths.sh runner/runner.js runner/entrypoint.sh; do
  if [ -s "${root}/opt/sre-agent-opencode/${relative}" ]; then echo "ok   the package's ${relative} is installed"; else echo "FAIL ${relative} is missing from the installed package"; fail=1; fi
done
if [ -x "${root}/opt/sre-agent-opencode/runner/entrypoint.sh" ]; then echo "ok   the entrypoint is executable"; else echo "FAIL the entrypoint is not executable"; fail=1; fi
if [ -d "${root}${state_dir}/workspace" ]; then echo "ok   the workspace is created"; else echo "FAIL there is no workspace directory"; fail=1; fi
if [ "$(stat -c '%a' "${root}${state_dir}")" = "750" ]; then echo "ok   the state directory is not world readable"; else echo "FAIL state directory mode $(stat -c '%a' "${root}${state_dir}")"; fail=1; fi

echo "--- the installer writes no credential ---"
if [ "$(stat -c '%a' "${root}${env_file}")" = "600" ]; then echo "ok   the environment file is 0600"; else echo "FAIL environment file mode $(stat -c '%a' "${root}${env_file}")"; fail=1; fi
if grep -q "chown root:root ${root}${env_file}" "$STUB_LOG"; then echo "ok   the environment file is given to root"; else echo "FAIL no chown of the environment file: $(cat "$STUB_LOG")"; fail=1; fi
for name in SRE_SERVER_URL SRE_API_KEY SRE_MODEL SRE_GITHUB_TOKEN; do
  if grep -qx "${name}=" "${root}${env_file}"; then echo "ok   ${name} is present and empty"; else echo "FAIL ${name} is not an empty assignment: $(grep "^${name}=" "${root}${env_file}" || echo absent)"; fail=1; fi
done
# Any assignment carrying a value would be a credential this script invented.
if ! grep -qE '^[A-Z_]+=.+' "${root}${env_file}"; then echo "ok   no variable in the template carries a value"; else echo "FAIL a value was written: $(grep -E '^[A-Z_]+=.+' "${root}${env_file}")"; fail=1; fi

echo "--- the account and the reload ---"
if grep -q "groupadd --system ${service}" "$STUB_LOG"; then echo "ok   the group is created"; else echo "FAIL no groupadd: $(cat "$STUB_LOG")"; fail=1; fi
useradd_call="$(grep '^useradd ' "$STUB_LOG" || true)"
for needle in "--system" "--gid ${service}" "--home-dir ${state_dir}" "nologin" "$service"; do
  if [[ "$useradd_call" == *"$needle"* ]]; then echo "ok   the account is created with ${needle}"; else echo "FAIL useradd was '${useradd_call}'"; fail=1; fi
done
if grep -q "chown ${service}:${service} ${root}${state_dir}" "$STUB_LOG"; then echo "ok   the state directory belongs to the account"; else echo "FAIL the state directory was not given to the account: $(cat "$STUB_LOG")"; fail=1; fi
# The agent runs as that account, so the package it loads its fences from must
# not belong to it.
if grep -q "chown -R root:root ${root}/opt/sre-agent-opencode" "$STUB_LOG"; then echo "ok   the package belongs to root, not to the account the agent runs as"; else echo "FAIL the package was not given to root: $(cat "$STUB_LOG")"; fail=1; fi
if grep -q '^systemctl daemon-reload' "$STUB_LOG"; then echo "ok   systemd is told about the unit"; else echo "FAIL no daemon-reload: $(cat "$STUB_LOG")"; fail=1; fi

echo "--- what the operator is told ---"
for needle in "SRE_SERVER_URL" "SRE_API_KEY" "SRE_MODEL" "$env_file" "systemctl enable --now ${service}" "no credential was written"; do
  if grep -qF -- "$needle" <<<"$out"; then echo "ok   the report names ${needle}"; else echo "FAIL the report does not name ${needle}: $out"; fail=1; fi
done

echo "--- a second run keeps the operator's own file ---"
filled="$(printf 'SRE_SERVER_URL=https://app.example.invalid\nSRE_API_KEY=sre-agent-poll-%048d\n' 5)"
printf '%s\n' "$filled" > "${root}${env_file}"
export STUB_ACCOUNT_EXISTS=yes
: > "$STUB_LOG"
rc=0
out="$(bash "$script" --prefix "$root" 2>&1)" || rc=$?
unset STUB_ACCOUNT_EXISTS
if [ "$rc" -eq 0 ]; then echo "ok   a second run installs over the first"; else echo "FAIL the second run exited $rc: $out"; fail=1; fi
if [ "$(cat "${root}${env_file}")" = "$filled" ]; then echo "ok   an environment file that holds credentials is left alone"; else echo "FAIL the operator's environment file was overwritten"; fail=1; fi
if ! grep -q '^useradd ' "$STUB_LOG"; then echo "ok   an account that exists is not created again"; else echo "FAIL useradd ran for an existing account"; fail=1; fi
if cmp -s "$unit" "${root}${unit_file}"; then echo "ok   the unit is refreshed on a second run"; else echo "FAIL the unit is not the one in the repository"; fail=1; fi
# cp -R of a directory onto itself is how a re-install grows config/config.
if [ ! -e "${root}/opt/sre-agent-opencode/config/config" ]; then echo "ok   a re-install replaces the package rather than nesting it"; else echo "FAIL the package was copied inside itself"; fail=1; fi

echo "--- it refuses rather than proceeding ---"
refusal() {
  local label="$1"
  shift
  root="$work/$label"
  mkdir -p "$root"
  : > "$STUB_LOG"
  rc=0
  out="$(env "$@" "$bash_bin" "$script" --prefix "$root" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then echo "ok   ${label} refuses"; else echo "FAIL ${label} installed anyway: $out"; fail=1; fi
  if [ -z "$(find "$root" -mindepth 1 -print -quit)" ]; then echo "ok   ${label} writes nothing"; else echo "FAIL ${label} wrote $(find "$root" -mindepth 1 | head -n 3)"; fail=1; fi
}

refusal not-root STUB_ID_UID=1000
if grep -qF 'has to run as root' <<<"$out"; then echo "ok   the refusal says it needs root"; else echo "FAIL output: $out"; fail=1; fi

# A machine with the tools but no systemd is a container host, and the refusal
# points it at the image rather than leaving it stuck.
mkdir -p "$work/without-systemctl"
for tool in id groupadd useradd chown getent node git gh opencode; do
  cp "$work/bin/$tool" "$work/without-systemctl/$tool"
done
refusal no-systemd PATH="$work/without-systemctl:$work/coreutils"
if grep -qF 'no systemctl' <<<"$out"; then echo "ok   a machine without systemd is told to run the image instead"; else echo "FAIL output: $out"; fail=1; fi
if grep -qF 'sre-agent-opencode-runner' <<<"$out"; then echo "ok   the refusal names the container image"; else echo "FAIL output: $out"; fail=1; fi

mkdir -p "$work/without-opencode"
for tool in id systemctl groupadd useradd chown getent node git gh; do
  cp "$work/bin/$tool" "$work/without-opencode/$tool"
done
refusal no-opencode PATH="$work/without-opencode:$work/coreutils"
if grep -qF 'opencode is not on PATH' <<<"$out"; then echo "ok   a missing opencode refuses"; else echo "FAIL output: $out"; fail=1; fi
if grep -qF 'https://opencode.ai/install' <<<"$out"; then echo "ok   the refusal carries the command that installs it"; else echo "FAIL output: $out"; fail=1; fi

# A clone missing the files the runner reads at run time would install a runner
# that starts and fails its first job.
mkdir -p "$work/partial-clone/runner"
cp "$script" "$work/partial-clone/runner/install-runner.sh"
root="$work/partial"
mkdir -p "$root"
rc=0
out="$(bash "$work/partial-clone/runner/install-runner.sh" --prefix "$root" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   an incomplete clone refuses"; else echo "FAIL an incomplete clone installed anyway: $out"; fail=1; fi
if [ -z "$(find "$root" -mindepth 1 -print -quit)" ]; then echo "ok   an incomplete clone writes nothing"; else echo "FAIL it wrote $(find "$root" -mindepth 1 | head -n 3)"; fail=1; fi
if grep -qF 'not a complete clone' <<<"$out"; then echo "ok   the refusal says the clone is incomplete"; else echo "FAIL output: $out"; fail=1; fi
if grep -qF 'runner/runner.js' <<<"$out"; then echo "ok   the refusal names a file that is missing"; else echo "FAIL output: $out"; fail=1; fi

# ProtectHome=yes in the unit, so a tool that is on PATH here but lives inside
# a home directory is invisible to the service: the install reports success and
# the unit lands in failed on its first start.
mkdir -p "$work/home/operator/bin" "$work/bin-home-hidden"
for tool in id systemctl groupadd useradd chown getent node git gh; do
  cp "$work/bin/$tool" "$work/bin-home-hidden/$tool"
done
cp "$work/bin/opencode" "$work/home/operator/bin/opencode"
refusal hidden-opencode PATH="$work/bin-home-hidden:$work/home/operator/bin:$work/coreutils" HOME="$work/home/operator"
if grep -qF 'inside a home directory' <<<"$out"; then echo "ok   a tool inside a home directory refuses, because ProtectHome hides it from the service"; else echo "FAIL output: $out"; fail=1; fi
if grep -qF '/usr/local/bin/opencode' <<<"$out"; then echo "ok   the refusal carries the copy that puts it on the system PATH"; else echo "FAIL output: $out"; fail=1; fi

echo "--- an argument it cannot use is refused out loud ---"
rc=0
out="$(bash "$script" --prefix 2>&1)" || rc=$?
if [ "$rc" -eq 2 ]; then echo "ok   --prefix with nothing after it exits 2, the usage status"; else echo "FAIL exited $rc rather than 2: $out"; fail=1; fi
if grep -qF -- '--prefix needs a directory' <<<"$out"; then echo "ok   it says which argument was wrong"; else echo "FAIL it said nothing about the argument: $out"; fail=1; fi

echo "--- an upgrade restarts a runner that is already running ---"
install_into upgraded
if grep -q "^systemctl try-restart ${service}" "$STUB_LOG"; then
  echo "ok   systemd is asked to restart a running runner, so what is running is what was installed"
else
  echo "FAIL no try-restart, so an upgraded runner keeps running the replaced tree: $(grep '^systemctl' "$STUB_LOG")"; fail=1
fi

echo "--- a copy that fails leaves the working install alone ---"
# Each directory used to be deleted and then copied, so a copy that died on a
# full disk or a bad clone left a runner with no package to load. The tree is
# staged beside the target and swapped, so a failure changes nothing.
install_into fragile
before="$(cat "${root}/opt/sre-agent-opencode/VERSION")"
mkdir -p "$work/failing-cp"
for tool in id systemctl groupadd useradd chown getent node git gh opencode; do
  cp "$work/bin/$tool" "$work/failing-cp/$tool"
done
cat > "$work/failing-cp/cp" <<EOF
#!/usr/bin/env bash
# Fails on the scripts directory, which is neither the first copied nor the
# last, so the failure lands with the tree half assembled.
for arg in "\$@"; do
  case "\$arg" in */scripts) echo "cp: no space left on device" >&2; exit 1 ;; esac
done
exec "$(command -v cp)" "\$@"
EOF
chmod +x "$work/failing-cp/cp"
rc=0
out="$(env PATH="$work/failing-cp:$work/coreutils" "$bash_bin" "$script" --prefix "$root" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "ok   a failing copy fails the install"; else echo "FAIL the install reported success: $out"; fail=1; fi
for relative in VERSION config/opencode.json agents/sre-fix.md scripts/protected_paths.sh runner/runner.js; do
  if [ -s "${root}/opt/sre-agent-opencode/${relative}" ]; then echo "ok   ${relative} survived the failed upgrade"; else echo "FAIL the failed upgrade destroyed ${relative}"; fail=1; fi
done
if [ "$(cat "${root}/opt/sre-agent-opencode/VERSION")" = "$before" ]; then echo "ok   the installed version is still the one that was working"; else echo "FAIL VERSION changed on a failed install"; fail=1; fi
if [ -z "$(find "${root}/opt" -maxdepth 1 -name 'sre-agent-opencode.staging.*' -print -quit)" ]; then echo "ok   the staged tree is cleaned up rather than left beside the package"; else echo "FAIL a staging directory was left behind"; fail=1; fi

if grep -qF 'bash tests/install_runner_test.sh' "$pkg/.github/workflows/ci.yml"; then
  echo "ok   CI runs this test"
else
  echo "FAIL ci.yml does not run tests/install_runner_test.sh"; fail=1
fi

exit $fail
