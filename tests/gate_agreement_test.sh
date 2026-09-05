#!/usr/bin/env bash
# The diff gate backstops the edit fence, so the two must agree path by path:
# for every path below, the fence says deny exactly when the gate flags it.
# A gate narrower than the fence lets a shell-written change through; a gate
# wider than the fence closes a pull request the agent was allowed to make.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$here/../config/opencode.json"
gate="$here/../scripts/protected_paths.sh"
fail=0
# shellcheck source=tests/lib/fence.sh
. "$here/lib/fence.sh"

paths=(
  .env
  src/.env
  .env.production
  src/.env.production
  secrets.yml
  config/secrets.yml
  config/secrets/x
  config/app-secrets.json
  my_secrets_dir/x.txt
  app.secrets.yml
  values-secrets.yaml
  docs/secretsauce.md
  key.pem
  deploy.pem
  a/b/key.pem
  .github/workflows/ci.yml
  .github/workflows/x.yml
  src/app.ex
  README.md
  docs/environment.md
  lib/pemdas.ex
)

for path in "${paths[@]}"; do
  fence="$(fence_resolve "$cfg" "$path")"
  rc=0
  printf '%s\n' "$path" | bash "$gate" >/dev/null || rc=$?
  case "$rc" in
    0) gate_says=allow ;;
    1) gate_says=deny ;;
    *) echo "FAIL gate exited $rc on $path"; fail=1; continue ;;
  esac
  if [ "$fence" = "$gate_says" ]; then
    echo "ok   $path: fence $fence, gate $gate_says"
  else
    echo "FAIL $path: fence says $fence, gate says $gate_says"; fail=1
  fi
done

exit $fail
