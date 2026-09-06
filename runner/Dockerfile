# The fix runner and the read-only clients a diagnosis is made with.
#
# Built from the repository root, not from this directory:
#
#   docker build -f runner/Dockerfile -t sre-agent-opencode-runner .
#
# The image carries the package's own config, agent, scripts and VERSION,
# because the runner reads them from its parent directory and stamps pull
# requests with what it read. A version passed in at run time could disagree
# with the fences that are actually enforcing, so the stamp is the image's own.
FROM node:22-bookworm-slim

# Set by buildx from the platform being built. Each architecture is built on a
# runner of that architecture, so nothing here is ever cross-compiled and this
# is the machine's own arch.
ARG TARGETARCH

# opencode is pinned at the version the reusable workflow's action is pinned
# at, so a fix request answered here meets the same binary, and the same
# permission matcher, as one answered in CI. A bump belongs in the CHANGELOG.
ARG OPENCODE_VERSION=1.18.29
ARG KUBECTL_VERSION=v1.37.0
ARG GH_VERSION=2.100.0
ARG AWSCLI_VERSION=2.36.40

# git and gh are what the runner publishes with, jq is what the package's own
# scripts parse with, and less is the pager the AWS CLI reaches for. curl,
# unzip and tar serve the installs below and are kept: an operator who execs in
# to diagnose the runner itself has nothing else to fetch with.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The x64 build is taken in its baseline form on purpose. opencode's own
# installer chooses between the AVX2 and the baseline binary by reading
# /proc/cpuinfo, which in a container build is the BUILD machine's, and that
# says nothing about the customer machine the image will run on. A binary that
# faults with an illegal instruction there would fail every job.
#
# Pinned by content as well as by version: this binary is what enforces the
# permission fences, so the image should not accept a different one under the
# same tag.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) target=linux-x64-baseline; sha=03a3f2f063e23477e3e4c3a738eb389f56c5a6ecf54d6a5a6d91caab557f042d ;; \
      arm64) target=linux-arm64; sha=70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0 ;; \
      *) echo "no opencode build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${target}.tar.gz"; \
    echo "${sha}  /tmp/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode; \
    rm /tmp/opencode.tar.gz; \
    opencode --version

# kubectl and the AWS CLI are the point of the whole door: the agent gets the
# live read access the machine's own role grants it, rather than guessing from
# the source. Both are read-only here only because the role is read-only; the
# command denies in config/opencode.json are a second line, not the boundary.
RUN set -eux; \
    base="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}"; \
    curl -fsSL -o /usr/local/bin/kubectl "${base}/kubectl"; \
    echo "$(curl -fsSL "${base}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "no AWS CLI build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/awscli.zip \
      "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWSCLI_VERSION}.zip"; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli; \
    rm -rf /tmp/aws /tmp/awscli.zip; \
    aws --version

RUN set -eux; \
    dir="gh_${GH_VERSION}_linux_${TARGETARCH}"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    curl -fsSL -o "/tmp/${dir}.tar.gz" "${base}/${dir}.tar.gz"; \
    curl -fsSL -o /tmp/gh_checksums.txt "${base}/gh_${GH_VERSION}_checksums.txt"; \
    (cd /tmp && grep " ${dir}.tar.gz\$" gh_checksums.txt | sha256sum -c -); \
    tar -xzf "/tmp/${dir}.tar.gz" -C /tmp; \
    install -m 0755 "/tmp/${dir}/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${dir}.tar.gz" /tmp/gh_checksums.txt "/tmp/${dir}"; \
    gh --version

# One unprivileged account for the runner and, through it, for the agent it
# starts. The agent has a shell, so what the account can reach is what the
# agent can reach. The id is fixed rather than allocated, because an operator
# who mounts a host directory at /workspace has to be able to chown it to
# something, and that something must not move between releases.
RUN groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid runner \
       --home-dir /home/runner --create-home --shell /usr/sbin/nologin runner

# The package stays owned by root and is not writable by the account the agent
# runs under, so a run cannot edit the fences that the next run will load.
COPY VERSION /opt/sre-agent-opencode/VERSION
COPY config /opt/sre-agent-opencode/config
COPY agents /opt/sre-agent-opencode/agents
COPY scripts /opt/sre-agent-opencode/scripts
COPY runner /opt/sre-agent-opencode/runner
RUN chown -R root:root /opt/sre-agent-opencode \
    && chmod -R go-w /opt/sre-agent-opencode \
    && chmod 0755 /opt/sre-agent-opencode/runner/entrypoint.sh

# The checkouts and the agent's own state. Mount a volume here to keep clones
# between restarts; nothing in it is needed to recover a job, since a job that
# was collected and lost is failed by the platform's sweep.
RUN mkdir -p /workspace && chown runner:runner /workspace
ENV SRE_WORKSPACE=/workspace
VOLUME ["/workspace"]

# GHCR reads this to attach the package to the repository, which is what makes
# the repository's admins the package's admins.
LABEL org.opencontainers.image.source="https://github.com/segfaultpw/sre-agent-opencode"
LABEL org.opencontainers.image.description="Answers SRE Agent fix requests with opencode on a machine you own"
LABEL org.opencontainers.image.licenses="MIT"

USER runner
WORKDIR /workspace
ENTRYPOINT ["/opt/sre-agent-opencode/runner/entrypoint.sh"]
