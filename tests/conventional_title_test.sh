#!/usr/bin/env bash
# The title a pull request or a commit gets from this package is a Conventional
# Commits header. The runner normalises it in runner/conventional_title.js (the
# standard library only), and this runs that module over the fixture table and
# the generated inputs. SRE Agent's own SreCore.Remediation.ConventionalTitle
# runs a byte for byte copy of the same table in the platform's test suite
# (apps/sre_core/test/fixtures/conventional_titles.json), so a case added here
# is added there too. A case with a `key` is run with that card key, which is
# the only key a title may lose.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$here/conventional_title_test.js"
else
  echo "FAIL node is not on PATH"
  exit 1
fi
