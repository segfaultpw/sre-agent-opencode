# sre-agent-opencode

A fix request from [SRE Agent](https://sreagent.app) becomes a `/opencode` comment on a tracking issue in your repository. The reusable workflow in this package runs [opencode](https://opencode.ai) on your own GitHub Actions runner with a full checkout, so the agent can build and test before it proposes anything, and the run ends in one draft pull request that SRE Agent links to the card and reviews. Your code and your provider key stay on your runner: SRE Agent never runs opencode and never holds the key.

## Install

1. **Choose the GitHub identity opencode acts with.** Install the opencode GitHub App on the repository, https://github.com/apps/opencode-agent, and keep the workflow's default. Or skip the App and set `use_github_token: true` in the workflow below. In that mode the workflow gives the runner the bot's git identity and the token for the push, since the opencode action sets both only for the App, and the commits and the pull request are authored by `github-actions[bot]`; by GitHub's rule events created with `GITHUB_TOKEN` start no other workflows, so your own CI will not run on the fix pull request until someone pushes to it or closes and reopens it.

   Token mode also has a prerequisite: "Allow GitHub Actions to create and approve pull requests" must be enabled for the repository, and at the organization when the organization restricts it. Without it a run pushes its branch and then fails with "GitHub Actions is not permitted to create or approve pull requests". The App identity needs none of this.

   ```bash
   # default_workflow_permissions is required by the endpoint, so send back the value already in place
   gh api -X PUT orgs/<org>/actions/permissions/workflow \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

2. **Add your provider key as a repository secret.** The example runs on OpenRouter, so it expects `OPENROUTER_API_KEY`. Name the secret by provider: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY` or `DEEPSEEK_API_KEY` (the full list is in `scripts/provider_env.sh`). The workflow hands the secret to opencode under the variable the chosen provider reads, so pass whichever one matches your `model`.

   ```bash
   gh secret set OPENROUTER_API_KEY --repo <owner>/<repo>
   ```

3. **Add the workflow.** Copy [`examples/opencode.yml`](examples/opencode.yml) to `.github/workflows/opencode.yml`, set `model`, and point `provider_key` at the secret from step 2. Set a repository or organization variable `SRE_AGENT_BOT_LOGIN` to the login SRE Agent comments with, shown on the Integrations page (`sreagent-app[bot]` for the hosted platform; a self-hosted install has its own App's login). Keep the `permissions` block on the calling job: a called workflow can only keep or reduce what its caller grants, and repositories give `GITHUB_TOKEN` read-only access by default.

Then, in SRE Agent, open Integrations, the repository's settings, and set Fix runner to "opencode in your CI". SRE Agent reads `.github/workflows/` through its installation and refuses the setting until a workflow there references `segfaultpw/sre-agent-opencode`.

For more than a handful of repositories, see [Install on many repositories](#install-on-many-repositories).

## Install on many repositories

`scripts/install.sh` installs the workflow across an organization from a clone of this package, run as the owner of the repositories. It writes [`examples/opencode.yml`](examples/opencode.yml) byte for byte, so keep your own copy and pass `--workflow` when you changed the model or the secret.

```bash
git clone https://github.com/segfaultpw/sre-agent-opencode
cd sre-agent-opencode
bash scripts/install.sh --owner <org> --all --dry-run   # what it would do
bash scripts/install.sh --owner <org> --all             # do it
```

`--all` is every repository the opencode App reaches, read from the App installation on the owner, or every repository of the owner in token mode; archived ones are left out. Name repositories instead to install on some of them: `bash scripts/install.sh --owner <org> api web worker`.

For each repository, a `.github/workflows/opencode.yml` already byte-identical to what would be written is skipped, anything else is one commit on the default branch with the message `ci: run SRE Agent fix requests with opencode`, and a protected default branch takes a pull request from a `sre-agent/opencode-runner` branch instead. The run ends in a table of what happened to each repository.

Nothing is written until every prerequisite holds. The run reports them once, with the command that closes each gap, and refuses before the first write when one is missing: the token's own `workflow` scope, without which GitHub refuses every write under `.github/workflows/`; the opencode App installation in App mode, or "Allow GitHub Actions to create and approve pull requests" in token mode; the provider secret; and the `SRE_AGENT_BOT_LOGIN` variable, each of the last two on either the repository or the organization. Reading an organization's App installations needs the `admin:org` scope, and the run says so rather than reporting an unreadable installation as a missing one.

## Choosing a model

The example runs on OpenRouter, which fronts many vendors behind one key and bills per token. The prices are per million tokens, prompt and completion, as OpenRouter lists them today; all four models support tool calling, which the agent needs to read and edit files.

| Model | Prompt | Completion | Pick it for |
| --- | --- | --- | --- |
| `openrouter/deepseek/deepseek-v4-pro` | $0.80 | $1.60 | A repository with a real build and test suite. The example's default. |
| `openrouter/z-ai/glm-5` | $0.60 | $1.92 | The same tier from another vendor. |
| `openrouter/deepseek/deepseek-v4-flash` | $0.083 | $0.166 | Trying the runner on a small repository. |
| `openrouter/z-ai/glm-5.3-flash` | $0.075 | $0.25 | The same, from another vendor. |

Any provider in the mapping works: change `model` and point `provider_key` at that provider's secret, for example `anthropic/claude-sonnet-4-5` with `ANTHROPIC_API_KEY`.

## What happens on a fix request

1. SRE Agent finds or opens a tracking issue in the repository, titled with the card key and the request's title and labelled `sre-agent`. The body holds the fix brief and a marker line, `<!-- sre-agent:remediation:<id> -->`, that ties the run to the card.
2. SRE Agent comments `/opencode` on the issue. Your workflow starts on that comment, on your runner, with a checkout of the default branch.
3. The workflow installs this package's configuration and its `sre-fix` agent into the job. Nothing is committed to your repository: the configuration is passed to opencode through its environment, and the agent file is written into the checkout and excluded from git for the length of the job.
4. The agent reads the brief, makes the smallest change that addresses it, and runs your build and tests. When they pass, the opencode action commits the working tree to a branch named `opencode/issue<number>-<timestamp>` and opens a pull request whose body is the agent's own summary of what it changed, why, and what it ran. The workflow then checks the pull request's file list against the protected paths (see below) and marks it for SRE Agent: it prefixes the title with the card key, makes sure the body contains the marker line from the issue and the version stamp `<!-- sre-agent-opencode:vX.Y.Z -->` (the agent's own message usually carries both, so their position in the body is not fixed), and makes it a draft where your plan supports draft pull requests.
5. SRE Agent's webhook links the pull request to the card, reviews it the way it reviews a pull request its own agent opened, and posts the outcome on the card and in Slack with a link to the workflow run.
6. When no safe change exists, or the tests cannot be made to pass, the agent changes nothing and its answer is posted as a comment on the issue, beginning with `Declined:` and the reason. When the run opened no pull request, the workflow marks that comment the way it marks a pull request body: the marker line from the issue and the version stamp are appended to it, so SRE Agent ends the request the decline answers rather than the most recent one it sent. SRE Agent records the decline on the card. A run that ends with neither a pull request nor a decline is recorded as failed once the workflow's time bound has passed.

The branch name is the opencode action's, not SRE Agent's: the action, not the agent, commits and pushes.

## What the agent may and may not do

The configuration in [`config/opencode.json`](config/opencode.json) is a set of opencode's own permission gates, and [`agents/sre-fix.md`](agents/sre-fix.md) is the agent's prompt. The workflow passes the configuration to opencode after any configuration in your repository, so a repository can add to it but cannot loosen it.

- The edit gate refuses writes under `.github/` and to any path matching `*.env*`, `*secrets*` or `*.pem`, and the read gate refuses env files. Both apply to opencode's file tools.
- The bash gate refuses `git push`, `git remote`, `curl`, `wget`, `ssh`, `scp`, `rm -rf` and `sudo`. Each pattern is matched against the whole command string as written, so this is a guard against a careless step, not a sandbox: the agent runs with a shell on your runner, and a shell can reach the network or write a file without any tool.
- The bash gate also refuses the mutating cloud and cluster commands, which a fix in a repository has no reason to run: `kubectl delete`, `apply`, `edit`, `patch`, `scale`, `rollout`, `exec`, `cordon` and `drain`; `helm upgrade`, `install` and `uninstall`; `terraform apply` and `destroy`; the AWS CLI's 37 mutating verb families, written as `aws * <verb>-*`, plus `aws s3 cp`, `mv`, `rm` and `sync`, `aws ssm start-session` and `aws ecs execute-command`. Read calls stay open, so a diagnosis can still use `describe-`, `get-` and `list-`; `aws logs start-query` is the one read the verb families catch. The same whole-command matching applies, so these too are a guard against a careless step rather than a boundary. The boundary is the role the machine holds: in CI that is your runner's, and it matters more when the agent runs somewhere with credentials for live systems.
- Web fetch, web search, subagents and questions are off, the file tools cannot leave the checkout, and repeating the same tool call in a loop is refused. Session sharing is disabled, so the transcript is not uploaded to opencode's site.
- The agent never commits, pushes or opens a pull request itself: the opencode action does that once, after the agent finishes, from the working tree. It never merges and never touches the default branch.

What holds regardless of anything the agent does in that shell:

- The diff gate. After the action has pushed, the workflow reads the pull request's own file list. A pull request that touched `.github/`, an env file, a path containing `secrets` or a `.pem` key is closed with a comment saying which paths, and the job fails.
- The draft pull request, SRE Agent's review, and your own CI on the pull request. Nothing merges without a person.

The provider key and the job's token exist in the runner's environment while the agent runs. The log masks them, which is not the same as keeping them out of a shell's reach. For a repository whose CI holds production secrets, run this workflow on a dedicated runner or in a dedicated environment.

## Cost

You pay for the runner minutes the workflow uses and for the tokens your provider bills to your key. SRE Agent bills nothing for a run in your CI.

## Maintenance

- Pin `@v1` to receive fixes and additions as they are released; pin `@v1.2.0` to freeze a version. The major moves only on a breaking change, and the [CHANGELOG](CHANGELOG.md) says what to change in your workflow when it does.
- [`examples/dependabot.yml`](examples/dependabot.yml) proposes a bump for a frozen pin such as `@v1.2.0` and for the other actions your workflows use; a `@v1` pin has nothing to move until a v2 exists.
- Every pull request the workflow marks carries the stamp `<!-- sre-agent-opencode:vX.Y.Z -->`. SRE Agent records the version with the link, so the Integrations page can say which version of this package a repository ran.
- The workflow pins the opencode action at a release tag, and a bump of that pin is recorded in the [CHANGELOG](CHANGELOG.md). The pin covers the action only, not the opencode binary: the action's first step reads the latest opencode release and its install step runs opencode's install script, so the binary that enforces the gates is whatever is current. The install script accepts a version, but the action does not expose it and puts its own bin directory first on PATH, so this package cannot pin the binary from outside.

## Security

The brief on the tracking issue comes from alerts, investigations and cards, so it can carry text an attacker wrote, and the agent reads it as data. The gates in this package's configuration raise the cost of a careless or injected step: no web tools, no subagents, no file-tool writes to workflows, env files, secrets or keys, and the listed shell commands refused as written. They are opencode's tool gates, not a sandbox: the agent has a shell on your runner, where the provider key and the job's token exist in the environment. The controls that hold regardless are the diff gate (a pull request that touched a protected path is closed and the job fails), the draft pull request, SRE Agent's review, and your own CI on the pull request. In token mode (`use_github_token: true`) the pull request is opened with `GITHUB_TOKEN`, and by GitHub's rule it starts none of your other workflows, so that last line of defence is gone in that mode; the review and the draft remain. For a repository whose CI holds production secrets, run the workflow on a dedicated runner or in a dedicated environment. The issue is readable by everyone who can read the repository's issues, and it holds the same brief an operator sees on the card. Enable the runner per repository, as an administrator, and restrict who can start a run: the example workflow accepts comments from SRE Agent's login and from repository owners, members and collaborators only. The provider key is a secret of your repository; SRE Agent never holds it and never runs opencode.

## Inputs and secrets

The reusable workflow is `segfaultpw/sre-agent-opencode/.github/workflows/fix.yml`.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | required | `provider/model`, for example `openrouter/deepseek/deepseek-v4-pro` or `anthropic/claude-sonnet-4-5`. The provider prefix chooses which variable receives `provider_key`. |
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
| `token` | no | A token to use in place of `GITHUB_TOKEN` when `use_github_token` is set, for example a fine-grained token whose pull requests do start your workflows. GitHub reserves the name `github_token` inside a called workflow, hence the short name. The pull request is then opened by the token's own login, while the commits still carry the `github-actions[bot]` identity. |

The job's `permissions` block is fixed at `id-token`, `contents`, `pull-requests` and `issues`, because GitHub does not evaluate expressions in `permissions`. App mode uses `id-token` for the OIDC exchange and `pull-requests` for the diff gate and the marking step; token mode uses `contents`, `pull-requests` and `issues` for the push, the pull request and the comments.

Provider prefixes the workflow maps: `anthropic`, `openai`, `google`, `openrouter`, `xai`, `groq`, `mistral`, `deepseek`, `togetherai`, `fireworks-ai`, `cerebras`, `moonshotai`, `deepinfra`, `huggingface`, `zai`, `minimax`, `nvidia`, `opencode`, `vercel`. The variable names come from [models.dev](https://models.dev), the registry opencode reads providers from. A model with another prefix fails the run with a clear message before opencode starts.

## License

MIT, see [LICENSE](LICENSE).
