#!/usr/bin/env bash
# Stands in for the AWS CLI in tests/bucket_test.sh. It is installed as
# <work>/bin/aws and reads its controls from <work>/ctl, so nothing about a case
# travels through the environment the runner gives the real CLI (which is the
# thing under test).
#
# Every call is recorded: its arguments, one per field and separated by the
# unit separator (a path with a space or a shell metacharacter in it stays one
# field), how many requests the fixture platform had received when the call was
# made (which is how a case proves the bucket was read before the first poll and
# written before the report), and the names of the variables in its environment
# that belong to somebody else.
#
# Controls, all optional files in <work>/ctl:
#   aws_fail          every call fails with an access denied error
#   aws_fail_on       a call whose arguments contain this text fails
#   aws_partial_fail  a recursive download writes bucket_tree and then fails
#   bucket_tree       a directory copied, as it is, by `s3 cp --recursive`
#   fixture_log_path  where the fixture platform logs its requests
# A single-file upload is copied to <work>/ctl/uploaded/<bucket>/<key>. The uid
# each call ran as is appended to <work>/ctl/aws_uid.log. A download keeps the
# tree's modes and links but not its owner: the real CLI creates files as the
# account it runs as, and a stub run with capabilities must not do otherwise.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ctl="$here/../ctl"
us=$'\037'

line=""
for arg in "$@"; do line+="${arg}${us}"; done
printf '%s\n' "$line" >> "$ctl/aws_calls.log"
id -u >> "$ctl/aws_uid.log"

if [ -s "$ctl/fixture_log_path" ]; then
  grep -c '' "$(cat "$ctl/fixture_log_path")" >> "$ctl/aws_seen.log" || true
else
  echo 0 >> "$ctl/aws_seen.log"
fi

{
  env | cut -d= -f1 | grep -E '^(AWS_|SRE_|GH_|GITHUB_|OPENROUTER_|ANTHROPIC_|ECS_)' | LC_ALL=C sort | tr '\n' ' ' || true
  printf '\n'
} >> "$ctl/aws_env.log"

denied() {
  echo "An error occurred (AccessDenied) when calling the operation: Access Denied" >&2
  exit 1
}

joined="$*"
if [ -e "$ctl/aws_fail" ]; then denied; fi
if [ -s "$ctl/aws_fail_on" ] && [[ "$joined" == *"$(cat "$ctl/aws_fail_on")"* ]]; then denied; fi

if [ "${1:-}" = s3 ] && [ "${2:-}" = cp ] && [ "${3:-}" = --recursive ]; then
  dest="${5:-}"
  if [ -d "$ctl/bucket_tree" ] && [ -n "$dest" ]; then cp -a --no-preserve=ownership "$ctl/bucket_tree/." "$dest"; fi
  if [ -e "$ctl/aws_partial_fail" ]; then denied; fi
  exit 0
fi

if [ "${1:-}" = s3 ] && [ "${2:-}" = cp ] && [ "${4:0:5}" = "s3://" ]; then
  key="${4#s3://}"
  mkdir -p "$ctl/uploaded/$(dirname "$key")"
  cp -- "${3}" "$ctl/uploaded/$key"
  exit 0
fi

exit 0
