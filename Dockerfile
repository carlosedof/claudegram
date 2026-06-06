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
      curl ca-certificates git openssh-client ffmpeg awscli \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && curl -fsSL https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_amd64.tar.gz \
       | tar xz --strip-components=2 -C /usr/local/bin gh_2.93.0_linux_amd64/bin/gh

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

CMD ["node", "dist/index.js"]
