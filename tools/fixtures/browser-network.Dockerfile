FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 libnss3-tools openssl socat dnsmasq-base && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in amd64) p=x64; sum='IWX9BELoGHAUtMonkeSaNaZwXzRk+oDw6Mk+HBFXd3KHYIBNBsIGRupMZPcgNoDbJpLu6gAJjIoIVPZtt1aJ1g==' ;; arm64) p=aarch64; sum='4BXmsSKnjOrlGWqZV4x/oWa7AVoR+B6lCXddMzOAXBIm3t50eslg9wb66gmtW1AamEQ1l1CDvmmruysEhqOWMg==' ;; *) exit 1 ;; esac && \
    curl -fsSL -A kraka-fixture "https://registry.npmjs.org/@oven/bun-linux-$p/-/bun-linux-$p-1.4.5.tgz" -o /tmp/bun.tgz && \
    test "$(openssl dgst -sha512 -binary /tmp/bun.tgz | openssl base64 -A)" = "$sum" && \
    tar xOzf /tmp/bun.tgz package/bin/bun > /usr/local/bin/bun && chmod 755 /usr/local/bin/bun && rm /tmp/bun.tgz && bun --version
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/adapter-acp/package.json packages/adapter-acp/package.json
COPY packages/adapter-antigravity/package.json packages/adapter-antigravity/package.json
COPY packages/adapter-claude-code/package.json packages/adapter-claude-code/package.json
COPY packages/adapter-codex/package.json packages/adapter-codex/package.json
COPY packages/adapter-opencode/package.json packages/adapter-opencode/package.json
COPY packages/adapter-pi/package.json packages/adapter-pi/package.json
COPY packages/adapter-replay/package.json packages/adapter-replay/package.json
COPY packages/browser-host/package.json packages/browser-host/package.json
COPY packages/cli-client/package.json packages/cli-client/package.json
COPY packages/client-runtime/package.json packages/client-runtime/package.json
COPY packages/daemon/package.json packages/daemon/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/environment/package.json packages/environment/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
ARG KRAKA_INSTALL_DESKTOP=0
RUN if [ "$KRAKA_INSTALL_DESKTOP" = "1" ]; then \
    apt-get update && apt-get install -y --no-install-recommends xvfb xauth libgtk-3-0t64 libasound2t64 && rm -rf /var/lib/apt/lists/* && \
    CI=true bun tools/fixtures/ci-electron.ts && bun run --filter @kraka/desktop build && \
    bun tools/package-release.ts --host --out .build/release; fi
