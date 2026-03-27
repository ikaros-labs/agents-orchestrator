FROM node:22-bookworm

# Install tools commonly needed by coding agents
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (the SDK spawns this as a child process)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for running agents
RUN useradd -m -s /bin/bash agent
USER agent

WORKDIR /workspace
