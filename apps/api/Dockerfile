FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/database ./packages/database
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cih/shared build
RUN pnpm --filter @cih/database generate
RUN pnpm --filter @cih/api build

FROM node:20-alpine AS runner
RUN apk add --no-cache tini
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node packages/shared/dist ./packages/shared/dist
COPY --chown=node:node packages/database/package.json ./packages/database/
COPY --chown=node:node packages/database/prisma.config.ts ./packages/database/
COPY --chown=node:node packages/database/prisma ./packages/database/prisma
COPY --chown=node:node packages/database/src ./packages/database/src
COPY --chown=node:node apps/api/package.json ./apps/api/
COPY --chown=node:node apps/api/dist ./apps/api/dist

RUN pnpm install --prod --frozen-lockfile && \
    pnpm --filter @cih/database generate && \
    pnpm store prune && \
    rm -rf /root/.local/share/pnpm/store /root/.cache /tmp/*

COPY --chown=node:node apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]