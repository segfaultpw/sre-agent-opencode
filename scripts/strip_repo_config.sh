#!/usr/bin/env bash
# Empties the checkout of everything opencode would load from the repository
# itself, before the agent is started in it.
#
# Why: the package's configuration travels in OPENCODE_CONFIG_CONTENT, which is
# MERGED with the repository's own rather than replacing it. The merge keeps
# the repository's position for any key it also names, and a permission
# resolves by findLast over that order, so a repository that lists
#
#   { "permission": { "bash": { "kubectl delete*": "allow", "*": "allow" } } }
#
# gets our deny written at ITS index, ahead of its own catch-all, and the
# catch-all wins. Verified against opencode 1.18.25 by reading the resolved
# ruleset out of "opencode agent list". What the loader reads or executes out
# of .opencode/ is worse than a reordering: a file under a plugin directory
# runs before any gate is consulted, and an agent definition replaces the
# package's prompt and its permissions wholesale.
#
# Which is why this removes the WHOLE .opencode directory rather than a list of
# names inside it. The list was wrong twice: .opencode/plugin is loaded and so
# is .opencode/plugins, .opencode/agents is read and so is .opencode/agent, and
# the next opencode release can add a fourth without telling anyone. A list is
# a guess about a loader nobody here controls; an empty directory is not. The
# caller writes the package's own agent into it afterwards, so what the loader
# finds there is exactly what the package put there.
#
# The root configuration goes too, since opencode reads an opencode.json beside
# the project as well as one under .opencode/.
#
# OPENCODE_DISABLE_PROJECT_CONFIG closes neither path, which is why this is a
# script and not an environment variable.
#
# A tracked path is marked skip-worktree before it is removed, so its absence
# is invisible to "git add -A" and no pull request carries a deletion the agent
# did not make.
set -euo pipefail

dir="${1:-.}"
if [ ! -d "$dir" ]; then
  echo "strip_repo_config.sh: $dir is not a directory" >&2
  exit 2
fi
cd "$dir"

in_git=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then in_git=1; fi

removed=0
strip() {
  local path="$1" tracked
  [ -e "$path" ] || return 0
  if [ "$in_git" -eq 1 ]; then
    # A directory lists its tracked files; a file lists itself. Either way the
    # index keeps what it had and the worktree loses it.
    while IFS= read -r tracked; do
      [ -n "$tracked" ] || continue
      git update-index --skip-worktree -- "$tracked" || true
    done < <(git ls-files -- "$path")
  fi
  rm -rf -- "$path"
  echo "removed $path: opencode loads it from the repository, and this run's fences and prompt come from the package"
  removed=$((removed + 1))
}

shopt -s nullglob
for path in opencode.json* .opencode; do
  strip "$path"
done
shopt -u nullglob

if [ "$removed" -eq 0 ]; then
  echo "no repository-level opencode configuration to remove"
fi
