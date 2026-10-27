# sre-agent-opencode

A fix request from [SRE Agent](https://sreagent.app) runs on a runner you deploy on your own machine: this package's [opencode](https://opencode.ai) agent, under this package's fences, in a checkout it makes itself, ending in one draft pull request that SRE Agent links to the card and reviews. Deploy the runner with this package's Terraform module, its container image, or systemd; everything below describes it. Your code and your provider key stay on your machine: SRE Agent never runs opencode and never holds the key.

## Choosing a model

The default runs on OpenRouter, which fronts many vendors behind one key and bills per token. The prices are per million tokens, prompt and completion, as OpenRouter lists them today; all four models support tool calling, which the agent needs to read and edit files.

| Model | Prompt | Completion | Pick it for |
| --- | --- | --- | --- |
| `openrouter/deepseek/deepseek-v4-pro` | $0.80 | $1.60 | A repository with a real build and test suite. The documented default. |
| `openrouter/z-ai/glm-5` | $0.60 | $1.92 | The same tier from another vendor. |
| `openrouter/deepseek/deepseek-v4-flash` | $0.083 | $0.166 | Trying the runner on a small repository. |
| `openrouter/z-ai/glm-5.3-flash` | $0.075 | $0.25 | The same, from another vendor. |

Any provider in the mapping works: change `SRE_MODEL` and set the provider's own key variable, for example `anthropic/claude-sonnet-4-5` with `ANTHROPIC_API_KEY`. Provider prefixes the runner maps: `anthropic`, `openai`, `google`, `openrouter`, `xai`, `groq`, `mistral`, `deepseek`, `togetherai`, `fireworks-ai`, `cerebras`, `moonshotai`, `deepinfra`, `huggingface`, `zai`, `minimax`, `nvidia`, `opencode`, `vercel`. The variable names come from [models.dev](https://models.dev), the registry opencode reads providers from. A model with another prefix refuses the start with a clear message before opencode runs.

### Pull request titles

A repository that checks its pull request titles, or reads commit types for its releases, refuses `ABC-12: widen the timeout`. From v1.4.0 the pull requests this package opens follow [Conventional Commits](https://www.conventionalcommits.org), by the same rules SRE Agent applies to the pull requests its own agent opens:

- Leading `[tags]` are dropped, and so is the key of the card the request came from (`ABC-12:` or `ABC-12 `), in any order. No other key is touched: `SHA-256: verify the checksum`, `GPT-4 support` and another card's `OPS-7: widen` keep their subjects.
- A title that already is `type(scope)!: subject`, with one of `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style` or `revert`, is kept, the type in lower case. A header with no subject, or with a subject made only of combining marks (the combining diacritical blocks, the variation selectors and the zero width joiner), takes `apply the requested fix`.
- Anything else becomes `fix: <text>`, from the first line that is not blank.
- The result is one line of at most 256 characters (GitHub's limit), never cut inside a character and its marks or inside a joined emoji by the runner; a scope that would leave fewer than ten characters for the subject is dropped, not cut in half.
- Whitespace is a space or a tab, a line break is LF, CR, VT, FF, U+0085, U+2028 or U+2029, and U+FEFF is removed, so the rules do not depend on how a language defines Unicode whitespace.

The runner applies this ([`runner/conventional_title.js`](runner/conventional_title.js)) to the job's `title` key when the platform sends one (the platform derives it from the request's own summary, so it never depends on how the model ends its answer) and uses that one line as both the commit message and the pull request title. A job with no `title`, a `null` or blank one, or one that is not a string falls back to the first line of the agent's final message, as before v1.9.0; the title is never read from the brief. The runner is handed no card key, so it drops none, and with nothing usable the title is `fix: apply the requested fix (<handoff id>)`. The module is tested against one table of cases, [`tests/fixture/conventional_titles.json`](tests/fixture/conventional_titles.json), and SRE Agent runs a copy of the same table against its own implementation.

SRE Agent adopts the pull request by the marker line, which this runner always writes into the body. The marker line and the version stamp are untouched by any of this.

## Run it on your own machine

`runner/runner.js` answers fix requests on a machine you own. It holds one outbound poll open against SRE Agent, takes a request off the queue, fetches the brief, runs `opencode run --agent sre-fix` in a checkout under this package's fences, runs the protected paths gate over what changed, pushes a branch, opens a draft pull request and reports the answer. It is a Node program (`runner.js`, with the title normaliser `conventional_title.js`, the workspace and memory rules in `memory.js` and the bucket mirror in `bucket.js` beside it) with nothing but the standard library behind it, because it is installed on somebody else's machine and a dependency there is a supply chain they did not ask for.

What the machine gives the agent:

- **The access the machine has.** The agent gets a checkout, and whatever the machine itself lets a process on it reach: a cluster whose kubeconfig or service account token any account can read, an internal endpoint, and a cloud role the machine provides through its metadata service (see [What it can reach, and what actually bounds it](#what-it-can-reach-and-what-actually-bounds-it)). The runner's own AWS variables are not among them unless `SRE_AGENT_AWS_ACCESS=1`. It reads the live system while it reasons about the change instead of inferring it from the source.
- **Requests that resolved no repository.** SRE Agent's own agent declines those because it has nothing to check out. This runner answers one with a diagnosis, the evidence for it, and the repository the change probably belongs in. It changes nothing and opens nothing.
- **No tracking issue.** The brief is fetched over HTTPS with a token good for that one request, and nothing is written to the repository until a pull request.

Run one runner per organization, and expect it to answer one request at a time. The queue is not a lease: two runners sharing one key can both collect the same request and do the work twice.

### What SRE Agent stores about it

A name, an on switch, and the moment it last polled. No address, no credential, no model. The runner dials out and the platform never dials in, so there is nothing for us to store: no credential of yours reaches us, the poll key is one you create and can revoke, and the provider key and the model live on your machine. What a report adds to that, the list of what a run changed in its memory and the steps of a test job, is in [What is audited where](#what-is-audited-where); the notes themselves never leave your volume and your bucket.

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

The container starts as root, and only the container does: the runner needs it to start every agent run as a second account (`agent`, uid 10002) and to hand that account one checkout at a time. Everything else runs as `runner` (uid 10001): the git and `gh` calls, the scripts, and every file in `/workspace`. If you mount a host directory at `/workspace`, any owner works: the runner chowns the workspace to uid 10001 when it starts, so a volume that an earlier release filled as 10001 keeps working. Root needs six capabilities and no others (`SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER` and `KILL`), all of which are in Docker's default set (which holds fourteen); if you drop capabilities, add those back. A start that cannot make the split is handled by who it starts as. A start that is **not root** and lacks one of those six (the manifest of an earlier release: `runAsUser: 10001`, every capability dropped) does not crash: the runner runs the agent as its own account, as releases before v1.5.0 did, and says so in a `warn` line at start that names the missing capabilities and in the `agent_isolation` entry of every report's evidence; in that mode taking secrets out of the agent's environment is not a boundary, because the agent can read the runner's process environment and write the memory directory, so give the container the six capabilities to get the split back. A start that **is root** and lacks any of the six (`--cap-drop ALL` as root, a securityContext with `runAsUser: 0` that drops them without adding them back) never falls back, because the one account there is root: the runner refuses to start, naming the missing capabilities and saying that the agent would run as root, and polls nothing. [Who runs what](#who-runs-what) says what each account can reach.

The env file is the variables from the table below, one `NAME=value` per line and no quotes, since Docker does not parse them. Give the container the read access you want the agent to have and nothing more: mount a read-only kubeconfig and make it readable by uid 10002, the agent's account, since a file only the runner can read is out of the agent's reach by design. AWS credentials in the env file are the runner's; whether the agent sees them too is `SRE_AGENT_AWS_ACCESS`, in the table below.

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
          persistentVolumeClaim:
            claimName: sre-agent-fix-runner-workspace
---
# The runner's clones, the agent's installs and the notes all live here (see
# What persists across requests). Size it for your repositories.
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sre-agent-fix-runner-workspace
  namespace: sre-agent
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
```

There is no `runAsNonRoot` and no `fsGroup` here, unlike an earlier release's example: the runner is root inside the container and sets the workspace's owner itself. The earlier example (`runAsNonRoot: true`, `runAsUser: 10001`, `fsGroup: 10001`, every capability dropped) still starts on `:v1`: it cannot switch accounts, so the runner falls back to one account, says so in its log and in every report's `agent_isolation` evidence, and works as v1.4.0 did. Replace the `securityContext` with the one above to get the split. The workspace is a PersistentVolumeClaim, so a pod that moves keeps its clones, the agent's installs and its notes. With an `emptyDir` instead, each new pod starts empty: it clones again and the notes are gone, unless `SRE_MEMORY_BUCKET` restores them ([Mirroring the memory to your own bucket](#mirroring-the-memory-to-your-own-bucket)). In the cluster the agent's `kubectl` uses this pod's service account, whose token is mounted readable by every account in the container, so that binding, not the command denies, is what its cluster access actually is.

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

The unit runs as its own account, never as root, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and one writable path, the state directory, so a run cannot edit the fences the next run will load. It holds the six capabilities described above as ambient capabilities, with a bounding set of the same six, and starts every agent run through `setpriv` (from util-linux, which the installer requires) as a second account, `sre-agent-fix-agent`, whose homes are under `/var/lib/sre-agent-fix-runner/agent-home` (one per repository, beside the workspace and not inside it); `setpriv` clears the capabilities in the agent, so the agent holds none. The runner's own `git`, `gh` and `aws` calls run with `HOME` set to `/var/lib/sre-agent-fix-runner/runner-home`, a directory of its own (mode 0700) that the runner makes, and never the account's old home directory, which an earlier release's agent could write. An install from an earlier release gets the second account, a state directory of mode 0711 instead of 0750, and the capabilities on the next run of `install-runner.sh`; the runner sets the modes inside the workspace when it starts. It restarts on failure and gives up after five failures inside five minutes, which leaves the unit in `failed` where somebody sees it rather than retrying a refused key for ever. It runs the same entrypoint the image runs, so both installs refuse to start for the same reasons and in the same words.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SRE_SERVER_URL` | yes | Where SRE Agent runs, for example `https://app.example.com`. The runner polls `/api/fix-runner/queue` there. |
| `SRE_API_KEY` | yes | The organization API key holding only `fix_runner:poll`. |
| `SRE_MODEL` | yes | `provider/model`, for example `openrouter/deepseek/deepseek-v4-pro`. |
| the provider's own key | yes | Named for the provider, for example `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`; [`scripts/provider_env.sh`](scripts/provider_env.sh) maps a model prefix to the variable. opencode reads it directly. |
| `SRE_GITHUB_TOKEN` | with a repository, one auth mode | A token that may push a branch and open a pull request in the repositories this runner is asked to fix: contents and pull requests, write. Without any GitHub credential, such a request is reported back saying exactly that, and a request naming no repository is still answered. Exactly one mode is allowed: this variable alone, or the two `SRE_GITHUB_APP_*` variables together, never both. |
| `SRE_GITHUB_APP_ID`, `SRE_GITHUB_APP_PRIVATE_KEY` | with a repository, one auth mode | A GitHub App in place of a static token: the App's numeric id and its PEM private key. The runner signs a JWT with the key, finds the installation that serves the request's repository owner and mints an installation token for its own clone, fetch and push (kept until five minutes before it expires, then minted again), and a second token for the agent alone, minted once per run with `contents: read` on the request's repository only (or the first installation's, for a request that names none), so the agent can clone and read but never push. The App is never handed both credentials of another mode: setting `SRE_GITHUB_TOKEN` or `SRE_AGENT_GITHUB_TOKEN` beside these refuses the start. The key is trimmed of surrounding whitespace only (a PEM has line breaks of its own), signs locally and never reaches a header, a command line, a log or the agent's environment. One installation per runner is the documented shape; with several, the request's repository owner picks the one it needs. In App mode `SRE_RUN_TIMEOUT_SECONDS` is capped at 3300, because the agent's token is minted once and lives an hour. |
| `SRE_AGENT_GITHUB_TOKEN` | no (token mode only) | A token for the agent alone. When it is set, the agent's `GH_TOKEN`, and so its git credential helper for github.com, is this value and never `SRE_GITHUB_TOKEN`. Set it to a fine-grained token with Contents read-only on the repositories the agent needs to clone, and the agent can clone and read but cannot push. The runner still clones, fetches and pushes the branch, and opens the pull request, with its own `SRE_GITHUB_TOKEN`. When it is unset, the agent holds the runner's token, which can push, and only the command fence on `git push` stands between the agent and a push; that is the default, and a decision you can reverse by setting this variable. In App mode there is nothing to configure (the agent's token is minted read-only per run) and a start with this variable set refuses. |
| `SRE_WORKSPACE` | no | Where the runner keeps its files. `/workspace` by default, which is the image's volume; the systemd unit points it at the state directory. What lives under it is in [What persists across requests](#what-persists-across-requests). |
| `SRE_WORKSPACE_PER_INSTANCE` | no | Set to `1` when several runners share one volume as a pool: each then works under `<SRE_WORKSPACE>/instances/<its instance id>` (its clones, git directories, agent homes, context clone and scratch), while the agent's memory stays one shared tree and the runner takes the per-repository and state locks described in [Running several runners on one volume](#running-several-runners-on-one-volume). Any other value, and an unset one, keeps today's one-runner layout byte for byte. Only the exact value `1` splits the workspace. |
| `SRE_RUNNER_INSTANCE` | no | The runner's instance id: what it tells the platform it is (the poll carries it as `instance`) and the name of its own directory under `instances/` in a pool. Your chosen name when you set it; otherwise the machine's hostname; `default` when neither is a name the runner can use. Letters, digits, dots, underscores and hyphens, at most 100 characters, and not dots alone. Give every runner in a pool a name of its own if the hostnames do not already differ. |
| `SRE_MEMORY_ROOT` | no | With the workspace split on, where the shared memory tree lives: an absolute path of its own, `<SRE_WORKSPACE>/memory` by default. The bucket mirror's three state files and its restore staging sit beside it, so they follow the tree. Not read with the split off, and refused when it names the workspace itself. |
| `SRE_LOCK_WAIT_SECONDS` | no | How long a runner in a pool waits for a repository's lock while another instance works on the same repository, 60 seconds by default, polling once a second. After the bound the request is answered honestly: the report says another runner instance is working on that repository, nothing is published, nothing is staged, and the memory is left as the other instance is writing it. Zero answers at once. Only read with the workspace split on. |
| `SRE_AGENT_AWS_ACCESS` | no | Set to `1` to leave `AWS_*` and the ECS container credential variables in the agent's environment. Unset (the default), the runner's own AWS variables are taken out of the agent's environment, and it runs as an account that cannot read the runner's process, so there is nowhere to read them from there. That is not the same as the agent having no AWS access: a role the machine provides itself (an instance profile reached through the instance metadata service, an ECS task role on EC2, an EKS pod with IRSA or Pod Identity) is reachable by any account on it unless the network or the node blocks it, see [What it can reach, and what actually bounds it](#what-it-can-reach-and-what-actually-bounds-it). The runner's own process keeps its variables either way. Only the exact value `1` opts in, and it gives the agent everything the role holds. |
| `SRE_MEMORY_BUCKET` | no | The name of an S3 bucket you own, to mirror the agent's memory to and restore it from; see [Mirroring the memory to your own bucket](#mirroring-the-memory-to-your-own-bucket). Empty or unset (the default) means no bucket, and the runner never calls the AWS CLI. A value that is not a valid bucket name (3 to 63 characters, lower case letters, digits, dots and hyphens, not a URL, an ARN or an IP address) stops the runner at start with a sentence naming the variable. The runner is the only process that holds it: the agent's environment does not. |
| `SRE_MEMORY_PREFIX` | no | Where in the bucket the memory goes, `memory/` by default. Relative to the bucket, no `..`, `.` or empty part, letters, digits, dots, underscores and hyphens in each part, at most 512 characters; a missing trailing slash is added. A bad value stops the runner at start. Ignored when `SRE_MEMORY_BUCKET` is unset. |
| `SRE_RUNNER_SETUP` | no | The path of an executable file in the container, run once as root by the entrypoint before the runner starts; see [Customizing the image](#customizing-the-image). |
| `SRE_RUNNER_USER`, `SRE_AGENT_USER` | no | The two accounts, resolved by the entrypoint into the numeric ids the runner is given. `runner` and `agent` in the image, `sre-agent-fix-agent` for the agent in the systemd unit. A start as root refuses when either account is missing, when both are one, or when either is root. A start that is not root and names no agent account runs the agent in the runner's own account and says so in the log, and so does a start that is not root, names the accounts and lacks one of the six capabilities: the log line names what is missing and the report's evidence carries it as `agent_isolation`. A start that is root and lacks one refuses to start instead, since its one account would be root. |
| `SRE_RUN_TIMEOUT_SECONDS` | no | How long one agent run may take, 1800 by default. At the bound the run is killed as a process group, since opencode starts a server of its own, and the request is reported with nothing published. |
| `SRE_LOG_LEVEL` | no | `debug`, `info` (the default), `warn` or `error`. |
| `SRE_OPENCODE_LOG_LEVEL` | no | The level opencode's own logging runs at, passed to the process the runner starts as `OPENCODE_LOG_LEVEL` (for example `debug`, when you want the server log's detail). Unset (the default) leaves opencode at its own default level, and the variable never reaches the agent as the runner's own. See [What is audited where](#what-is-audited-where) for the lines the runner forwards. |
| `SRE_ONCE` | no | Set to `1` to poll once, handle what came back, and exit, for a runner you would rather schedule than leave running. |

The runner removes surrounding whitespace, a trailing newline included, from `SRE_API_KEY`, `SRE_GITHUB_TOKEN`, `SRE_AGENT_GITHUB_TOKEN`, `SRE_GITHUB_APP_ID`, `SRE_GITHUB_APP_PRIVATE_KEY` and every provider key [`scripts/provider_env.sh`](scripts/provider_env.sh) `--all` lists, in its own environment before anything reads them, and logs which names it trimmed, never a value. A value that is only whitespace counts as unset. A value with a line break inside it is not a paste artefact, so the runner refuses to start with a sentence naming the variable; the value is not printed. `SRE_GITHUB_APP_PRIVATE_KEY` is the one exception, because a PEM is many lines by design: it is trimmed of surrounding whitespace alone and never refused for its line breaks, and a key that cannot sign the App's JWT refuses the start with a sentence that prints none of it.

### What happens on a fix request, end to end

1. SRE Agent composes the brief, mints a handoff over it and stamps the request as your runner's. Nothing is sent to your machine.
2. Your runner's poll returns it. The queue holds an empty poll open for up to 25 seconds and answers the moment there is work, so a request waits about as long as a doorbell would. The answer carries the handoff id, the repository when the request named one, and the token for the two calls that follow.
3. The runner fetches the brief with that token, never with the poll key. That fetch is also how SRE Agent learns the request was collected.
4. With a repository: it clones or refreshes it (the git directory in `gitdirs/`, owned by the runner and closed to the agent, and a work tree under `repos/` that has no `.git` of its own outside a run) and checks the default branch out onto a branch named `sre-agent/<handoff id>`, discarding whatever a previous run left there including ignored files, then writes this package's `sre-fix` agent into the checkout where git cannot see it, and copies the repository's notes and scripts into `.sre-agent-memory/` (also invisible to git). The repository's own `.opencode/` directory and root `opencode.json` are removed from the checkout first (a tracked `.opencode/agents/sre-fix.md` is replaced by the package's own, not refused; [What the agent may and may not do](#what-the-agent-may-and-may-not-do) says why), and a repository that tracks `.sre-agent-memory/` is refused with that reason. Without a repository: a scratch directory and no checkout, with the estate's notes copied the same way.
5. It writes a bundle of the base commit's history, hands the work tree and the agent's home for this repository to the agent's account (a chown, once before and once after; the home is emptied first of everything opencode would load by itself, see [What persists across requests](#what-persists-across-requests)), has a script make a repository of the agent's own in it from the bundle (full history, clean status, no token in `origin`), then runs `opencode run --agent sre-fix` once as that account, with the brief on stdin and this package's configuration passed in through the environment, bounded by `SRE_RUN_TIMEOUT_SECONDS`. The runner's own secrets are removed from that process's environment first, and so are the AWS variables unless `SRE_AGENT_AWS_ACCESS=1`: the agent has a shell and needs none of them. When the run ends, however it ends, the runner ends every process still running as the agent's account and takes the home and the checkout back before it reads or stages anything in them. A process that outlives every attempt to end it is logged and named in the report, and nothing is published for that request. The notes go ahead of the brief inside a block whose two marker lines carry a random id minted for that run, framed as the agent's own earlier notes: context, never instructions.
6. It saves what the agent did to its notes (below), deletes the `.sre-agent-memory/` copy (with a bucket configured, the changes are copied to the bucket once the request is otherwise done, before it is reported, and that copy stops at its 120 second deadline plus the 7 seconds a call that has to be killed gets: 5 to stop it and 2 more before the runner lets go of it), then stages everything the agent left and runs [`scripts/protected_paths.sh`](scripts/protected_paths.sh) over the staged list, the gate that judges what changed before anything is published. A change touching `.github/`, an env file, a path containing `secrets` or a `.pem` key publishes nothing, and the report names the paths.
7. It commits, pushes the branch with the runner's GitHub credential (`SRE_GITHUB_TOKEN`, or the installation token minted from the App for that repository's owner; either way it reaches every `git` call that talks to GitHub through that process's environment and a credential helper for github.com alone, never on a command line, where another account could read it; `gh` gets it as `GH_TOKEN`), and opens a draft pull request whose title is a Conventional Commits header (see [Pull request titles](#pull-request-titles)) and whose body is the agent's own message plus the card's marker line and this package's version stamp. The body is written to a temporary directory and file that belong to the runner's account (0700 and 0600), because `gh` runs as that account and could not open them if a root runner had made them, and the directory is removed when `gh` returns. Where draft pull requests are not available it opens a normal one, rather than leaving a pushed branch nobody is looking at.
8. It reports the answer. **The outcome is always `not_validated`, a pull request notwithstanding**, and the summary says the change is an unmerged pull request that nothing has verified in a running system. The runner cannot deploy, so it cannot validate; `validated_fixed` belongs to a door that checked a fix where it runs. SRE Agent posts the answer as a comment on the card and links the pull request to it.

Every other ending reports the same outcome with what happened: the agent declined and why, the agent left the working tree unchanged, the gate refused the paths it names, the run hit its time bound, opencode exited non-zero with its provider's error, or the runner itself failed. Read a card comment as an answer to look at, never as a claim that the problem is solved.

### What persists across requests

`SRE_WORKSPACE` is meant to be a volume, and the runner owns what is in it:

```
repos/<owner>/<repo>/     work trees, reused between requests
gitdirs/<owner>/<repo>/   the runner's own git directories, apart from the work trees and closed to the agent
memory/<owner>/<repo>/    the agent's NOTES.md and scripts/ for that repository
memory/_estate/           the same, for requests that name no repository
scratch/                  requests that name no repository; emptied at the start of each one
context/<owner>/<repo>/   the GitHub integration's context repository, cloned beside the checkout as
                          read-only reference material for the agent; never staged, never pushed
.memory-restore-pending, .memory-mirror-pending, .memory-first-sync
                          the bucket mirror's three small state files (see below)
instances/<id>/           with SRE_WORKSPACE_PER_INSTANCE=1, this instance's own repos/, gitdirs/,
                          agent-home/, context/ and scratch/ (see below)
locks/                    the pool's leases on the shared memory tree (see below)

agent-home/<owner>/<repo>/  the agent's home for that repository: the tools it installed and their caches
agent-home/_estate/         the same, for requests that name no repository
runner-home/                the HOME of the runner's own git, gh and aws calls (0700, the runner's alone)
```

The last three live beside the workspace on a host and inside it in the image: in the image `agent-home/` is `/workspace/agent-home` (the agent account's home directory, so it is on the volume) and `runner-home/` is `/home/runner/runner-home`; under systemd they are `/var/lib/sre-agent-fix-runner/agent-home` and `/var/lib/sre-agent-fix-runner/runner-home`, next to `/var/lib/sre-agent-fix-runner/workspace`. With the workspace split on, `agent-home/` moves under `instances/<id>/agent-home` and the account's own home directory is left unused.

The agent's home is per repository, so nothing a run leaves in it reaches another repository's runs. The tools it installs there stay for later runs about the same repository, as a CI cache does. The directories above the homes belong to the runner (mode 0711: the agent walks through to its own home and cannot list the others), and a home belongs to the agent only for the length of its own run: before and after, it is the runner's and mode 0700, so the agent's account cannot enter the home of a repository whose run is not under way, whoever owns the files in it. Before every run the runner removes from the home it hands over everything opencode loads by itself: `.config/opencode` and `.opencode` (configuration, plugins, agent definitions, instructions), `.claude` and `.claude.json`, `.agents` (external skills), and opencode's own data, state and cache directories (`.local/share/opencode`, `.local/state/opencode`, `.cache/opencode`: the data directory holds `auth.json`, whose "wellknown" entries would make opencode fetch and merge a remote configuration), and sets `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` and `OPENCODE_PURE` to `1` and `OPENCODE_AUTH_CONTENT` to `{}` (no stored credential is read; the provider key comes from the environment) for the run, with opencode's configuration, data, cache and state directories under that home. A plugin a hostile run planted there would otherwise run before any gate is consulted in every later run; [`tests/dry_run_test.sh`](tests/dry_run_test.sh) shows with the pinned opencode that a planted plugin, agent definition, skill and stored credential do not load after this. Tool directories (the rest of `.local`, `.npm-global`, `.cargo`, `go`, mise's data) run only when the agent invokes them, so they stay. A shared `agent-home/` from a pre-release build is left alone and unused.

The first request for a repository pays for the clone and for whatever the agent installs; the later ones reuse both. Each request refreshes the work tree from GitHub and puts the default branch out on `sre-agent/<handoff id>`, discarding what a previous run left there, ignored files included. A restart of the container or the unit loses nothing. A replacement that does not keep the volume (an `emptyDir`, a new task without a file system of its own) starts empty: it clones again, and the notes are gone unless a bucket restores them. Which account can reach which of these is in [Who runs what](#who-runs-what).

A workspace from a release before v1.5.0 keeps working. Its clones (`<owner>/<repo>` at the top) are moved under `repos/` when the runner starts, and each repository is cloned again once, on its next request, into the new layout, because nothing inside a `.git` that an earlier release's agent could write is trusted.

### Running several runners on one volume

A pool of runners answers requests while one is busy with a long checkout or a big run. Mount the same volume into every runner, give each the same `SRE_SERVER_URL` and `SRE_API_KEY`, and set `SRE_WORKSPACE_PER_INSTANCE=1` on each. What changes:

- **Each runner works in its own directories.** Its clones, git directories, agent homes, context clone and scratch live under `<SRE_WORKSPACE>/instances/<its instance id>`, so two runners never write the same checkout. The instance id is `SRE_RUNNER_INSTANCE` when you set it, else the hostname (give each runner a name of its own when the hostnames do not differ). Each runner names its instance in every poll, so the platform can always tell which runner is working on what.
- **The memory stays one shared tree.** `memory/` (or `SRE_MEMORY_ROOT`, when you point it elsewhere on the same volume or another one the runners share) is written by every runner, and the bucket mirror's three state files sit beside it, so one bucket and one mirror state serve the pool. An instance whose memory lives somewhere no other runner can write is a pool in name only.
- **The locks.** Before a request touches a repository's memory, the runner takes `locks/<owner>/<repo>.lock` (or `locks/_estate.lock` for a request naming no repository) and holds it until the memory is saved and the agent's home is back in its hands, so two runners never write the same notes at once. The locks live beside the memory root, so they follow `SRE_MEMORY_ROOT` wherever it points and two workspaces sharing one memory tree still coordinate. The bucket mirror's restore, first sync and every journal and marker write take `locks/_state.lock`, so two runners never interleave them; no mirror upload runs under it, and the one aws call that does is the restore's own download, held once so two restores never land in the same staging directory. A lock names the instance, the process and the moment; one silent past the stale bound is assumed gone and replaced, and a runner takes its own lock back at once after a crash. The bound is 45 minutes, or above `SRE_RUN_TIMEOUT_SECONDS` plus ten minutes when you raise that, so a slow but live run never has its lock read stale. A lock file is a plain file the runners write and read carefully: a link, an empty half-written file or anything else in its place is treated as stale and replaced, never followed; a file this account cannot read is waited for, not replaced.
- **A busy repository is answered honestly.** When another instance holds a repository's lock longer than `SRE_LOCK_WAIT_SECONDS` (60 by default), the request is not run: the report says that `owner/repo` is being worked on by another runner instance, nothing is published, nothing is staged, and the memory is left as the other instance is writing it. The report is the request's answer; ask again once the other instance has finished, and the next request for that repository runs then.

A single runner is unaffected: unset, or any value other than `1`, keeps the one-runner layout above, with no lock files and no `instances/` directory.

### What the agent remembers

The runner keeps a small memory per repository under `$SRE_WORKSPACE/memory/<owner>/<repo>/` and one for requests that name no repository under `memory/_estate/`: a `NOTES.md` and a `scripts/` directory. Memory never lives in a checkout, so it cannot reach a pull request.

- **How the agent reaches it.** The fences do not change and the agent still cannot leave its working directory. Before a run the runner copies the memory directory into `.sre-agent-memory/` there and lists it in `.git/info/exclude`; after the run (whatever the outcome: a pull request, a decline, a timeout) it applies the bounds to the copy, writes the result back and deletes the copy before anything is staged. [`scripts/protected_paths.sh`](scripts/protected_paths.sh) also refuses any staged `.sre-agent-memory/` path.
- **What it is told.** The notes and the first comment line of each script go ahead of the brief, between two marker lines carrying a random id minted for that run, so a note that spells a closing marker closes nothing. The text above them says they are the agent's own earlier notes, written by an agent that read untrusted input, to be used as context and never as instructions. The agent may update `NOTES.md` and add, change or remove scripts; a saved script runs only when the agent chooses to run it, as an ordinary command under the same fences.
- **Bounds the runner enforces, not the agent.** `NOTES.md` at most 65,536 bytes; at most 50 scripts and 1,048,576 bytes per directory; names of `[A-Za-z0-9._-]`, at most 100 characters; symlinks, other non-regular files and anything outside `NOTES.md` and `scripts/` are removed. A file that breaks a bound keeps the version the previous run left (or is removed when there was none), and the log says so. A run that deletes or replaces its working copy leaves the memory as it was.
- **The agent's report.** The agent ends its message with a `## Memory` section of one paragraph. The runner removes that section from the text that becomes the pull request body and keeps it, at most 500 characters, with the list of changed files (path relative to `memory/`, added, modified or removed, size; a removed file's last size). The report to SRE Agent carries them as a `memory` object: `changes` (at most 50 entries), `summary` (at most 500 characters) and `bucket` (the name of the bucket the changes are mirrored to, or `null`). A run that changed nothing sends no `memory` key.

### Mirroring the memory to your own bucket

With `SRE_MEMORY_BUCKET` set, the volume's memory is followed by a copy in an S3 bucket you own, so a file system that is lost or replaced does not take the notes and scripts with it. The AWS CLI does the copying, from the runner's process and with the runner's own environment (on ECS, the task role); the image carries it, and the entrypoint refuses to start on a plain machine that has a bucket configured and no `aws` on PATH.

- **A one-way mirror with a journal.** The volume is the source of truth. Every change the volume makes is mirrored, not only the 50 a report carries: one `aws s3 cp` per added or changed file and one `aws s3 rm` per removed one, under `s3://<bucket>/<prefix><owner>/<repo>/...` and `<prefix>_estate/...`, as an argument list and never through a shell. The paths not yet confirmed in the bucket are kept in a journal, `.memory-mirror-pending`, in the workspace beside `memory/` (never mirrored itself), and a path leaves it when its call succeeds. The whole mirror has one 120 second deadline, and every call gets the time that is left of it, plus the 7 seconds a call that has to be killed gets (5 to stop it, 2 more before the runner lets go of it), so a request waits at most about two minutes for the bucket. A call that gets no answer has used all the time that was left, so it ends the mirror, and what is left waits in the journal for the next request, including a request that changes no memory. A journal that cannot be read (truncated by a host crash, damaged by something else) is logged and removed, and the whole volume is journaled again the same way as for a first sync, so the paths it held are not lost. A failing call is logged and the request is reported as usual: a bucket problem never fails a fix request. A file changed in the bucket directly is overwritten the next time the volume changes that file, and is read back only by a restore.
- **The first sync.** With a bucket configured and no `.memory-first-sync` marker on the volume for that bucket and prefix (an upgrade with memory already there, a bucket added later, or the bucket or the prefix changed), every file on the volume that passes the memory bounds is put into the journal once and uploaded under the same deadline; the marker, which records `s3://<bucket>/<prefix>`, is written when the journal empties. A marker that names another bucket or prefix, or none, counts as no marker. A file that breaks a bound ([What the agent remembers](#what-the-agent-remembers)) is not uploaded, because a restore would remove it again; the log names the first. The first sync only uploads; it never deletes anything in the bucket. A restore that succeeds writes the marker too, since the volume's contents then came from the bucket.
- **Restore onto an empty volume.** At start, before the first poll, and only when `<workspace>/memory` is missing or empty, the runner records a `.memory-restore-pending` marker and downloads the prefix into a staging directory beside `memory/` (`.memory-restore-<pid>`, owned by the runner), judges it there and moves it into place with one rename, so `memory/` never holds bytes that were not judged; a staging directory left by a runner that stopped part way is removed at the next start. The first poll can wait up to 10 minutes on that download. A volume that already holds memory and has no pending restore is never restored over.
- **A restore that fails is retried, and the bucket is left alone meanwhile.** The marker stays, and the restore is tried again before each request: at once, then 30 seconds later, then 60, doubling up to 10 minutes apart, each attempt bounded to 5 minutes (plus the 7 seconds a call that has to be killed gets). While a restore is pending, the mirror puts nothing into the bucket and deletes nothing from it, so the bucket's copy is not overwritten by a volume that never received it. A retry that succeeds moves in only the files the volume does not already have: the volume wins. That includes a note a request wrote while the restore was pending: once a retry succeeds, the volume's note replaces the bucket's note for the same path (the journal uploads it over the bucket's object), so keep bucket versioning on if the bucket's older copy may matter. When the AWS CLI exits with code 2 (a key it skipped, such as an archived object or a key with a `..` part), what did download is judged and kept, and the skip is logged.
- **What comes back is judged like what the agent leaves.** A restored tree is held to the same bounds as the agent's working copy before it reaches `memory/`, and to a few more that only a download needs: a symlink, a FIFO or any other non-regular file is removed (a link is unlinked, never followed); the `.sre-agent-new-<pid>` and `.sre-agent-old-<pid>` leftovers of an interrupted save are removed; the owners under `memory/` are GitHub logins, so names such as `repos` or `scratch` there are ordinary owners; restored files belong to the runner's account, directories are 0700 and files 0600 (a script that starts with `#!` is 0700). The AWS CLI itself refuses a key that would leave the destination. One limit: whoever can write the prefix can make a single restore download as much as its time limit allows into the staging directory before it is judged and removed, so keep the bucket writable only by the task role.
- **What the task role needs**, and nothing more: `s3:ListBucket` on the bucket, limited to the prefix with the condition `s3:prefix` `<prefix>*`, and `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/<prefix>*`. For a bucket encrypted with a customer-managed KMS key, also `kms:Decrypt` (the restore) and `kms:GenerateDataKey` (the mirror) on that key; without them every call is refused with AccessDenied. Turn on versioning for the bucket, so an overwrite or a delete is recoverable. The agent never holds these credentials unless you set `SRE_AGENT_AWS_ACCESS=1`, which gives it everything the role holds, the memory prefix included.
- **What is not in the bucket.** Nothing outside `memory/`: not the clones, the git directories, the agent's home, scratch, or the runner's three state files (`.memory-restore-pending`, `.memory-mirror-pending`, `.memory-first-sync`).

### The test job

"Run a test job" on the runner's card in SRE Agent (or the matching MCP tool) queues a job through the same queue with `"test": true`. The runner runs no fix, opens no pull request and pushes nothing; it reports `not_validated`, one sentence, and seven steps in this order, so you can see that the whole path works from this machine:

1. `collected`: the job was taken off the queue and its brief fetched with the handoff token.
2. `cloned`: the first repository set to the self-hosted runner (the job's `test_repo_full_name`) is cloned or refreshed with the runner's GitHub credential, on a branch of its own that is never pushed. With no repository set, a scratch directory is used and the step is ok, saying no repository is set to the self-hosted runner.
3. `model`: one line is asked of the model through `opencode run --agent sre-fix`, as the agent's account, with a fixed prompt, the same scrubbed environment as a fix and a limit of two minutes (or `SRE_RUN_TIMEOUT_SECONDS` when that is shorter). The step carries the model's line.
4. `memory`: `.runner-test` is written to the repository's memory directory (the estate's when no repository is set) and removed again, and any directory the test had to create goes with it. A runner stopped between the two leaves the file behind, and the next start removes it before the memory is restored, journaled or shown to the agent.
5. `bucket`: with `SRE_MEMORY_BUCKET` set, `.runner-test` is put under the memory prefix, at `<owner>/<repo>/.runner-test` (`_estate/.runner-test` when no repository is set), and removed again, with the same AWS CLI and environment a fix's mirror uses. The step is judged on those two calls and on nothing else, each given one minute (plus the 7 seconds a call that has to be killed gets): the journal of paths earlier requests left to upload, and the mirror's deadline over it, play no part, and that backlog is carried to the bucket after the report is sent. The marker sits outside `NOTES.md` and `scripts/`, so it can never be taken for memory. A marker that was put and could not be removed fails the step and says so, and the next test job removes it; a restore that has not succeeded fails the step and says so. With no bucket: ok, "no bucket configured".
6. `pull_request`: a pull request body is written exactly as a fix writes it (a directory and file of the runner's account, 0700 and 0600) and read back by a process of the runner's account, the account `gh` runs as. The step proves the last step of a fix can open its body file; nothing is pushed and no pull request is opened.
7. `reported`: always ok, because the report arriving is its proof.

A step that fails is reported with its sentence (at most 300 characters), and every step after it, `reported` apart, is sent as not run. The platform shows the failing step and its sentence on the card. A runner older than v1.5.0 reads the job as an ordinary request without a repository and answers it with a diagnosis, and the card says the runner needs updating.

### Reports and older platforms

The report keeps every key it always had and adds two optional ones: `memory`, when a run changed its memory, and `test`, for a test job. A platform reads the keys it knows by name, so one older than the release that reads these two ignores them: the outcome, the summary and the pull request link arrive as ever, and the card shows no memory list and no steps. A test job is queued by the platform's button, so a platform without the button never sends one. The report's free-form `evidence` object gains two entries when they apply, which SRE Agent shows with the rest of the evidence on the card (each entry is cut at 1,000 bytes there): `agent_isolation`, a sentence saying that the account split was off for this start and which capabilities it lacked, and `agent_processes_survived`, `true` when a process of the agent's account could not be ended after the run (nothing is published for that request).

### What is audited where

- **In SRE Agent**, least detail. Each report that changed the memory lists, for the Control Tower's request drawer (the **Runner memory** section) and the card's report comment (under **Memory**), the path relative to `memory/`, whether it was added, modified or removed, its size in bytes, the agent's own summary of at most 500 characters and the bucket's name, at most 50 changes, shown as plain text. A test job shows each of its seven steps with its sentence, and the request to run one is written to the organization's audit log. The contents of a note or a script are never sent.
- **In your bucket.** The notes and scripts themselves: `aws s3 ls s3://<bucket>/<prefix> --recursive` lists them and `aws s3api list-object-versions` shows every earlier version of one, which is why the bucket should be versioned. Who read or wrote an object is whatever CloudTrail data events or S3 server access logs on that bucket record, if you turned them on.
- **On your volume.** Plain files under `memory/`, readable by the runner's account and root and by nobody else.
- **In the runner's log.** Every poll, request and refusal, which bound cut which file, every failing mirror or restore call and each first sync, with the poll key, the repository token and the handoff token replaced by `[redacted]`.
- **opencode's own log, forwarded.** Each run's opencode is started with `OPENCODE_PRINT_LOGS=1`, so the binary writes its structured server log (one `timestamp=... level=... run=... message=...` line per event) on the process's stderr, and when the process ends, however it ended, the runner forwards the tail of those lines from the captured stderr to its own output: filter the runner's log group on `opencode:` and the lines are there. Every forwarded line goes through the same redaction as every other line the runner writes, applied to the whole line before the line is cut, and the bounds hold a chatty level: at most the last 200 lines, each cut at 2,000 characters, a line that is not valid UTF-8 or holds a NUL byte dropped whole and counted in one line. A failed run, a killed run and a failed test-job model step name how many lines were forwarded in the report's evidence (`opencode_log_lines`). `SRE_OPENCODE_LOG_LEVEL` raises the detail the binary logs at.
- **In your repositories.** A change to a repository reaches it only as a pull request, which your review and CI stand in front of. Memory never does: it lives outside every checkout, and the protected paths gate refuses any staged `.sre-agent-memory/` path.

### When the runner is offline

- **A request that arrives while it is down** does not wait for it. Past five minutes without a poll the runner is not routable, and the request runs on SRE Agent's own agent instead, with the reason on the card. A repository set to "Self-hosted runner" behaves the same way.
- **A request collected by a runner that then dies** is failed by SRE Agent 45 minutes after it was queued, and the handoff is closed with it, so a runner that wakes up late cannot report into a request that already has an answer. Nothing reaches your default branch, and nothing is reported. A runner that died in the seconds between its push and the pull request can leave a branch named `sre-agent/<handoff id>` behind with no pull request on it, which is the one artefact of a dead run and is safe to delete.
- **A restart mid-poll** loses nothing: the next poll collects the same request.
- **A key the queue refuses** stops the runner instead of retrying: HTTP 401 or 403 exits with a message naming `SRE_API_KEY` and the scope it needs.
- **A runner you switch off** in SRE Agent is not that. The queue refuses it with a `runner_disabled` code, and the runner says so, says the key is not the problem, and polls once a minute until you switch it back on. Nothing restarts and nothing is lost.

### What it can reach, and what actually bounds it

The permission fences are this package's, and [What the agent may and may not do](#what-the-agent-may-and-may-not-do) describes them. Two things about them matter more here than in CI, because here the machine can reach live systems:

- **The boundary is the role you gave the machine, not the list of denied commands.** The command fences stop a careless step. They do not stop an interpreter: `sh -c`, `python -c`, or a script the agent writes and then runs is one command whose contents no pattern describes. The agent has a shell, so what that shell can reach is what the machine can reach. Give the runner a role of its own, read-only, holding what a diagnosis needs and nothing else.
- **A role the machine provides itself is reachable by the agent unless you close it.** The agent is another account on the same machine, not on another network, so anything the machine hands to any process is within its reach, whatever `SRE_AGENT_AWS_ACCESS` says about the runner's own variables: an instance profile, reached through the instance metadata service (EC2, and ECS on EC2); an EKS pod's IRSA or Pod Identity token file, which every account in the container can read, with the role named on the service account that the `view` binding in the manifest above lets the agent read; a kubeconfig or token file readable by every account. What closes them: give the machine or the node no role at all, and hand the runner the AWS access it needs through its own environment, which the agent does not receive; block the metadata service from the container (`ECS_AWSVPC_BLOCK_IMDS` and an instance metadata hop limit of 1 on ECS and EC2, a network policy or an egress rule matching the agent's uid 10002 on a plain host); make the token file readable only by the runner's account. Only a platform whose credentials are served at an address named by a variable the runner alone holds, as an ECS task role on Fargate is, has nothing for the agent to reach by default.
- **Give it a machine of its own** if your CI or your workstation holds production credentials. A runner sharing a host with them shares them with the agent.

What holds regardless of anything the agent does in that shell:

- The runner does the git and the network work, so no fence had to be relaxed for this door. opencode's own tool gates hold absolutely: web fetch, web search and subagents are off, and the file tools cannot leave the checkout. The shell is where that ends: `git push`, `curl`, `wget`, `ssh` and `scp` are refused as commands, in every prefixed and wrapped form this package could name, and an interpreter is still an interpreter. Read the bullets above rather than this one for what bounds that.
- The agent's account cannot read the runner's process environment (`/proc/<pid>/environ` refuses another account), its git and `gh` state, the memory directory, another repository's clone or another repository's home, and it never holds the poll key or the handoff token. The runner takes its secrets out of the agent's environment, and the AWS variables unless `SRE_AGENT_AWS_ACCESS=1`, and the repository token is on no command line of the runner's (the runner gives it to its own `git` through that process's environment, so another account cannot read it from `/proc/<pid>/cmdline`). The provider key stays in the agent's environment, because opencode needs it to call the model. This holds while the account split does: a start that could not make it (the log and the report's `agent_isolation` evidence say so) does not have it.
- The protected paths gate judges what actually changed rather than which tool changed it, and the runner runs it on the work tree before it pushes. It binds what the runner publishes; it does not bind what the agent's own token can do (next list).
- The poll key, the repository token, the agent's token, the App's private key, the tokens the App mints and the handoff token are replaced with `[redacted]` in every line the runner writes: its own logs, the ones a failing `git` or `gh` prints, and the agent's own message where it becomes the report, the card comment and the pull request body. The runner logs into your aggregator, and a handoff token there would be live for 24 hours. Those are the set: the provider key is passed through to opencode by the variable your provider names, and the runner never learns which one that is, so nothing can replace it if the agent prints it.

What holds only with `SRE_AGENT_GITHUB_TOKEN` set to a read-only token, or with the runner in App mode (where the agent's token is minted read-only on the request's repository for every run, and there is nothing to configure):

- The agent does hold a repository token, as `GH_TOKEN`, because the repositories this runner fixes are private and the agent has to clone them as a CI job does. By default (token mode, nothing set) that is the runner's own token (contents and pull requests, write), and an interpreter (`python3 -c`, `node -e`), which walks past every command fence, can use it against the GitHub API directly: push a branch, open or merge a pull request, or push to a default branch that is not protected, with no gate and no person in between. The fence on `git push` and `gh` is the only thing standing in the way of that, and it is a speed bump. Set `SRE_AGENT_GITHUB_TOKEN` to a fine-grained token with Contents read-only on the repositories the agent has to clone, or run the runner in App mode, and the agent can clone and read but cannot push or merge; the runner still pushes and opens the pull request with its own token (its own installation token in App mode, which carries the installation's permissions).
- Nothing merges without a person. Your own review and CI stand between the pull request and the default branch, and with the default token it is branch protection on the default branch (required reviews, no direct pushes) that stops an agent that went around the fence. The pull request is opened as a draft where your plan offers draft pull requests, and as an ordinary one where it does not, so treat the draft state as a convenience rather than as the control.

### Who runs what

| | account | holds |
| --- | --- | --- |
| the runner | `runner` (uid 10001) in the image, with root only to switch accounts; `sre-agent-fix-runner` on a host, never root | its environment (poll key, repository token, AWS credentials, the memory bucket), the memory mirror's `aws` calls, `/workspace` (mode 0711, so it can be walked through and not listed), `memory/` (0700), the work trees outside a run and every git directory (0700), every git and `gh` call, with `HOME` set to a `runner-home/` directory of its own (0700) |
| the agent | `agent` (uid 10002) in the image, `sre-agent-fix-agent` on a host | no capability, no supplementary group, a home for each repository that lives on the volume (`agent-home/<owner>/<repo>`: `/workspace/agent-home` in the image, beside the workspace on a host), owned by it for the length of that repository's run and by the runner (0700) the rest of the time, and the one work tree of the current run, owned by it for that run only |

**What the agent can do**, as a reduced but capable user, much as a CI job would:

- Work in a real git repository. Its work tree has the full history of the base branch in a `.git` that the agent owns, with `HEAD` and the index at the base and a clean `git status`, so `git log`, `blame`, `diff`, `bisect`, branches and local commits all work. `origin` is the github.com URL with no token in it. The runner makes it from a bundle of the base commit's history that it writes for the purpose; the repository shares no object store with the runner's own git directory (no alternates, no `--shared`), which the agent's account cannot read. Local commits, rewrites and branches are the agent's own: the pull request is the difference between the work tree and the real base, which the runner computes and commits from its own git directory. The agent's `.git` is deleted when the run ends. A subdirectory in which the agent ran `git init` is refused (git would record it as a pointer at history that is in no pull request), and the report says so.
- Clone other repositories, including private ones the token can read: `GH_TOKEN` is in its environment and its `~/.gitconfig` has a credential helper for github.com that answers with it (the token is never written to disk). The fences deny `git push` and `git remote`, and the pull request is opened by the runner.
- Install into its home: `npm -g` (prefix `~/.npm-global`), `pip --user`, `cargo`, `go install`, `gem`, `mix`/`hex`, and language runtimes through `mise` (data under `~/.local/share/mise`, shims on its PATH). Those directories are on its PATH, and because the home is on the volume they are still there on the next request about the same repository, so the first run pays for an install and the later ones reuse it. The home is that repository's alone: what a run leaves in it never reaches another repository's runs, and opencode's own configuration, plugins and agent definitions in it are removed before every run (see [What persists across requests](#what-persists-across-requests)).
- Reach the network for package registries and `git clone` (nothing here narrows the network; put an egress rule on the container or the host if you want one).
- Start the application and run the tests in its work tree, which it can read and write, and write under `/tmp`.

**What the agent cannot do:** be root or use sudo (it holds no capability); install system packages (see [Customizing the image](#customizing-the-image)); push, since the fences deny it and the runner publishes (the fence is the only thing that stops it while `SRE_AGENT_GITHUB_TOKEN` is unset; set that variable to a read-only token and the token stops it as well); read the runner's environment (`/proc/<pid>/environ` refuses another account), the poll key, the handoff token or, by default, the AWS credentials; read or write `memory/`, another repository's clone, or the runner's git directories, the current request's included; or make the runner's git run anything of its own. What git trusts in the runner's git directory (a `commondir`, alternates, grafts, a replace ref, `config.worktree`, attributes, a hook, a filter) the agent cannot write, and the runner removes every such file from that directory anyway; every runner git call names its own git directory and the work tree explicitly, so a hook, a filter or an fsmonitor the agent plants in its own `.git/config` or `.git/hooks` is never read by the runner's git calls, and they run with hooks, fsmonitor, system and global configuration, system attributes and replace objects switched off and with an environment that holds no credential but the call's own.

What else it can reach: every file on the machine or in the image that any account may read (the package under `/opt/sre-agent-opencode`, which it cannot write, `/etc`, system binaries, a kubeconfig or token file that is readable by all); the provider key and the other variables left in its environment; a role the machine provides through its metadata service or a projected token ([above](#what-it-can-reach-and-what-actually-bounds-it)); and, in a pod, the service account token.

The split is proved with real accounts by [`tests/uid_split_test.sh`](tests/uid_split_test.sh), which starts the runner once as root and once as an unprivileged account holding the six capabilities (and, for the fallback, as that account missing one capability, and, for the refusal, as root with none), and has a stub agent report what it can read and write.

### Customizing the image

The image carries a base toolset for typical repositories: `build-essential` (a C toolchain and `make`), `git`, `curl`, `jq`, `unzip`, `xz-utils`, `python3` with `pip` and `venv`, `node`, the AWS CLI, `kubectl`, `gh` and `mise`. Three ways to add what a repository needs, in the order to try them:

1. **mise, in the agent's home, no root.** The agent installs language runtimes as itself (`mise use node@22`, `mise install python@3.12`, and so on), and `npm -g`, `pip --user`, `cargo`, `go install`, `gem` and `mix` all write under its home. The home is on the volume, so they stay for the next request. This needs nothing from you.
2. **A setup script, root, once at container start.** Set `SRE_RUNNER_SETUP` to the path of an executable file that is in the container (mount it, or bake it into a derived image). The entrypoint runs it once, as root, after the two accounts are resolved and before the runner starts (so before the first poll and before anything is handed to the agent), logs its output line by line, and refuses to start the runner if it exits non-zero, saying which script and what status. The runner never fetches a script; a URL is refused, and so is a relative path, and any path at all when `SRE_WORKSPACE` is `/`. Every path is judged as given and again where it resolves to, so a link cannot get one past: it is refused when it is on the workspace; when it is under `/tmp`, `/var/tmp`, `/dev/shm`, `/run/lock` or `/var/lock`; and when the script itself, or any directory above it, is one the agent's account can write: it owns it, its group can write it, or anyone can (the "other" write bit), except in a sticky directory, where only an entry's owner can replace or remove it. That last rule is what a mount with the wrong mode that no list names is caught by, and it is why a script mounted from a ConfigMap or projected volume works: the mount point is a world-writable sticky directory on a read-only volume holding root-owned files and links (`..data`), out of the agent's reach. The agent can write all the refused places and the script runs as root at the next start. The script gets an allowlisted environment, not the container's: `PATH`, `HOME=/root`, the locale and time zone (`LANG`, `LC_ALL`, `TZ`, `TERM`), the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms) and any variable you name `SRE_SETUP_*`. It never sees `SRE_API_KEY`, either GitHub token, a model provider key or AWS credentials. It runs on every container start, not once per volume, so make it idempotent and quick (an `apt-get install` of a few packages is the intended use); for anything heavy, use a derived image. It is for the container only: a start that is not root refuses a script rather than running it as somebody else.
3. **A derived image.** `FROM ghcr.io/segfaultpw/sre-agent-opencode-runner:v1`, `RUN apt-get update && apt-get install ...` as root, and leave the `ENTRYPOINT` and `USER` alone. This is the way for system packages that are large or slow to install.

The agent has no sudo, and a sudo limited to `apt-get` would still be root, because package maintainer scripts run as root and root can read the runner's credentials. System packages therefore come from the setup script or a derived image, both of which are yours and run before the agent exists.

### Cost

Your machine's compute and the tokens your provider bills to your key. No GitHub Actions minutes are spent, and SRE Agent bills nothing for a run on your own machine.

### The opencode version in the image

The image pins opencode at 1.18.29 and checks the download against a sha256 for each architecture, because that binary is what enforces the permission fences, and the runner turns opencode's self-update off so it cannot move under a run.

Moving the pin is a release of this package, recorded in the [CHANGELOG](CHANGELOG.md), so pulling a newer image is the whole upgrade. Building the image yourself with a different `--build-arg OPENCODE_VERSION` fails the checksum on purpose; change the version and both digests in [`runner/Dockerfile`](runner/Dockerfile) together. The systemd install pins nothing: opencode there is whatever you installed on PATH.

## What the agent may and may not do

The configuration in [`config/opencode.json`](config/opencode.json) is a set of opencode's own permission gates, and [`agents/sre-fix.md`](agents/sre-fix.md) is the agent's prompt. The runner passes both to opencode the same way every run, so everything below holds every time.

Before opencode starts, the runner empties the checkout of everything opencode would load from your repository: the whole `.opencode/` directory, and `opencode.json` at the root. The package's own agent is written into the emptied tree afterwards, so what opencode finds there is what the runner put there and nothing else.

The whole directory rather than a list of names, because a list is a guess about a loader nobody here controls, and it was wrong twice: `.opencode/plugin` is loaded and so is `.opencode/plugins`; `.opencode/agents` is read and so is `.opencode/agent`. What each of them is worth taking: opencode merges what the package passes in with your repository's own configuration rather than replacing it, and that merge keeps your key order while a permission resolves to the last rule that matches, so a tracked `opencode.json` naming the same keys can hold the package's denies at its own positions and let its catch-all win. A file under a plugin directory needs none of that, since opencode imports it and it runs before a gate is consulted at all. An agent definition of your own replaces this package's prompt along with every permission in it.

A tracked path is marked `skip-worktree` before it is removed, so no pull request carries the removal and nothing in your repository on GitHub changes. If your repository uses opencode itself, its configuration is untouched everywhere except inside this one run's checkout.

- The edit gate refuses writes under `.github/` and to any path matching `*.env*`, `*secrets*` or `*.pem`, and the read gate refuses env files. Both apply to opencode's file tools.
- The bash gate refuses `git push`, `git remote`, `curl`, `wget`, `ssh`, `scp`, `sudo`, `gh`, and `rm` with a recursive or forcing flag however it is spelled, each written so that an environment prefix (`HTTPS_PROXY=... curl`), a wrapper (`env curl`), an absolute path (`/usr/bin/curl`) and a flag between the binary and the verb (`git -C /tmp/r push`) do not walk past it. `gh` is on that list because the agent's `GH_TOKEN` is the runner's repository token (or the read-only one you give it in `SRE_AGENT_GITHUB_TOKEN`) unless the runner deleted it, where `gh pr merge` would go around the `git push` refusal and the protected paths gate at once. It is written as one pattern per way of invoking it, quoted forms included, plus `gh api` and `gh pr` wherever they appear, so that ordinary commands carrying those two letters (`grep gh file`, a commit message about gh) are not refused with them. opencode parses the command line and applies the patterns to each command in it, denying the call when any one of them is denied, so a refused command does not get through by being chained after an allowed one either. What a pattern sees is that command as written, arguments included.
- The bash gate also refuses the mutating cloud and cluster commands: the `kubectl` write verbs (`delete`, `apply`, `create`, `replace`, `edit`, `patch`, `scale`, `exec`, `cordon`, `drain`, `label`, `annotate`, `expose`, `run`, `debug`, `taint`, `cp`, `attach`, `port-forward`, `proxy`, `certificate approve`, `rollout restart`, `undo`, `pause`, `resume`, and `set` by subcommand); `helm upgrade`, `install`, `uninstall` and `rollback`; `terraform apply`, `destroy`, `import`, and `state rm`, `mv`, `push` and `replace-provider`; the AWS CLI's 37 mutating verb families, written as `*aws *<verb>-*` so a service the CLI adds later needs no new rule; the writing `aws s3` verbs; `aws configure set`, `aws ssm start-session` and `aws ecs execute-command`; and the mutating calls whose verb carries no hyphen, such as `lambda invoke`, `sns publish` and `cloudformation deploy`. Each is written so that flags before the verb (`kubectl -n prod delete pod x`) and an environment prefix (`AWS_PROFILE=prod aws ...`) do not walk past it.
- Keeping the reads open took care, because a pattern sees a command's arguments too: a verb written as a bare substring took `kubectl get volumeattachments`, `kubectl logs deploy/kube-proxy` and `terraform state list` with it. So the mutating subcommand is named wherever a family also holds reads, and `kubectl get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `auth can-i`, `version` and `cluster-info`, and `terraform plan`, `show`, `output`, `validate`, `state list`, `state show` and `state pull`, are allowed again after the deny block. So are four AWS reads whose data has no other read path: `aws logs start-query` and `stop-query`, and `aws cloudtrail start-query` and `cancel-query`. Each of those re-allows is anchored at its verb, because a command that carries a substitution is judged by its whole text: a re-allow with a wildcard in front of the verb can be reached from inside one, as in `kubectl delete pod $(kubectl get pod -o name)`, and would then win over the deny. The cost is that the same read behind an inline credential prefix, `AWS_PROFILE=x aws logs start-query` or a `KUBECONFIG=x` in front of `kubectl`, stays denied. On a runner the credentials come from the process environment or the machine's own role, so the bare form is what gets typed; the inline prefix is a workstation habit. Still refused: a read whose own verb is a mutating word, such as `aws logs start-live-tail`, and a read whose arguments carry one, such as a `--filter-pattern` containing `delete-object`. Over-denial is the safe direction for a deny rule, and the agent says what it could not run.
- **This list is a speed bump, not a boundary, and an interpreter walks around it**: `sh -c`, `python -c`, or a script the agent writes and then runs is a single command whose contents no pattern here describes. The reason to have the list is that it stops a careless step. The reason it is not the control is that the agent has a shell. The boundary is the role you granted the machine the agent runs on, so give that machine a read-only role.
- Web fetch, web search, subagents and questions are off, the file tools cannot leave the checkout, and repeating the same tool call in a loop is refused. Session sharing is disabled, so the transcript is not uploaded to opencode's site.
- The agent never commits, pushes or opens a pull request itself: the runner does that once, after the agent finishes, from the working tree. It never merges and never touches the default branch.

What holds regardless of anything the agent does in that shell:

- The protected paths gate. The runner runs it over the staged file list before anything is published. A change that touched `.github/`, an env file, a path containing `secrets` or a `.pem` key publishes nothing, and the report names the paths.
- The draft pull request, SRE Agent's review, and your own CI on the pull request. Nothing merges without a person.

The provider key and the repository token exist in the runner's environment while the agent runs. The log masks them, which is not the same as keeping them out of a shell's reach. For a runner that shares a machine with production credentials, read [What it can reach, and what actually bounds it](#what-it-can-reach-and-what-actually-bounds-it) and give the machine a role of its own.

## Maintenance

- Every pull request the runner opens carries the stamp `<!-- sre-agent-opencode:vX.Y.Z -->` in its body. SRE Agent records the version with the link, so the Integrations page can say which version of this package a repository ran.
- The runner image is published to `ghcr.io/segfaultpw/sre-agent-opencode-runner` on every release, as one manifest covering amd64 and arm64, with `vX.Y.Z` frozen and `v1` moving. It is built on every push as well, without being pushed, so a Dockerfile is never first exercised at release time.
- For whoever publishes this package: GHCR creates a package **private** on its first push. The first release's image has to be made public by hand, in the package's settings on GitHub, before anyone can pull it.

## Security

The brief comes from alerts, investigations and cards, so it can carry text an attacker wrote, and the agent reads it as data. The gates in this package's configuration raise the cost of a careless or injected step: no web tools, no subagents, no file-tool writes to workflows, env files, secrets or keys, and the listed shell commands refused as written. They are opencode's tool gates, not a sandbox: the agent has a shell on your machine, where the provider key and the repository token exist in the environment. The controls that hold regardless are the protected paths gate (a change that touched a protected path publishes nothing), the draft pull request, SRE Agent's review, and your own CI on the pull request. Nothing merges without a person. The provider key is yours, on your machine; SRE Agent never holds it and never runs opencode. Who can make the runner answer a request is who can create a fix request in SRE Agent, and what the agent can reach on the machine is the role you gave it: see [What it can reach, and what actually bounds it](#what-it-can-reach-and-what-actually-bounds-it).

## License

MIT, see [LICENSE](LICENSE).
