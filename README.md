# sre-agent-opencode

A fix request from [SRE Agent](https://sreagent.app) becomes a `/opencode` comment on a tracking issue in your repository. The reusable workflow in this package runs [opencode](https://opencode.ai) on your own GitHub Actions runner with a full checkout, so the agent can build and test before it proposes anything, and the run ends in one draft pull request that SRE Agent links to the card and reviews. Your code and your provider key stay on your runner: SRE Agent never runs opencode and never holds the key.

## Install

1. **Choose the GitHub identity opencode acts with.** Install the opencode GitHub App on the repository, https://github.com/apps/opencode-agent, and keep the workflow's default. Or skip the App and set `use_github_token: true` in the workflow below. In that mode the pull request is opened by `github-actions[bot]`, and by GitHub's rule events created with `GITHUB_TOKEN` start no other workflows, so your own CI will not run on the fix pull request until someone pushes to it or closes and reopens it.

2. **Add your provider key as a repository secret.** Name it by provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY` or `DEEPSEEK_API_KEY` (the full list is in `scripts/provider_env.sh`). The workflow hands the secret to opencode under the variable the chosen provider reads, so pass whichever one matches your `model`.

   ```bash
   gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
   ```

3. **Add the workflow.** Copy [`examples/opencode.yml`](examples/opencode.yml) to `.github/workflows/opencode.yml`, set `model`, and point `provider_key` at the secret from step 2. Set a repository or organization variable `SRE_AGENT_BOT_LOGIN` to the login SRE Agent comments with, shown on the Integrations page (`sreagent-app[bot]` for the hosted platform; a self-hosted install has its own App's login). Keep the `permissions` block on the calling job: a called workflow can only keep or reduce what its caller grants, and repositories give `GITHUB_TOKEN` read-only access by default.

Then, in SRE Agent, open Integrations, the repository's settings, and set Fix runner to "opencode in your CI". SRE Agent reads `.github/workflows/` through its installation and refuses the setting until a workflow there references `segfaultpw/sre-agent-opencode`.

## What happens on a fix request

1. SRE Agent finds or opens a tracking issue in the repository, titled with the card key and the request's title and labelled `sre-agent`. The body holds the fix brief and a marker line, `<!-- sre-agent:remediation:<id> -->`, that ties the run to the card.
2. SRE Agent comments `/opencode` on the issue. Your workflow starts on that comment, on your runner, with a checkout of the default branch.
3. The workflow installs this package's configuration and its `sre-fix` agent into the job. Nothing is committed to your repository: the configuration is passed to opencode through its environment, and the agent file is written into the checkout and excluded from git for the length of the job.
4. The agent reads the brief, makes the smallest change that addresses it, and runs your build and tests. When they pass, the opencode action commits the working tree to a branch named `opencode/issue<number>-<timestamp>` and opens a pull request whose body is the agent's own summary of what it changed, why, and what it ran. The workflow then marks the pull request for SRE Agent: it makes it a draft, prefixes the title with the card key, and appends the marker line from the issue and the version stamp `<!-- sre-agent-opencode:vX.Y.Z -->` to the body.
5. SRE Agent's webhook links the pull request to the card, reviews it the way it reviews a pull request its own agent opened, and posts the outcome on the card and in Slack with a link to the workflow run.
6. When no safe change exists, or the tests cannot be made to pass, the agent changes nothing and its answer is posted as a comment on the issue, beginning with `Declined:` and the reason. SRE Agent records the decline on the card. A run that ends with neither a pull request nor a decline is recorded as failed once the workflow's time bound has passed.

The branch name is the opencode action's, not SRE Agent's: the action, not the agent, commits and pushes.

## What the agent may and may not do

The fences live in [`config/opencode.json`](config/opencode.json) and [`agents/sre-fix.md`](agents/sre-fix.md). The workflow passes the configuration to opencode after any configuration in your repository, so a repository can add to it but cannot loosen it.

- It may edit any file except those under `.github/`, env files (`*.env*`), anything named `secrets*`, and `*.pem` keys. It may not read env files either.
- It may run shell commands, including your build and test commands. It may not run `git push`, `git remote`, `curl`, `wget`, `ssh`, `scp`, `rm -rf` or `sudo`.
- It has no web fetch, no web search, no subagents, and no access outside the checkout. Repeating the same tool call in a loop is refused, and so is asking a question, since nobody is there to answer.
- It never commits, pushes or opens a pull request itself: the opencode action does that once, after the agent finishes, from the working tree. It never merges and never touches the default branch.
- Session sharing is disabled: the transcript is not uploaded to opencode's site.

## Cost

You pay for the runner minutes the workflow uses and for the tokens your provider bills to your key. SRE Agent bills nothing for a run in your CI.

## Maintenance

- Pin `@v1` to receive fixes and additions as they are released; pin `@v1.2.0` to freeze a version. The major moves only on a breaking change, and the [CHANGELOG](CHANGELOG.md) says what to change in your workflow when it does.
- [`examples/dependabot.yml`](examples/dependabot.yml) keeps the pin current in a repository that uses Dependabot for GitHub Actions.
- Every pull request the workflow marks carries the stamp `<!-- sre-agent-opencode:vX.Y.Z -->`. SRE Agent records the version with the link, so the Integrations page can say which version of this package a repository ran.

## Security

The brief on the tracking issue comes from alerts, investigations and cards, so it can carry text an attacker wrote, and the agent reads it as data. The fences in this package's configuration are the first line: no network tools, no pushes, no edits to workflows or secrets, no access outside the checkout. The draft pull request, SRE Agent's review and your own CI on the pull request are the second line: nothing merges without a person. The issue is readable by everyone who can read the repository's issues, and it holds the same brief an operator sees on the card. Enable the runner per repository, as an administrator, and restrict who can start a run: the example workflow accepts comments from SRE Agent's login and from repository owners, members and collaborators only. The provider key is a secret of your repository; SRE Agent never holds it and never runs opencode.

## Inputs and secrets

The reusable workflow is `segfaultpw/sre-agent-opencode/.github/workflows/fix.yml`.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | required | `provider/model`, for example `anthropic/claude-sonnet-4-5`. The provider prefix chooses which variable receives `provider_key`. |
| `prompt` | string | `""` | An instruction that replaces the comment. Leave it empty for the comment door: the action reads the comment and the issue itself. |
| `agent` | string | `sre-fix` | The primary agent opencode runs, set as opencode's `default_agent`. |
| `variant` | string | `""` | The provider's reasoning effort, for example `high`. |
| `use_github_token` | boolean | `false` | Act as `github-actions[bot]` with `GITHUB_TOKEN` instead of the opencode App. |
| `runner` | string | `ubuntu-latest` | The `runs-on` label, for self-hosted or third-party runners. |
| `timeout_minutes` | number | `30` | The job's time bound. |
| `dry_run` | boolean | `false` | Install the configuration and map the secret, then stop. This package's own CI uses it. |

| Secret | Required | Meaning |
| --- | --- | --- |
| `provider_key` | yes | The provider API key. |
| `github_token` | no | A token to use in place of `GITHUB_TOKEN` when `use_github_token` is set, for example a fine-grained token whose pull requests do start your workflows. |

Provider prefixes the workflow maps: `anthropic`, `openai`, `google`, `openrouter`, `xai`, `groq`, `mistral`, `deepseek`, `togetherai`, `fireworks-ai`, `cerebras`, `moonshotai`, `deepinfra`, `huggingface`, `zai`, `minimax`, `nvidia`, `opencode`, `vercel`. The variable names come from [models.dev](https://models.dev), the registry opencode reads providers from. A model with another prefix fails the run with a clear message before opencode starts.

## License

MIT, see [LICENSE](LICENSE).
