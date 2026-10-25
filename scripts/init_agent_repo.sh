#!/usr/bin/env bash
# Makes the current directory a git repository the agent can work in, from a
# bundle of the base commit's history, so that git status, log, blame, diff,
# bisect, branches and local commits all work and status starts clean.
#
# The runner runs this as the agent's account, in the request's work tree, and
# never reads the repository it makes: the runner has a git directory of its
# own, outside the tree, and takes the difference between the tree and the base
# from that. Nothing here reaches into that directory, which the agent's account
# cannot read, so there is no alternates file and no shared object store; the
# bundle is a file the runner wrote for this one purpose and deletes afterwards.
#
# origin is the github.com URL with no token in it. The agent's git credential
# helper answers github.com from GH_TOKEN.
#
# usage: init_agent_repo.sh <bundle> <branch> <default branch> <base sha> <origin url>
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: init_agent_repo.sh <bundle> <branch> <default branch> <base sha> <origin url>" >&2
  exit 2
fi
bundle="$1" branch="$2" default="$3" base="$4" url="$5"

git init -q -b "$branch" .
git fetch -q --no-tags "$bundle" "+refs/heads/${branch}:refs/remotes/origin/${default}"
git remote add origin "$url"
if [ "$(git rev-parse "refs/remotes/origin/${default}")" != "$base" ]; then
  echo "init_agent_repo.sh: the bundle does not end at the base commit ${base}" >&2
  exit 1
fi
git update-ref "refs/heads/${branch}" "$base"
git symbolic-ref HEAD "refs/heads/${branch}"
# The index from HEAD, without touching the tree: the tree is the base already.
git reset -q

# The runner takes tracked files out of the tree before the run (the
# repository's own opencode configuration), and marks them in its own index so
# that their absence is not a change. The same here, so status starts clean.
git ls-files -z --deleted | xargs -0 -r git update-index --skip-worktree --

# The runner's own files in the tree are not the agent's work.
mkdir -p .git/info
printf '.opencode/\n.sre-agent-memory/\n' >> .git/info/exclude
