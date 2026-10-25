# sre-agent-opencode

A fix request from [SRE Agent](https://sreagent.app) becomes a `/opencode` comment on a tracking issue in your repository. The reusable workflow in this package runs [opencode](https://opencode.ai) on your own GitHub Actions runner with a full checkout, so the agent can build and test before it proposes anything, and the run ends in one draft pull request that SRE Agent links to the card and reviews. Your code and your provider key stay on your runner: SRE Agent never runs opencode and never holds the key.

The same agent, under the same fences, also runs on a machine you own, where it has whatever access you granted that machine and can answer requests that name no repository. See [Run it on your own machine](#run-it-on-your-own-machine).

## Install

1. **Choose the GitHub identity opencode acts with.** This is who opencode acts as, not who may start a run: whichever identity you choose, the opencode action asks GitHub for the commenting user's collaborator permission on every run a comment starts, and a GitHub App holds no permission level on a repository, so SRE Agent's own `/opencode` comment cannot start a run directly. The example workflow relays it through `workflow_dispatch`, which the action does not check, and a member's own comment still runs directly. See [How a run starts](#how-a-run-starts).

   Install the opencode GitHub App on the repository, https://github.com/apps/opencode-agent, and keep the workflow's default. Or skip the App and set `use_github_token: true` in the workflow below. In that mode the workflow gives the runner the bot's git identity and the token for the push, since the opencode action sets both only for the App, and the commits and the pull request are authored by `github-actions[bot]`; by GitHub's rule events created with `GITHUB_TOKEN` start no other workflows, so your own CI will not run on the fix pull request until someone pushes to it or closes and reopens it.

   Token mode changes nothing about the permission check above: the action runs it in both modes, from the same code, and there is no input or environment variable that skips it. Token mode also has a prerequisite: "Allow GitHub Actions to create and approve pull requests" must be enabled for the repository, and at the organization when the organization restricts it. Without it a run pushes its branch and then fails with "GitHub Actions is not permitted to create or approve pull requests". The App identity needs none of this.

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

### How a run starts

A member's `/opencode` comment on the tracking issue, from an owner, a member or a collaborator, starts the fix job on that comment. That is the path the opencode action was written for: it checks the commenting user's collaborator permission, reacts to the comment, and answers on the issue.

SRE Agent's own comment takes one step more. The platform comments as a GitHub App, and an App holds no permission level on a repository, so that same check answers `none` and the run fails with "User sreagent-app[bot] does not have write permissions" before the agent reads anything. The `relay` job in the example answers that comment instead. It holds `actions: write` and nothing else, and all it does is fire a `workflow_dispatch` of the same workflow file with the issue number, which the action does not check because a dispatched run has no commenting user to check. The fix job then runs as it always did: it reads the brief off the issue rather than out of the comment, and ends in the same marked draft pull request.

Two things follow from a dispatched run having no comment in its event. It reacts to SRE Agent's comment with a rocket when the run starts, rather than when the action picks it up. And the action posts nothing on the issue for such a run, so the workflow writes the decline itself when the run opened no pull request, and stays quiet when it saw one it could not tell apart from its own: a comment beginning `Declined:` with the issue's marker line already in it, whose reason is the same sentence every time and whose link is to the run, where the agent's own words are. The marker is in the comment as posted rather than added afterwards, because SRE Agent reads a decline off the comment it was sent and not off later edits; that is what ends the request the decline answers rather than the most recent one on the issue. On a member's own comment the action still posts its own answer and that is the decline SRE Agent reads, word for word.

The relay job runs on `ubuntu-latest`, which is where you change it if your repository runs on runners of its own; the fix job takes the reusable workflow's `runner` input for the same reason. A relay that could not start the run shows up in your Actions tab as a failed `relay` job on the `opencode` workflow, with the error `gh` gave: after a rename of the workflow file, for example, "could not find any workflows named opencode.yml". The relay needs the workflow to be at `.github/workflows/opencode.yml` on the default branch, since that is the file it names and GitHub registers `workflow_dispatch` from the default branch's copy.

### Upgrading from v1.2.0 or older

Re-run `scripts/install.sh`, or copy [`examples/opencode.yml`](examples/opencode.yml) again and put your `model` and `provider_key` back: the relay job is new in v1.3.0 and an older copy of the file has no way to start a run from SRE Agent's comment. If you worked around the failure by filtering `SRE_AGENT_BOT_LOGIN` out of the workflow's `if:`, remove that filter; the new file admits the bot's comment in the relay job and nowhere else. The change has to reach the default branch before the relay works.

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

1. SRE Agent finds or opens a tracking issue in the repository, titled with the request's title as a Conventional Commits header and labelled `sre-agent`. The body holds the fix brief, a `Refs: <card key>` line when the request came from a card, and a marker line, `<!-- sre-agent:remediation:<id> -->`, that ties the run to the card.
2. SRE Agent comments `/opencode` on the issue. Your workflow's relay job turns that comment into a `workflow_dispatch` of itself, and the run starts from that, on your runner, with a checkout of the default branch. A member's own `/opencode` comment starts the run on the comment itself. See [How a run starts](#how-a-run-starts).
3. The workflow installs this package's configuration and its `sre-fix` agent into the job. Nothing is committed to your repository: the configuration is passed to opencode through its environment, and the agent file is written into the checkout and excluded from git for the length of the job.
4. The agent reads the brief, makes the smallest change that addresses it, and runs your build and tests. When they pass, the opencode action commits the working tree to a branch it names after the door the run came in by, `opencode/issue<number>-<timestamp>` for a comment-started run and `opencode/dispatch-<hex>-<timestamp>` for a relayed one, and opens a pull request whose body is the agent's own summary of what it changed, why, and what it ran. The workflow then checks the pull request's file list against the protected paths (see below) and marks it for SRE Agent: it normalises the title into a Conventional Commits header (see [Pull request titles](#pull-request-titles)), makes sure the body contains the `Refs: <card key>` line, the marker line from the issue and the version stamp `<!-- sre-agent-opencode:vX.Y.Z -->` (the agent's own message usually carries the marker and the stamp, so their position in the body is not fixed), and makes it a draft where your plan supports draft pull requests.
5. SRE Agent's webhook links the pull request to the card, reviews it the way it reviews a pull request its own agent opened, and posts the outcome on the card and in Slack with a link to the workflow run.
6. When no safe change exists, or the tests cannot be made to pass, the agent changes nothing and its answer is posted as a comment on the issue, beginning with `Declined:` and the reason. On a comment-started run that comment is the action's own, so the reason is the agent's own words. The action posts nothing on the issue for a relayed run, so there the workflow posts the decline itself once the run has opened no pull request: the same `Declined:` shape carrying the issue's marker line, a reason that reads the same every time, and a link to the run, whose log holds what the agent actually said. The marker is in that comment as posted, since SRE Agent reads a decline off the comment it was sent and not off later edits, and it is what ends the request the decline answers rather than the most recent one it sent. The workflow then appends the version stamp to that comment, and on a comment-started run it appends the marker and the stamp to the action's own, which is what a reader of the issue sees. A relayed run that found pull requests on dispatch branches it could not recognise as its own posts no decline at all, since one of them may be the run's own work under a footer the action has changed. SRE Agent records the decline on the card. A run that ends with neither a pull request nor a decline is recorded as failed once the workflow's time bound has passed.

The branch name is the opencode action's, not SRE Agent's: the action, not the agent, commits and pushes.

### Pull request titles

A repository that checks its pull request titles, or reads commit types for its releases, refuses `ABC-12: widen the timeout`. From v1.4.0 the pull requests this package opens follow [Conventional Commits](https://www.conventionalcommits.org), on both doors, by the same rules SRE Agent applies to the pull requests its own agent opens:

- Leading `[tags]` are dropped, and so is the key of the card the request came from (`ABC-12:` or `ABC-12 `), in any order. No other key is touched: `SHA-256: verify the checksum`, `GPT-4 support` and another card's `OPS-7: widen` keep their subjects.
- A title that already is `type(scope)!: subject`, with one of `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style` or `revert`, is kept, the type in lower case. A header with no subject, or with a subject made only of combining marks (the combining diacritical blocks, the variation selectors and the zero width joiner), takes `apply the requested fix`.
- Anything else becomes `fix: <text>`, from the first line that is not blank.
- The result is one line of at most 256 characters (GitHub's limit), never cut inside a character and its marks or inside a joined emoji by the runner; the CI door's jq cut can split a few rare sequences (emoji tag sequences, regional indicator pairs, Hangul jamo) in a title of 252 characters or more; a scope that would leave fewer than ten characters for the subject is dropped, not cut in half.
- Whitespace is a space or a tab, a line break is LF, CR, VT, FF, U+0085, U+2028 or U+2029, and U+FEFF is removed, so the rules do not depend on how a language defines Unicode whitespace.

The CI door applies this to the title the opencode action gave the pull request ([`scripts/conventional_title.sh`](scripts/conventional_title.sh)), with the card key the tracking issue names ([`scripts/card_key.sh`](scripts/card_key.sh): the `Refs: ABC-12` line SRE Agent writes directly before the marker line, or `ABC-12:` at the start of the issue title, which is where an older SRE Agent put it). The card key goes into the body as a `Refs: ABC-12` line next to the marker ([`scripts/pr_body.sh`](scripts/pr_body.sh)). The machine door applies the same rules to the first line of the agent's final message and uses that one line as both the commit message and the pull request title ([`runner/conventional_title.js`](runner/conventional_title.js)); it is handed no card key, so it drops none, and with nothing usable the title is `fix: apply the requested fix (<handoff id>)`. Both implementations are tested against one table of cases, [`tests/fixture/conventional_titles.json`](tests/fixture/conventional_titles.json), and SRE Agent runs a copy of the same table against its own implementation.

SRE Agent adopts the pull request by the marker line, which the CI door always writes. An SRE Agent release that writes the `Refs:` line into the tracking issue also reads it off a pull request whose marker was lost; an older one adopts by the marker alone and ignores the line. The marker line and the version stamp are untouched by any of this. A pull request opened by v1.3.0 or earlier is titled `ABC-12: ...`, and SRE Agent still adopts it.

## Run it on your own machine

`runner/runner.js` answers the same fix requests on a machine you own. It holds one outbound poll open against SRE Agent, takes a request off the queue, fetches the brief, runs `opencode run --agent sre-fix` in a checkout under this package's fences, runs the protected paths gate over what changed, pushes a branch, opens a draft pull request and reports the answer. It is a Node program (`runner.js`, with a small title normaliser, `conventional_title.js`, beside it) with nothing but the standard library behind it, because it is installed on somebody else's machine and a dependency there is a supply chain they did not ask for.

What it has that the CI door does not:

- **The access the machine has.** In CI the agent gets a checkout on a GitHub Actions runner. Here it also gets whatever the machine's own credentials reach: a cluster it holds a kubeconfig or a service account for, a cloud role, an internal endpoint. It reads the live system while it reasons about the change instead of inferring it from the source.
- **Requests that resolved no repository.** Those cannot go to a repository's CI, and SRE Agent's own agent declines them because it has nothing to check out. This runner answers one with a diagnosis, the evidence for it, and the repository the change probably belongs in. It changes nothing and opens nothing.
- **No tracking issue.** The CI door carries the brief on an issue everyone who can read the repository's issues can read. Here the brief is fetched over HTTPS with a token good for that one request, and nothing is written to the repository until a pull request.

Run one runner per organization, and expect it to answer one request at a time. The queue is not a lease: two runners sharing one key can both collect the same request and do the work twice.

### What SRE Agent stores about it

A name, an on switch, and the moment it last polled. No address, no credential, no model. The runner dials out and the platform never dials in, so there is nothing for us to store: no credential of yours reaches us, the poll key is one you create and can revoke, and the provider key and the model live on your machine, where the CI door keeps them in your repository's secrets.

### Register it

1. In SRE Agent, open Integrations, Fix runner, and register the machine under a name you will recognise in the logs.
2. Create an organization API key whose only scope is `fix_runner:poll`. It is not one of the default scopes, and a key holding it reaches the queue and nothing else. That key is `SRE_API_KEY` below.
3. Send work to it: set a repository's Fix runner to "Self-hosted runner" for requests that name that repository. Requests that name no repository go to the runner whenever it is live, with no per-repository setting.
4. Registration alone routes nothing. A runner counts as live while it has polled within the last five minutes, which its own polling keeps true.

### Install: the container image

```bash
docker run -d --name sre-agent-fix-runner \
  --restart unless-stopped \
  --env-file /etc/sre-agent-fix-runner.env \
  -v sre-agent-fix-runner-workspace:/workspace \
  ghcr.io/segfaultpw/sre-agent-opencode-runner:v1
```

The image is built for amd64 and arm64 and carries node, git, `gh`, opencode, kubectl, the AWS CLI and mise (so the agent can install language runtimes into its own home), plus this package's own VERSION, configuration, agent and scripts, root-owned and not writable by the account the agent runs as. `:v1` moves with every release of this major; pin `:v1.2.0` to freeze one.

The container starts as root, and only the container does: the runner needs it to start every agent run as a second account (`agent`, uid 10002) and to hand that account one checkout at a time. Everything else runs as `runner` (uid 10001): the git and `gh` calls, the scripts, and every file in `/workspace`. If you mount a host directory at `/workspace`, any owner works: the runner chowns the workspace to uid 10001 when it starts, so a volume that an earlier release filled as 10001 keeps working. Root needs six capabilities and no others (`SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER` and `KILL`), which is Docker's default set; if you drop capabilities, add those back. [Who runs what](#who-runs-what) says what each account can reach.

The env file is the variables from the table below, one `NAME=value` per line and no quotes, since Docker does not parse them. Give the container the read access you want the agent to have and nothing more: mount a read-only kubeconfig and make it readable by uid 10002, the agent's account, since a file only the runner can read is out of the agent's reach by design. AWS credentials in the env file stay the runner's, and reach the agent only with `SRE_AGENT_AWS_ACCESS=1`.

It refuses to start when a required value is missing, or when node, git, `gh` or opencode is not on PATH, and says which one. A runner that started anyway would look healthy and then fail on somebody's first fix request, with a card already waiting on it.

### Install: Kubernetes

Create the namespace and the secret first, from a file rather than from `--from-literal`, which would put the values in your shell history:

```bash
kubectl create namespace sre-agent
kubectl -n sre-agent create secret generic sre-agent-fix-runner --from-env-file=/path/to/env
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sre-agent-fix-runner
  namespace: sre-agent
---
# What the agent's kubectl can read in this cluster. The built-in view role
# excludes secrets. Bind a narrower role, or none, if this cluster is not what
# you want it reading.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sre-agent-fix-runner-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: ServiceAccount
    name: sre-agent-fix-runner
    namespace: sre-agent
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sre-agent-fix-runner
  namespace: sre-agent
spec:
  replicas: 1
  # Recreate, so a rollout never has two pods polling one queue.
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: sre-agent-fix-runner
  template:
    metadata:
      labels:
        app: sre-agent-fix-runner
    spec:
      serviceAccountName: sre-agent-fix-runner
      containers:
        - name: runner
          image: ghcr.io/segfaultpw/sre-agent-opencode-runner:v1
          env:
            - name: SRE_SERVER_URL
              value: https://app.example.com
            - name: SRE_MODEL
              value: openrouter/deepseek/deepseek-v4-pro
          envFrom:
            - secretRef:
                name: sre-agent-fix-runner
          # The image starts as root, in the container only, so that the runner can
          # start every agent run as its own unprivileged account. These six are
          # all it uses; the agent itself holds none of them.
          securityContext:
            runAsUser: 0
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
              add: ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL"]
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          emptyDir: {}
```

There is no `runAsNonRoot` and no `fsGroup` here, unlike an earlier release's example: the runner is root inside the container and sets the workspace's owner itself. An `emptyDir` workspace means a pod that moves re-clones; give it a PersistentVolumeClaim instead to keep the checkouts and the notes. In the cluster the agent's `kubectl` uses this pod's service account, whose token is mounted readable by every account in the container, so that binding, not the command denies, is what its cluster access actually is.

### Install: systemd

Install node 20 or newer, git, `gh` and opencode first, and put them on the system PATH rather than under a home directory: the unit sets `ProtectHome=yes`, so every home directory is empty to the service, and opencode's own installer writes to `~/.opencode/bin`.

```bash
curl -fsSL https://opencode.ai/install | bash
sudo install -m 0755 "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode
```

The installer refuses while any of the four is inside a home directory and prints the copy that moves it, rather than installing cleanly and leaving the unit to fail its first start. Then, from a clone of this package:

```bash
git clone https://github.com/segfaultpw/sre-agent-opencode
cd sre-agent-opencode
sudo bash runner/install-runner.sh
```

It checks every prerequisite before the first write and prints the command that closes each gap, then creates a system account, installs the package to `/opt/sre-agent-opencode` root-owned, installs the unit, and writes `/etc/sre-agent-fix-runner/env` as a template, mode 0600. It writes no credential: the values are yours to paste in. Run it again to upgrade: the new tree is assembled beside the old one and swapped into place, so a copy that fails leaves the working install untouched, and a runner that was already running is restarted onto what was just installed.

```bash
sudoedit /etc/sre-agent-fix-runner/env
sudo systemctl enable --now sre-agent-fix-runner
journalctl -u sre-agent-fix-runner -f
```

The unit runs as its own account, never as root, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and one writable path, the state directory, so a run cannot edit the fences the next run will load. It holds the six capabilities described above as ambient capabilities, with a bounding set of the same six, and starts every agent run through `setpriv` (from util-linux, which the installer requires) as a second account, `sre-agent-fix-agent`, whose home is `/var/lib/sre-agent-fix-runner/agent-home`; `setpriv` clears the capabilities in the agent, so the agent holds none. An install from an earlier release gets the second account, a state directory of mode 0711 instead of 0750, and the capabilities on the next run of `install-runner.sh`; the runner sets the modes inside the workspace when it starts. It restarts on failure and gives up after five failures inside five minutes, which leaves the unit in `failed` where somebody sees it rather than retrying a refused key for ever. It runs the same entrypoint the image runs, so both installs refuse to start for the same reasons and in the same words.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SRE_SERVER_URL` | yes | Where SRE Agent runs, for example `https://app.example.com`. The runner polls `/api/fix-runner/queue` there. |
| `SRE_API_KEY` | yes | The organization API key holding only `fix_runner:poll`. |
| `SRE_MODEL` | yes | `provider/model`, the same form the CI door's `model` input takes, for example `openrouter/deepseek/deepseek-v4-pro`. |
| the provider's own key | yes | Named for the provider, for example `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`; [`scripts/provider_env.sh`](scripts/provider_env.sh) maps a model prefix to the variable. opencode reads it directly. |
| `SRE_GITHUB_TOKEN` | for requests naming a repository | A token that may push a branch and open a pull request in the repositories this runner is asked to fix: contents and pull requests, write. Without one, such a request is reported back saying exactly that, and a request naming no repository is still answered. |
| `SRE_AGENT_GITHUB_TOKEN` | no | A token for the agent alone. When it is set, the agent's `GH_TOKEN`, and so its git credential helper for github.com, is this value and never `SRE_GITHUB_TOKEN`. Set it to a fine-grained token with Contents read-only on the repositories the agent needs to clone, and the agent can clone and read but cannot push. The runner still clones, fetches and pushes the branch, and opens the pull request, with its own `SRE_GITHUB_TOKEN`. When it is unset, the agent holds the runner's token, which can push, and only the command fence on `git push` stands between the agent and a push; that is the default, and a decision you can reverse by setting this variable. |
| `SRE_WORKSPACE` | no | Where the runner keeps its files. `/workspace` by default, which is the image's volume; the systemd unit points it at the state directory. Work trees live under `repos/<owner>/<repo>` and their git directories apart from them, under `gitdirs/<owner>/<repo>` (the agent is given the first, with a repository of its own made inside it for the length of a run, and never the second); the agent's notes are under `memory/` (see [What the agent remembers](#what-the-agent-remembers)), its home under `agent-home/` in the container, and untargeted runs use `scratch/`. A clone from the layout before `repos/` (`<owner>/<repo>` at the top) is moved there when the runner starts and is cloned again into the new layout on its next request, because nothing inside a `.git` that an earlier release's agent could write is trusted. |
| `SRE_AGENT_AWS_ACCESS` | no | Set to `1` to leave `AWS_*` and the ECS container credential variables in the agent's environment. Unset (the default), the agent has no AWS credentials: they are taken out of its environment, and it runs as an account that cannot read the runner's, so there is nowhere to read them from. The runner's own process keeps them either way. Only the exact value `1` opts in, and it gives the agent everything the role holds. |
| `SRE_MEMORY_BUCKET` | no | The name of an S3 bucket you own, to mirror the agent's memory to and restore it from; see [Mirroring the memory to your own bucket](#mirroring-the-memory-to-your-own-bucket). Empty or unset (the default) means no bucket, and the runner never calls the AWS CLI. A value that is not a valid bucket name (3 to 63 characters, lower case letters, digits, dots and hyphens, not a URL, an ARN or an IP address) stops the runner at start with a sentence naming the variable. The runner is the only process that holds it: the agent's environment does not. |
| `SRE_MEMORY_PREFIX` | no | Where in the bucket the memory goes, `memory/` by default. Relative to the bucket, no `..`, `.` or empty part, letters, digits, dots, underscores and hyphens in each part, at most 512 characters; a missing trailing slash is added. A bad value stops the runner at start. Ignored when `SRE_MEMORY_BUCKET` is unset. |
| `SRE_RUNNER_SETUP` | no | The path of an executable file in the container, run once as root by the entrypoint before the runner starts; see [Customizing the image](#customizing-the-image). |
| `SRE_RUNNER_USER`, `SRE_AGENT_USER` | no | The two accounts, resolved by the entrypoint into the numeric ids the runner is given. `runner` and `agent` in the image, `sre-agent-fix-agent` for the agent in the systemd unit. A start as root refuses when either account is missing, when both are one, or when either is root. A start that is not root and names no agent account runs the agent in the runner's own account and says so in the log. |
| `SRE_RUN_TIMEOUT_SECONDS` | no | How long one agent run may take, 1800 by default. At the bound the run is killed as a process group, since opencode starts a server of its own, and the request is reported with nothing published. |
| `SRE_LOG_LEVEL` | no | `debug`, `info` (the default), `warn` or `error`. |
| `SRE_ONCE` | no | Set to `1` to poll once, handle what came back, and exit, for a runner you would rather schedule than leave running. |

The runner removes surrounding whitespace, a trailing newline included, from `SRE_API_KEY`, `SRE_GITHUB_TOKEN`, `SRE_AGENT_GITHUB_TOKEN` and every provider key [`scripts/provider_env.sh`](scripts/provider_env.sh) `--all` lists, in its own environment before anything reads them, and logs which names it trimmed, never a value. A value that is only whitespace counts as unset. A value with a line break inside it is not a paste artefact, so the runner refuses to start with a sentence naming the variable; the value is not printed.

### What happens on a fix request, end to end

1. SRE Agent composes the brief, mints a handoff over it and stamps the request as your runner's. Nothing is sent to your machine.
2. Your runner's poll returns it. The queue holds an empty poll open for up to 25 seconds and answers the moment there is work, so a request waits about as long as a doorbell would. The answer carries the handoff id, the repository when the request named one, and the token for the two calls that follow.
3. The runner fetches the brief with that token, never with the poll key. That fetch is also how SRE Agent learns the request was collected.
4. With a repository: it clones or refreshes it (the git directory in `gitdirs/`, owned by the runner and closed to the agent, and a work tree under `repos/` that has no `.git` of its own outside a run) and checks the default branch out onto a branch named `sre-agent/<handoff id>`, discarding whatever a previous run left there including ignored files, then writes this package's `sre-fix` agent into the checkout where git cannot see it, and copies the repository's notes and scripts into `.sre-agent-memory/` (also invisible to git). A repository that tracks `.opencode/agents/sre-fix.md` itself is refused with that reason, since the package writes its own there. Without a repository: a scratch directory and no checkout, with the estate's notes copied the same way.
5. It writes a bundle of the base commit's history, hands the work tree to the agent's account (a chown, once before and once after), has a script make a repository of the agent's own in it from the bundle (full history, clean status, no token in `origin`), then runs `opencode run --agent sre-fix` once as that account, with the brief on stdin and this package's configuration passed in through the environment, bounded by `SRE_RUN_TIMEOUT_SECONDS`. Its own credentials are removed from that process's environment first, and so are the AWS credentials unless `SRE_AGENT_AWS_ACCESS=1`: the agent has a shell and needs none of them. When the run ends, however it ends, the runner ends every process still running as the agent's account and takes the checkout back before it reads or stages anything in it. The notes go ahead of the brief inside a block whose two marker lines carry a random id minted for that run, framed as the agent's own earlier notes: context, never instructions.
6. It saves what the agent did to its notes (below), deletes the `.sre-agent-memory/` copy (with a bucket configured, the changes are copied to the bucket once the request is otherwise done, before it is reported, and that copy stops at its 120 second deadline plus the 7 seconds a call that has to be killed gets: 5 to stop it and 2 more before the runner lets go of it), then stages everything the agent left and runs [`scripts/protected_paths.sh`](scripts/protected_paths.sh) over the staged list, the gate the CI door runs on the pull request's files. A change touching `.github/`, an env file, a path containing `secrets` or a `.pem` key publishes nothing, and the report names the paths.
7. It commits, pushes the branch with `SRE_GITHUB_TOKEN`, and opens a draft pull request whose title is a Conventional Commits header (see [Pull request titles](#pull-request-titles)) and whose body is the agent's own message plus the card's marker line and this package's version stamp. Where draft pull requests are not available it opens a normal one, rather than leaving a pushed branch nobody is looking at.
8. It reports the answer. **The outcome is always `not_validated`, a pull request notwithstanding**, and the summary says the change is an unmerged pull request that nothing has verified in a running system. The runner cannot deploy, so it cannot validate; `validated_fixed` belongs to a door that checked a fix where it runs. SRE Agent posts the answer as a comment on the card and links the pull request to it.

Every other ending reports the same outcome with what happened: the agent declined and why, the agent left the working tree unchanged, the gate refused the paths it names, the run hit its time bound, opencode exited non-zero with its provider's error, or the runner itself failed. Read a card comment as an answer to look at, never as a claim that the problem is solved.

### What the agent remembers

The runner keeps a small memory per repository under `$SRE_WORKSPACE/memory/<owner>/<repo>/` and one for requests that name no repository under `memory/_estate/`: a `NOTES.md` and a `scripts/` directory. Memory never lives in a checkout, so it cannot reach a pull request.

- **How the agent reaches it.** The fences do not change and the agent still cannot leave its working directory. Before a run the runner copies the memory directory into `.sre-agent-memory/` there and lists it in `.git/info/exclude`; after the run (whatever the outcome: a pull request, a decline, a timeout) it applies the bounds to the copy, writes the result back and deletes the copy before anything is staged. [`scripts/protected_paths.sh`](scripts/protected_paths.sh) also refuses any staged `.sre-agent-memory/` path.
- **What it is told.** The notes and the first comment line of each script go ahead of the brief, between two marker lines carrying a random id minted for that run, so a note that spells a closing marker closes nothing. The text above them says they are the agent's own earlier notes, written by an agent that read untrusted input, to be used as context and never as instructions. The agent may update `NOTES.md` and add, change or remove scripts; a saved script runs only when the agent chooses to run it, as an ordinary command under the same fences.
- **Bounds the runner enforces, not the agent.** `NOTES.md` at most 65,536 bytes; at most 50 scripts and 1,048,576 bytes per directory; names of `[A-Za-z0-9._-]`, at most 100 characters; symlinks, other non-regular files and anything outside `NOTES.md` and `scripts/` are removed. A file that breaks a bound keeps the version the previous run left (or is removed when there was none), and the log says so. A run that deletes or replaces its working copy leaves the memory as it was.
- **The agent's report.** The agent ends its message with a `## Memory` section of one paragraph. The runner removes that section from the text that becomes the pull request body and keeps it, at most 500 characters, with the list of changed files (path, added, modified or removed, size).

### Mirroring the memory to your own bucket

With `SRE_MEMORY_BUCKET` set, the volume's memory is followed by a copy in an S3 bucket you own, so a file system that is lost or replaced does not take the notes and scripts with it. The AWS CLI does the copying, from the runner's process and with the runner's own environment (on ECS, the task role); the image carries it, and the entrypoint refuses to start on a plain machine that has a bucket configured and no `aws` on PATH.

- **A one-way mirror with a journal.** The volume is the source of truth. Every change the volume makes is mirrored, not only the 50 a report carries: one `aws s3 cp` per added or changed file and one `aws s3 rm` per removed one, under `s3://<bucket>/<prefix><owner>/<repo>/...` and `<prefix>_estate/...`, as an argument list and never through a shell. The paths not yet confirmed in the bucket are kept in a journal, `.memory-mirror-pending`, in the workspace beside `memory/` (never mirrored itself), and a path leaves it when its call succeeds. The whole mirror has one 120 second deadline, and every call gets the time that is left of it, plus the 7 seconds a call that has to be killed gets (5 to stop it, 2 more before the runner lets go of it), so a request waits at most about two minutes for the bucket. A call that gets no answer has used all the time that was left, so it ends the mirror, and what is left waits in the journal for the next request, including a request that changes no memory. A journal that cannot be read (truncated by a host crash, damaged by something else) is logged and removed, and the whole volume is journaled again the same way as for a first sync, so the paths it held are not lost. A failing call is logged and the request is reported as usual: a bucket problem never fails a fix request. A file changed in the bucket directly is overwritten the next time the volume changes that file, and is read back only by a restore.
- **The first sync.** With a bucket configured and no `.memory-first-sync` marker on the volume for that bucket and prefix (an upgrade with memory already there, a bucket added later, or the bucket or the prefix changed), every file on the volume that passes the memory bounds is put into the journal once and uploaded under the same deadline; the marker, which records `s3://<bucket>/<prefix>`, is written when the journal empties. A marker that names another bucket or prefix, or none, counts as no marker. A file that breaks a bound (a `NOTES.md` over 65,536 bytes, the scripts after the first fifty by name, the largest files of a directory over 1,048,576 bytes) is not uploaded, because a restore would remove it again; the log names the first. The first sync only uploads; it never deletes anything in the bucket. A restore that succeeds writes the marker too, since the volume's contents then came from the bucket.
- **Restore onto an empty volume.** At start, before the first poll, and only when `<workspace>/memory` is missing or empty, the runner records a `.memory-restore-pending` marker and downloads the prefix into a staging directory beside `memory/` (`.memory-restore-<pid>`, owned by the runner), judges it there and moves it into place with one rename, so `memory/` never holds bytes that were not judged; a staging directory left by a runner that stopped part way is removed at the next start. The first poll can wait up to 10 minutes on that download. A volume that already holds memory and has no pending restore is never restored over.
- **A restore that fails is retried, and the bucket is left alone meanwhile.** The marker stays, and the restore is tried again before each request: at once, then 30 seconds later, then 60, doubling up to 10 minutes apart, each attempt bounded to 5 minutes (plus the 7 seconds a call that has to be killed gets). While a restore is pending, the mirror puts nothing into the bucket and deletes nothing from it, so the bucket's copy is not overwritten by a volume that never received it. A retry that succeeds moves in only the files the volume does not already have: the volume wins. That includes a note a request wrote while the restore was pending: once a retry succeeds, the volume's note replaces the bucket's note for the same path (the journal uploads it over the bucket's object), so keep bucket versioning on if the bucket's older copy may matter. When the AWS CLI exits with code 2 (a key it skipped, such as an archived object or a key with a `..` part), what did download is judged and kept, and the skip is logged.
- **What comes back is judged like what the agent leaves.** A restored tree is held to the same bounds as the agent's working copy before it reaches `memory/`: anything other than `NOTES.md` and `scripts/<name>` is removed; names are `[A-Za-z0-9._-]`, at most 100 characters; a symlink, a FIFO or any other non-regular file is removed (and a link is unlinked, never followed); `NOTES.md` is at most 65,536 bytes; a directory keeps at most 50 scripts and 1,048,576 bytes; the `.sre-agent-new-<pid>` and `.sre-agent-old-<pid>` leftovers of an interrupted save are removed. The owners under `memory/` are GitHub logins, so names such as `repos` or `scratch` there are ordinary owners. Restored files belong to the runner's account, directories are 0700 and files 0600 (a script that starts with `#!` is 0700). The AWS CLI itself refuses a key that would leave the destination. One limit: whoever can write the prefix can make a single restore download as much as its time limit allows into the staging directory before it is judged and removed, so keep the bucket writable only by the task role.
- **What the task role needs**, and nothing more: `s3:ListBucket` on the bucket, limited to the prefix with the condition `s3:prefix` `<prefix>*`, and `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/<prefix>*`. For a bucket encrypted with a customer-managed KMS key, also `kms:Decrypt` (the restore) and `kms:GenerateDataKey` (the mirror) on that key; without them every call is refused with AccessDenied. Turn on versioning for the bucket, so an overwrite or a delete is recoverable. The agent never holds these credentials unless you set `SRE_AGENT_AWS_ACCESS=1`, which gives it everything the role holds, the memory prefix included.
- **What is not in the bucket.** Nothing outside `memory/`: not the clones, the git directories, the agent's home, scratch, or the runner's three state files (`.memory-restore-pending`, `.memory-mirror-pending`, `.memory-first-sync`).

### When the runner is offline

- **A request that arrives while it is down** does not wait for it. Past five minutes without a poll the runner is not routable, and the request runs on SRE Agent's own agent instead, with the reason on the card. A repository set to "Self-hosted runner" behaves the same way.
- **A request collected by a runner that then dies** is failed by SRE Agent 45 minutes after it was queued, and the handoff is closed with it, so a runner that wakes up late cannot report into a request that already has an answer. Nothing reaches your default branch, and nothing is reported. A runner that died in the seconds between its push and the pull request can leave a branch named `sre-agent/<handoff id>` behind with no pull request on it, which is the one artefact of a dead run and is safe to delete.
- **A restart mid-poll** loses nothing: the next poll collects the same request.
- **A key the queue refuses** stops the runner instead of retrying: HTTP 401 or 403 exits with a message naming `SRE_API_KEY` and the scope it needs.
- **A runner you switch off** in SRE Agent is not that. The queue refuses it with a `runner_disabled` code, and the runner says so, says the key is not the problem, and polls once a minute until you switch it back on. Nothing restarts and nothing is lost.

### What it can reach, and what actually bounds it

The permission fences are this package's, and [What the agent may and may not do](#what-the-agent-may-and-may-not-do) describes them. Two things about them matter more here than in CI, because here the machine can reach live systems:

- **The boundary is the role you gave the machine, not the list of denied commands.** The command fences stop a careless step. They do not stop an interpreter: `sh -c`, `python -c`, or a script the agent writes and then runs is one command whose contents no pattern describes. The agent has a shell, so what that shell can reach is what the machine can reach. Give the runner a role of its own, read-only, holding what a diagnosis needs and nothing else.
- **Give it a machine of its own** if your CI or your workstation holds production credentials. A runner sharing a host with them shares them with the agent.

What holds regardless of anything the agent does in that shell:

- The runner does the git and the network work, so no fence had to be relaxed for this door. opencode's own tool gates hold absolutely: web fetch, web search and subagents are off, and the file tools cannot leave the checkout. The shell is where that ends: `git push`, `curl`, `wget`, `ssh` and `scp` are refused as commands, in every prefixed and wrapped form this package could name, and an interpreter is still an interpreter. Read the bullet above rather than this one for what bounds that.
- The protected paths gate judges what actually changed rather than which tool changed it, before anything is pushed.
- Nothing merges without a person. Your own review and CI stand between the pull request and the default branch. It is opened as a draft where your plan offers draft pull requests, and as an ordinary one where it does not, so treat the draft state as a convenience rather than as the control.
- The runner strips its poll key and its repository token out of the agent's environment, and the AWS credential variables unless `SRE_AGENT_AWS_ACCESS=1`, and the agent runs as a different account from the runner, so the scrub is not the only thing between the agent and those values: it cannot read the runner's process environment (`/proc/<pid>/environ` refuses another account), the runner's git and `gh` state, the memory directory or another repository's clone. Together that means the agent has no AWS credentials unless `SRE_AGENT_AWS_ACCESS=1`. It does hold a repository token, as `GH_TOKEN` (the runner's own, or the read-only one you give it in `SRE_AGENT_GITHUB_TOKEN`), because the repositories this runner fixes are private and the agent has to clone them as a CI job does; it never holds the poll key. The provider key stays in its environment too, because opencode needs it to call the model.

### Who runs what

| | account | holds |
| --- | --- | --- |
| the runner | `runner` (uid 10001) in the image, with root only to switch accounts; `sre-agent-fix-runner` on a host, never root | its environment (poll key, repository token, AWS credentials, the memory bucket), the memory mirror's `aws` calls, `/workspace` (mode 0711, so it can be walked through and not listed), `memory/` (0700), the work trees outside a run and every git directory (0700), every git and `gh` call |
| the agent | `agent` (uid 10002) in the image, `sre-agent-fix-agent` on a host | no capability, no supplementary group, a home of its own that lives on the volume (`/workspace/agent-home` in the image, `agent-home/` beside the workspace on a host; mode 0700, created by the runner), and the one work tree of the current run, owned by it for that run only |

**What the agent can do**, as a reduced but capable user, much as a CI job would:

- Work in a real git repository. Its work tree has the full history of the base branch in a `.git` that the agent owns, with `HEAD` and the index at the base and a clean `git status`, so `git log`, `blame`, `diff`, `bisect`, branches and local commits all work. `origin` is the github.com URL with no token in it. The runner makes it from a bundle of the base commit's history that it writes for the purpose; the repository shares no object store with the runner's own git directory (no alternates, no `--shared`), which the agent's account cannot read. Local commits, rewrites and branches are the agent's own: the pull request is the difference between the work tree and the real base, which the runner computes and commits from its own git directory. The agent's `.git` is deleted when the run ends. A subdirectory in which the agent ran `git init` is refused (git would record it as a pointer at history that is in no pull request), and the report says so.
- Clone other repositories, including private ones the token can read: `GH_TOKEN` is in its environment and its `~/.gitconfig` has a credential helper for github.com that answers with it (the token is never written to disk). The fences deny `git push` and `git remote`, and the pull request is opened by the runner.
- Install into its home: `npm -g` (prefix `~/.npm-global`), `pip --user`, `cargo`, `go install`, `gem`, `mix`/`hex`, and language runtimes through `mise` (data under `~/.local/share/mise`, shims on its PATH). Those directories are on its PATH, and because the home is on the volume they are still there on the next request, so the first run pays for an install and the later ones reuse it.
- Reach the network for package registries and `git clone` (nothing here narrows the network; put an egress rule on the container or the host if you want one).
- Start the application and run the tests in its work tree, which it can read and write, and write under `/tmp`.

**What the agent cannot do:** be root or use sudo (it holds no capability); install system packages (see [Customizing the image](#customizing-the-image)); push, since the fences deny it and the runner publishes (the fence is the only thing that stops it while `SRE_AGENT_GITHUB_TOKEN` is unset; set that variable to a read-only token and the token stops it as well); read the runner's environment (`/proc/<pid>/environ` refuses another account), the poll key, the handoff token or the AWS credentials (unless `SRE_AGENT_AWS_ACCESS=1`); read or write `memory/`, another repository's clone, or the runner's git directories, the current request's included; or make the runner's git run anything of its own. What git trusts in the runner's git directory (a `commondir`, alternates, grafts, a replace ref, `config.worktree`, attributes, a hook, a filter) the agent cannot write, and the runner removes every such file from that directory anyway; every runner git call names its own git directory and the work tree explicitly, so a hook, a filter or an fsmonitor the agent plants in its own `.git/config` or `.git/hooks` is never read by the runner's git calls, and they run with hooks, fsmonitor, system and global configuration, system attributes and replace objects switched off and with an environment that holds no credential but the call's own.

What else it can reach: every file on the machine or in the image that any account may read (the package under `/opt/sre-agent-opencode`, which it cannot write, `/etc`, system binaries, a kubeconfig or token file that is readable by all); the provider key and the other variables left in its environment; and, in a pod, the service account token.

The split is proved with real accounts by [`tests/uid_split_test.sh`](tests/uid_split_test.sh), which starts the runner once as root and once as an unprivileged account holding the six capabilities, and has a stub agent report what it can read and write.
- The poll key, the repository token and the handoff token are replaced with `[redacted]` in every line the runner writes: its own logs, the ones a failing `git` or `gh` prints, and the agent's own message where it becomes the report, the card comment and the pull request body. The runner logs into your aggregator, and a handoff token there would be live for 24 hours. Those three are the set: the provider key is passed through to opencode by the variable your provider names, and the runner never learns which one that is, so nothing can replace it if the agent prints it.

### Customizing the image

The image carries a base toolset for typical repositories: `build-essential` (a C toolchain and `make`), `git`, `curl`, `jq`, `unzip`, `xz-utils`, `python3` with `pip` and `venv`, `node`, the AWS CLI, `kubectl`, `gh` and `mise`. Three ways to add what a repository needs, in the order to try them:

1. **mise, in the agent's home, no root.** The agent installs language runtimes as itself (`mise use node@22`, `mise install python@3.12`, and so on), and `npm -g`, `pip --user`, `cargo`, `go install`, `gem` and `mix` all write under its home. The home is on the volume, so they stay for the next request. This needs nothing from you.
2. **A setup script, root, once at container start.** Set `SRE_RUNNER_SETUP` to the path of an executable file that is in the container (mount it, or bake it into a derived image). The entrypoint runs it once, as root, after the two accounts are resolved and before the runner starts (so before the first poll and before anything is handed to the agent), logs its output line by line, and refuses to start the runner if it exits non-zero, saying which script and what status. The runner never fetches a script; a URL is refused, and so is a relative path, a path on the workspace (or a link into it), a path under `/tmp`, `/var/tmp` or `/dev/shm` (or a link into them), and any path at all when `SRE_WORKSPACE` is `/`, because the agent can write all of those and the script runs as root at the next start. The script gets an allowlisted environment, not the container's: `PATH`, `HOME=/root`, the locale and time zone (`LANG`, `LC_ALL`, `TZ`, `TERM`), the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms) and any variable you name `SRE_SETUP_*`. It never sees `SRE_API_KEY`, either GitHub token, a model provider key or AWS credentials. It runs on every container start, not once per volume, so make it idempotent and quick (an `apt-get install` of a few packages is the intended use); for anything heavy, use a derived image. It is for the container only: a start that is not root refuses a script rather than running it as somebody else.
3. **A derived image.** `FROM ghcr.io/segfaultpw/sre-agent-opencode-runner:v1`, `RUN apt-get update && apt-get install ...` as root, and leave the `ENTRYPOINT` and `USER` alone. This is the way for system packages that are large or slow to install.

The agent has no sudo, and a sudo limited to `apt-get` would still be root, because package maintainer scripts run as root and root can read the runner's credentials. System packages therefore come from the setup script or a derived image, both of which are yours and run before the agent exists.

### Cost

Your machine's compute and the tokens your provider bills to your key. No GitHub Actions minutes are spent, and SRE Agent bills nothing for a run on your own machine.

### The opencode version in the image

The image pins opencode at 1.18.29 and checks the download against a sha256 for each architecture, because that binary is what enforces the permission fences, and the runner turns opencode's self-update off so it cannot move under a run. The CI door cannot pin it: the opencode action installs the current release at run time, as [Maintenance](#maintenance) says, so the two doors can be running different versions of opencode.

Moving the pin is a release of this package, recorded in the [CHANGELOG](CHANGELOG.md), so pulling a newer image is the whole upgrade. Building the image yourself with a different `--build-arg OPENCODE_VERSION` fails the checksum on purpose; change the version and both digests in [`runner/Dockerfile`](runner/Dockerfile) together. The systemd install pins nothing: opencode there is whatever you installed on PATH.

## What the agent may and may not do

The configuration in [`config/opencode.json`](config/opencode.json) is a set of opencode's own permission gates, and [`agents/sre-fix.md`](agents/sre-fix.md) is the agent's prompt. Both doors pass the same file the same way, so everything below holds on both.

Before opencode starts, both doors empty the checkout of everything opencode would load from your repository: the whole `.opencode/` directory, and `opencode.json` at the root. The package's own agent is written into the emptied tree afterwards, so what opencode finds there is what the door put there and nothing else.

The whole directory rather than a list of names, because a list is a guess about a loader nobody here controls, and it was wrong twice: `.opencode/plugin` is loaded and so is `.opencode/plugins`; `.opencode/agents` is read and so is `.opencode/agent`. What each of them is worth taking: opencode merges what the package passes in with your repository's own configuration rather than replacing it, and that merge keeps your key order while a permission resolves to the last rule that matches, so a tracked `opencode.json` naming the same keys can hold the package's denies at its own positions and let its catch-all win. A file under a plugin directory needs none of that, since opencode imports it and it runs before a gate is consulted at all. An agent definition of your own replaces this package's prompt along with every permission in it.

A tracked path is marked `skip-worktree` before it is removed, so no pull request carries the removal and nothing in your repository on GitHub changes. If your repository uses opencode itself, its configuration is untouched everywhere except inside this one run's checkout.

- The edit gate refuses writes under `.github/` and to any path matching `*.env*`, `*secrets*` or `*.pem`, and the read gate refuses env files. Both apply to opencode's file tools.
- The bash gate refuses `git push`, `git remote`, `curl`, `wget`, `ssh`, `scp`, `sudo`, `gh`, and `rm` with a recursive or forcing flag however it is spelled, each written so that an environment prefix (`HTTPS_PROXY=... curl`), a wrapper (`env curl`), an absolute path (`/usr/bin/curl`) and a flag between the binary and the verb (`git -C /tmp/r push`) do not walk past it. `gh` is on that list because in CI the job's token is in the agent's environment, where `gh pr merge` would go around the `git push` refusal and the diff gate at once; on your own machine the runner deletes `GH_TOKEN` and `GITHUB_TOKEN` from the environment it starts the agent in, and the refusal is the second line rather than the first. It is written as one pattern per way of invoking it, quoted forms included, plus `gh api` and `gh pr` wherever they appear, so that ordinary commands carrying those two letters (`grep gh file`, a commit message about gh) are not refused with them. opencode parses the command line and applies the patterns to each command in it, denying the call when any one of them is denied, so a refused command does not get through by being chained after an allowed one either. What a pattern sees is that command as written, arguments included.
- The bash gate also refuses the mutating cloud and cluster commands: the `kubectl` write verbs (`delete`, `apply`, `create`, `replace`, `edit`, `patch`, `scale`, `exec`, `cordon`, `drain`, `label`, `annotate`, `expose`, `run`, `debug`, `taint`, `cp`, `attach`, `port-forward`, `proxy`, `certificate approve`, `rollout restart`, `undo`, `pause`, `resume`, and `set` by subcommand); `helm upgrade`, `install`, `uninstall` and `rollback`; `terraform apply`, `destroy`, `import`, and `state rm`, `mv`, `push` and `replace-provider`; the AWS CLI's 37 mutating verb families, written as `*aws *<verb>-*` so a service the CLI adds later needs no new rule; the writing `aws s3` verbs; `aws configure set`, `aws ssm start-session` and `aws ecs execute-command`; and the mutating calls whose verb carries no hyphen, such as `lambda invoke`, `sns publish` and `cloudformation deploy`. Each is written so that flags before the verb (`kubectl -n prod delete pod x`) and an environment prefix (`AWS_PROFILE=prod aws ...`) do not walk past it.
- Keeping the reads open took care, because a pattern sees a command's arguments too: a verb written as a bare substring took `kubectl get volumeattachments`, `kubectl logs deploy/kube-proxy` and `terraform state list` with it. So the mutating subcommand is named wherever a family also holds reads, and `kubectl get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `auth can-i`, `version` and `cluster-info`, and `terraform plan`, `show`, `output`, `validate`, `state list`, `state show` and `state pull`, are allowed again after the deny block. So are four AWS reads whose data has no other read path: `aws logs start-query` and `stop-query`, and `aws cloudtrail start-query` and `cancel-query`. Each of those re-allows is anchored at its verb, because a command that carries a substitution is judged by its whole text: a re-allow with a wildcard in front of the verb can be reached from inside one, as in `kubectl delete pod $(kubectl get pod -o name)`, and would then win over the deny. The cost is that the same read behind an inline credential prefix, `AWS_PROFILE=x aws logs start-query` or a `KUBECONFIG=x` in front of `kubectl`, stays denied. On a runner the credentials come from the process environment or the machine's own role, so the bare form is what gets typed; the inline prefix is a workstation habit. Still refused: a read whose own verb is a mutating word, such as `aws logs start-live-tail`, and a read whose arguments carry one, such as a `--filter-pattern` containing `delete-object`. Over-denial is the safe direction for a deny rule, and the agent says what it could not run.
- **This list is a speed bump, not a boundary, and an interpreter walks around it**: `sh -c`, `python -c`, or a script the agent writes and then runs is a single command whose contents no pattern here describes. The reason to have the list is that it stops a careless step. The reason it is not the control is that the agent has a shell. The boundary is the role you granted the machine the agent runs on, so give that machine a read-only role.
- Web fetch, web search, subagents and questions are off, the file tools cannot leave the checkout, and repeating the same tool call in a loop is refused. Session sharing is disabled, so the transcript is not uploaded to opencode's site.
- The agent never commits, pushes or opens a pull request itself: the opencode action does that once, after the agent finishes, from the working tree, and on your own machine the runner does. It never merges and never touches the default branch.

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
- The workflow pins the opencode action at a release tag, `anomalyco/opencode/github@v1.18.29` today, and a bump of that pin is recorded in the [CHANGELOG](CHANGELOG.md). The pin fixes the wrapper action only, not the opencode binary: the action's first step reads the latest opencode release and its install step runs `curl https://opencode.ai/install | bash`, so the binary that enforces the fences is whatever is latest on the day the run happens. The install script accepts a version, but the action does not expose it and puts its own bin directory first on PATH, so this package cannot pin the binary from outside. The runner image does pin it, because there the install is this package's own.
- The runner image is published to `ghcr.io/segfaultpw/sre-agent-opencode-runner` on every release, as one manifest covering amd64 and arm64, with `vX.Y.Z` frozen and `v1` moving. It is built on every push as well, without being pushed, so a Dockerfile is never first exercised at release time.
- For whoever publishes this package: GHCR creates a package **private** on its first push. The first release's image has to be made public by hand, in the package's settings on GitHub, before anyone can pull it.

## Security

The brief on the tracking issue comes from alerts, investigations and cards, so it can carry text an attacker wrote, and the agent reads it as data. The gates in this package's configuration raise the cost of a careless or injected step: no web tools, no subagents, no file-tool writes to workflows, env files, secrets or keys, and the listed shell commands refused as written. They are opencode's tool gates, not a sandbox: the agent has a shell on your runner, where the provider key and the job's token exist in the environment. The controls that hold regardless are the diff gate (a pull request that touched a protected path is closed and the job fails), the draft pull request, SRE Agent's review, and your own CI on the pull request. In token mode (`use_github_token: true`) the pull request is opened with `GITHUB_TOKEN`, and by GitHub's rule it starts none of your other workflows, so that last line of defence is gone in that mode; the review and the draft remain. For a repository whose CI holds production secrets, run the workflow on a dedicated runner or in a dedicated environment. The issue is readable by everyone who can read the repository's issues, and it holds the same brief an operator sees on the card. Enable the runner per repository, as an administrator, and know who can start a run: the example workflow's fix job accepts a comment from a repository owner, member or collaborator, and any `workflow_dispatch` of the workflow, which anyone with write access can fire from the Actions tab with any issue number they like. That is the same trust the comment door already places in a collaborator, which is why it is drawn there. The relay job answers a comment only from the login in `SRE_AGENT_BOT_LOGIN`, and its `actions: write` is not a narrow scope: a token holding it can start any `workflow_dispatch` workflow in the repository and cancel or re-run runs. What bounds the relay is that its one step is fixed, not the scope of its token. The provider key is a secret of your repository; SRE Agent never holds it and never runs opencode.

## Inputs and secrets

The reusable workflow is `segfaultpw/sre-agent-opencode/.github/workflows/fix.yml`.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | required | `provider/model`, for example `openrouter/deepseek/deepseek-v4-pro` or `anthropic/claude-sonnet-4-5`. The provider prefix chooses which variable receives `provider_key`. |
| `prompt` | string | `""` | An instruction that replaces the comment. Leave it empty for the comment door: the action reads the comment and the issue itself. |
| `issue_number` | string | `""` | The tracking issue the run answers. The relay job sets it, because a `workflow_dispatch` payload carries no issue; leave it empty on the comment door, where the event carries the issue. |
| `comment_id` | string | `""` | The comment the relay answered, so the run can react to it. Empty on the comment door, where the action reacts itself. |
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

The relay job's `permissions` block is `actions: write` and nothing else, which is what firing a `workflow_dispatch` needs. It is the smallest permission that starts a run, not a small permission: it also starts any other `workflow_dispatch` workflow in the repository and cancels or re-runs runs, so what keeps the relay to one thing is the single fixed step in it. The fix job's is fixed at `id-token`, `contents`, `pull-requests` and `issues`, because GitHub does not evaluate expressions in `permissions`. App mode uses `id-token` for the OIDC exchange and `pull-requests` for the diff gate and the marking step; token mode uses `contents`, `pull-requests` and `issues` for the push, the pull request and the comments.

Provider prefixes the workflow maps: `anthropic`, `openai`, `google`, `openrouter`, `xai`, `groq`, `mistral`, `deepseek`, `togetherai`, `fireworks-ai`, `cerebras`, `moonshotai`, `deepinfra`, `huggingface`, `zai`, `minimax`, `nvidia`, `opencode`, `vercel`. The variable names come from [models.dev](https://models.dev), the registry opencode reads providers from. A model with another prefix fails the run with a clear message before opencode starts.

## License

MIT, see [LICENSE](LICENSE).
