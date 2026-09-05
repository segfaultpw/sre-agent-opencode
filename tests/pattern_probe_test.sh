#!/usr/bin/env bash
# Resolves probe paths against the config's edit rules the way opencode does,
# so a pattern that looks right but never fires is caught here rather than in
# a customer's pull request. The translation and the resolver live in
# tests/lib/fence.sh, which names the opencode source they follow.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$here/../config/opencode.json"
fail=0
# shellcheck source=tests/lib/fence.sh
. "$here/lib/fence.sh"

probe() {
  local path="$1" want="$2" got
  got="$(fence_resolve "$cfg" "$path")"
  if [ "$got" = "$want" ]; then echo "ok   edit $path -> $want"; else echo "FAIL edit $path: expected $want, got $got"; fail=1; fi
}

# The translation itself, pinned on the shapes the fences rely on.
check_regex() {
  local pattern="$1" want="$2" got
  got="$(fence_compile "$pattern")"
  if [ "$got" = "$want" ]; then echo "ok   $pattern compiles to $want"; else echo "FAIL $pattern compiled to $got, expected $want"; fail=1; fi
}
check_regex '*.env*' '^.*\.env.*$'
check_regex '.github/**' '^\.github/.*.*$'
check_regex '**/*.pem' '^.*.*/.*\.pem$'
check_regex 'curl *' '^curl( .*)?$'
check_regex 'a?b' '^a.b$'

probe .env deny
probe src/.env deny
probe .env.production deny
probe secrets.yml deny
probe config/secrets/x deny
probe key.pem deny
probe a/b/key.pem deny
probe .github/workflows/ci.yml deny
probe src/app.ex allow

exit $fail
