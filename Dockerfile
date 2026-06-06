# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────
FROM node:22-slim
# curl: file downloads (utils/download.ts)
# git + openssh-client: Claude Code agent operations inside the workspace,
#   including SSH remotes (mount host ~/.ssh and ~/.gitconfig to reuse auth)
# ffmpeg: TTS audio concat + reddit video muxing
# yt-dlp: /extract and /vreddit media downloads
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openssh-client ffmpeg awscli procps iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && curl -fsSL https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_amd64.tar.gz \
       | tar xz --strip-components=2 -C /usr/local/bin gh_2.93.0_linux_amd64/bin/gh

# Legacy MongoDB 4.4 shell for DocumentDB queries via SSH tunnel.
# DocDB advertises wire version 7 (MongoDB 4.0) — the modern mongosh refuses
# it, so the legacy `mongo` shell is required. The ubuntu2004 build needs
# libssl1.1, which Debian bookworm dropped; pull it from Ubuntu focal.
RUN curl -fsSL http://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2_amd64.deb \
       -o /tmp/libssl1.1.deb \
    && dpkg -i /tmp/libssl1.1.deb && rm /tmp/libssl1.1.deb \
    && curl -fsSL https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2004-4.4.29.tgz \
       -o /tmp/m.tgz \
    && tar xzf /tmp/m.tgz -C /tmp \
    && cp /tmp/mongodb-linux-x86_64-ubuntu2004-4.4.29/bin/mongo /usr/local/bin/mongo \
    && rm -rf /tmp/m.tgz /tmp/mongodb-linux-x86_64-ubuntu2004-4.4.29

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

CMD ["node", "dist/index.js"]
