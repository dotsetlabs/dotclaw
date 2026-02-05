# DotClaw Agent Container
# Runs OpenRouter-based agent runtime in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and Python
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    sudo \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Allow the node user to install system packages via sudo
RUN echo 'node ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/node && chmod 0440 /etc/sudoers.d/node

# Install common Python packages
RUN pip3 install --break-system-packages pandas numpy requests beautifulsoup4 matplotlib

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally
RUN npm install -g agent-browser

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies (include dev deps for TypeScript build)
RUN npm ci

# Copy source code (avoid host node_modules via .dockerignore)
COPY agent-runner/tsconfig.json ./tsconfig.json
COPY agent-runner/src ./src

# Build TypeScript and trim dev deps
RUN npm run build && npm prune --omit=dev

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/requests /workspace/ipc/responses /workspace/ipc/agent_requests /workspace/ipc/agent_responses

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists
RUN printf '#!/bin/bash\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\nif [ \"${DOTCLAW_DAEMON}\" = \"1\" ]; then\n  node /app/dist/daemon.js\nelse\n  cat > /tmp/input.json\n  node /app/dist/index.js < /tmp/input.json\nfi\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
