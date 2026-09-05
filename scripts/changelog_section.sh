#!/usr/bin/env bash
# Prints the body of one version's section of the CHANGELOG: the lines after
# the "## <tag>" heading up to the next "## " heading. The release workflow
# uses it as the release notes, and refuses to release a tag the CHANGELOG
# does not describe.
set -euo pipefail

changelog="${1:-}"
tag="${2:-}"
if [ -z "$changelog" ] || [ -z "$tag" ]; then
  echo "usage: changelog_section.sh <CHANGELOG.md> <tag>" >&2
  exit 2
fi

section="$(awk -v heading="## ${tag}" '
  $0 == heading { on = 1; next }
  /^## / { if (on) exit }
  on { print }
' "$changelog")"

# Trim leading and trailing blank lines so the notes start with the text.
section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"
if [ -z "$section" ]; then
  echo "CHANGELOG has no section '## ${tag}'" >&2
  exit 1
fi
printf '%s\n' "$section"
