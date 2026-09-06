# sre-agent-opencode

A fix request from [SRE Agent](https://sreagent.app) becomes a `/opencode` comment on a tracking issue in your repository. The reusable workflow in this package runs [opencode](https://opencode.ai) on your own GitHub Actions runner with a full checkout, so the agent can build and test before it proposes anything, and the run ends in one draft pull request that SRE Agent links to the card and reviews. Your code and your provider key stay on your runner: SRE Agent never runs opencode and never holds the key.

The same agent, under the same fences, also runs on a machine you own, where it has whatever access you granted that machine and can answer requests that name no repository. See [Run it on your own machine](#run-it-on-your-own-machine).

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

## Run it on your own machine

`runner/runner.js` answers the same fix requests on a machine you own. It holds one outbound poll open against SRE Agent, takes a request off the queue, fetches the brief, runs `opencode run --agent sre-fix` in a checkout under this package's fences, runs the protected paths gate over what changed, pushes a branch, opens a draft pull request and reports the answer. It is a single Node program with nothing but the standard library behind it, because it is installed on somebody else's machine and a dependency there is a supply chain they did not ask for.

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

The image is built for amd64 and arm64 and carries node, git, `gh`, opencode, kubectl and the AWS CLI, plus this package's own VERSION, configuration, agent and scripts, root-owned and not writable by the account the agent runs as. `:v1` moves with every release of this major; pin `:v1.2.0` to freeze one. The container runs as uid 10001 and needs `/workspace` writable by it, which is where checkouts live between restarts.

The env file is the variables from the table below, one `NAME=value` per line and no quotes, since Docker does not parse them. Give the container the read access you want the agent to have and nothing more: mount a read-only kubeconfig, or pass the environment of a role that can only read.

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
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        # The workspace volume is chowned to this group, which is what makes it
        # writable by the account in the image.
        fsGroup: 10001
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
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          emptyDir: {}
```

An `emptyDir` workspace means a pod that moves re-clones; give it a PersistentVolumeClaim instead to keep the checkouts. In the cluster the agent's `kubectl` uses this pod's service account, so that binding, not the command denies, is what its cluster access actually is.

### Install: systemd

Install node 20 or newer, git, `gh` and opencode first. Then, from a clone of this package:

```bash
git clone https://github.com/segfaultpw/sre-agent-opencode
cd sre-agent-opencode
sudo bash runner/install-runner.sh
```

It checks every prerequisite before the first write and prints the command that closes each gap, then creates a system account, copies the package to `/opt/sre-agent-opencode` root-owned, installs the unit, and writes `/etc/sre-agent-fix-runner/env` as a template, mode 0600. It writes no credential: the values are yours to paste in.

```bash
sudoedit /etc/sre-agent-fix-runner/env
sudo systemctl enable --now sre-agent-fix-runner
journalctl -u sre-agent-fix-runner -f
```

The unit runs as its own account with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and one writable path, the state directory, so a run cannot edit the fences the next run will load. It restarts on failure and gives up after five failures inside five minutes, which leaves the unit in `failed` where somebody sees it rather than retrying a refused key for ever. It runs the same entrypoint the image runs, so both installs refuse to start for the same reasons and in the same words.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SRE_SERVER_URL` | yes | Where SRE Agent runs, for example `https://app.example.com`. The runner polls `/api/fix-runner/queue` there. |
| `SRE_API_KEY` | yes | The organization API key holding only `fix_runner:poll`. |
| `SRE_MODEL` | yes | `provider/model`, the same form the CI door's `model` input takes, for example `openrouter/deepseek/deepseek-v4-pro`. |
| the provider's own key | yes | Named for the provider, for example `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`; [`scripts/provider_env.sh`](scripts/provider_env.sh) maps a model prefix to the variable. opencode reads it directly. |
| `SRE_GITHUB_TOKEN` | for requests naming a repository | A token that may push a branch and open a pull request in the repositories this runner is asked to fix: contents and pull requests, write. Without one, such a request is reported back saying exactly that, and a request naming no repository is still answered. |
| `SRE_WORKSPACE` | no | Where checkouts go. `/workspace` by default, which is the image's volume; the systemd unit points it at the state directory. |
| `SRE_RUN_TIMEOUT_SECONDS` | no | How long one agent run may take, 1800 by default. At the bound the run is killed as a process group, since opencode starts a server of its own, and the request is reported with nothing published. |
| `SRE_LOG_LEVEL` | no | `debug`, `info` (the default), `warn` or `error`. |
| `SRE_ONCE` | no | Set to `1` to poll once, handle what came back, and exit, for a runner you would rather schedule than leave running. |

### What happens on a fix request, end to end

1. SRE Agent composes the brief, mints a handoff over it and stamps the request as your runner's. Nothing is sent to your machine.
2. Your runner's poll returns it. The queue holds an empty poll open for up to 25 seconds and answers the moment there is work, so a request waits about as long as a doorbell would. The answer carries the handoff id, the repository when the request named one, and the token for the two calls that follow.
3. The runner fetches the brief with that token, never with the poll key. That fetch is also how SRE Agent learns the request was collected.
4. With a repository: it clones or refreshes it under the workspace and checks the default branch out onto a branch named `sre-agent/<handoff id>`, discarding whatever a previous run left there, then writes this package's `sre-fix` agent into the checkout where git cannot see it. A repository that tracks `.opencode/agents/sre-fix.md` itself is refused with that reason, since the package writes its own there. Without a repository: a scratch directory and no checkout.
5. It runs `opencode run --agent sre-fix` once, with the brief on stdin and this package's configuration passed in through the environment, bounded by `SRE_RUN_TIMEOUT_SECONDS`. Its own credentials are removed from that process's environment first: the agent has a shell and needs none of them.
6. It stages everything the agent left and runs [`scripts/protected_paths.sh`](scripts/protected_paths.sh) over the staged list, the gate the CI door runs on the pull request's files. A change touching `.github/`, an env file, a path containing `secrets` or a `.pem` key publishes nothing, and the report names the paths.
7. It commits, pushes the branch with `SRE_GITHUB_TOKEN`, and opens a draft pull request whose body is the agent's own message plus the card's marker line and this package's version stamp. Where draft pull requests are not available it opens a normal one, rather than leaving a pushed branch nobody is looking at.
8. It reports the answer. **The outcome is always `not_validated`, a pull request notwithstanding**, and the summary says the change is an unmerged draft that nothing has verified in a running system. The runner cannot deploy, so it cannot validate; `validated_fixed` belongs to a door that checked a fix where it runs. SRE Agent posts the answer as a comment on the card and links the pull request to it.

Every other ending reports the same outcome with what happened: the agent declined and why, the agent left the working tree unchanged, the gate refused the paths it names, the run hit its time bound, opencode exited non-zero with its provider's error, or the runner itself failed. Read a card comment as an answer to look at, never as a claim that the problem is solved.

### When the runner is offline

- **A request that arrives while it is down** does not wait for it. Past five minutes without a poll the runner is not routable, and the request runs on SRE Agent's own agent instead, with the reason on the card. A repository set to "Self-hosted runner" behaves the same way.
- **A request collected by a runner that then dies** is failed by SRE Agent 45 minutes after it was queued, and the handoff is closed with it, so a runner that wakes up late cannot report into a request that already has an answer. Nothing was pushed, because the push is the last step.
- **A restart mid-poll** loses nothing: the next poll collects the same request.
- **A key the queue refuses** stops the runner instead of retrying: HTTP 401 or 403 exits with a message naming `SRE_API_KEY` and the scope it needs.

### What it can reach, and what actually bounds it

The permission fences are this package's, and [What the agent may and may not do](#what-the-agent-may-and-may-not-do) describes them. Two things about them matter more here than in CI, because here the machine can reach live systems:

- **The boundary is the role you gave the machine, not the list of denied commands.** The command fences stop a careless step. They do not stop an interpreter: `sh -c`, `python -c`, or a script the agent writes and then runs is one command whose contents no pattern describes. The agent has a shell, so what that shell can reach is what the machine can reach. Give the runner a role of its own, read-only, holding what a diagnosis needs and nothing else.
- **Give it a machine of its own** if your CI or your workstation holds production credentials. A runner sharing a host with them shares them with the agent.

What holds regardless of anything the agent does in that shell:

- The runner is the only thing on the machine that touches git or the network. The agent cannot push, fetch a URL, search the web, spawn a subagent or work outside the checkout, which is why none of those denies had to be relaxed for this door.
- The protected paths gate judges what actually changed rather than which tool changed it, before anything is pushed.
- Nothing merges without a person. The pull request is a draft, and your own review and CI stand between it and the default branch.
- The runner strips its poll key and its repository token out of the agent's environment. The provider key stays, because opencode needs it to call the model.
- The poll key, the repository token and the handoff token are redacted from every log line and every report, including the ones a failing `git` or `gh` prints itself. The runner logs into your aggregator, and a handoff token there would be live for 24 hours.

### Cost

Your machine's compute and the tokens your provider bills to your key. No GitHub Actions minutes are spent, and SRE Agent bills nothing for a run on your own machine.

### The opencode version in the image

The image pins opencode at 1.18.29 and checks the download against a sha256 for each architecture, because that binary is what enforces the permission fences, and the runner turns opencode's self-update off so it cannot move under a run. The CI door cannot pin it: the opencode action installs the current release at run time, as [Maintenance](#maintenance) says, so the two doors can be running different versions of opencode.

Moving the pin is a release of this package, recorded in the [CHANGELOG](CHANGELOG.md), so pulling a newer image is the whole upgrade. Building the image yourself with a different `--build-arg OPENCODE_VERSION` fails the checksum on purpose; change the version and both digests in [`runner/Dockerfile`](runner/Dockerfile) together. The systemd install pins nothing: opencode there is whatever you installed on PATH.

## What the agent may and may not do

The configuration in [`config/opencode.json`](config/opencode.json) is a set of opencode's own permission gates, and [`agents/sre-fix.md`](agents/sre-fix.md) is the agent's prompt. The workflow passes the configuration to opencode after any configuration in your repository, so a repository can add to it but cannot loosen it. A runner on your own machine passes the same file the same way, so everything below holds on both doors.

- The edit gate refuses writes under `.github/` and to any path matching `*.env*`, `*secrets*` or `*.pem`, and the read gate refuses env files. Both apply to opencode's file tools.
- The bash gate refuses `git push`, `git remote`, `curl`, `wget`, `ssh`, `scp`, `rm -rf` and `sudo`. opencode parses the command line and applies the patterns to each command in it, denying the call when any one of them is denied, so a refused command does not get through by being chained after an allowed one. What a pattern sees is that command as written, arguments included.
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
- The workflow pins the opencode action at a release tag, and a bump of that pin is recorded in the [CHANGELOG](CHANGELOG.md). The pin covers the action only, not the opencode binary: the action's first step reads the latest opencode release and its install step runs opencode's install script, so the binary that enforces the gates is whatever is current. The install script accepts a version, but the action does not expose it and puts its own bin directory first on PATH, so this package cannot pin the binary from outside. The runner image does pin it, because there the install is this package's own.
- The runner image is published to `ghcr.io/segfaultpw/sre-agent-opencode-runner` on every release, as one manifest covering amd64 and arm64, with `vX.Y.Z` frozen and `v1` moving. It is built on every push as well, without being pushed, so a Dockerfile is never first exercised at release time.
- For whoever publishes this package: GHCR creates a package **private** on its first push. The first release's image has to be made public by hand, in the package's settings on GitHub, before anyone can pull it.

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
