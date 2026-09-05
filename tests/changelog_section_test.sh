#!/usr/bin/env bash
# The release notes are cut from the CHANGELOG by heading; a tag without a
# section must refuse, and a section must stop at the next heading.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../scripts/changelog_section.sh"
fail=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/CHANGELOG.md" <<'EOF'
# Changelog

Intro line.

## Unreleased

Not yet.

## v1.1.0

Added a thing.

Fixed another.

## v1.0.0

Initial package.
EOF

got="$(bash "$script" "$work/CHANGELOG.md" v1.1.0)"
want=$'Added a thing.\n\nFixed another.'
if [ "$got" = "$want" ]; then echo "ok   v1.1.0 section is cut at the next heading"; else echo "FAIL v1.1.0 section: got '$got'"; fail=1; fi

got="$(bash "$script" "$work/CHANGELOG.md" v1.0.0)"
if [ "$got" = "Initial package." ]; then echo "ok   last section runs to the end of the file"; else echo "FAIL v1.0.0 section: got '$got'"; fail=1; fi

rc=0
got="$(bash "$script" "$work/CHANGELOG.md" v9.9.9 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && [[ "$got" == *"no section"* ]]; then echo "ok   a tag without a section is refused"; else echo "FAIL missing section: exit $rc, '$got'"; fail=1; fi

rc=0
bash "$script" "$work/CHANGELOG.md" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then echo "ok   missing arguments exit 2"; else echo "FAIL missing arguments exit $rc"; fail=1; fi

exit $fail
