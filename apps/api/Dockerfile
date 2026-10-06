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
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY packages/database/package.json ./packages/database/
COPY packages/database/prisma ./packages/database/prisma
COPY packages/database/src ./packages/database/src
COPY apps/api/package.json ./apps/api/
COPY apps/api/dist ./apps/api/dist

RUN pnpm install --prod --frozen-lockfile
RUN pnpm --filter @cih/database generate

USER node
EXPOSE 3000

CMD ["node", "apps/api/dist/main.js"]