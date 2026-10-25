#!/usr/bin/env bash
# tests/uid_split_test.sh skips on a workstation that cannot become root and
# fails in CI, where a skipped proof of the account split is a split nobody
# checked. This runs it on a machine made unable to become root (unshare and
# sudo that refuse) and reads the verdict.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

if [ "$(id -u)" -eq 0 ]; then
  echo "ok   skipped: root cannot be made unable to become root"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
for tool in unshare sudo; do
  printf '#!/usr/bin/env bash\nexit 1\n' > "$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done

verdict() {
  rc=0
  out="$(env -u CI -u GITHUB_ACTIONS "$@" PATH="$work/bin:$PATH" bash "$here/uid_split_test.sh" 2>&1)" || rc=$?
}

verdict
if [ "$rc" -eq 0 ] && grep -q '^SKIP ' <<<"$out"; then echo "ok   a workstation that cannot become root skips"; else echo "FAIL rc=$rc: $out"; fail=1; fi
verdict CI=true
if [ "$rc" -ne 0 ] && grep -q '^FAIL .*this is CI' <<<"$out"; then echo "ok   CI=true fails instead of skipping"; else echo "FAIL rc=$rc: $out"; fail=1; fi
verdict GITHUB_ACTIONS=true
if [ "$rc" -ne 0 ] && grep -q '^FAIL .*this is CI' <<<"$out"; then echo "ok   GITHUB_ACTIONS=true fails instead of skipping"; else echo "FAIL rc=$rc: $out"; fail=1; fi

exit $fail
