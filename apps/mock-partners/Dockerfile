FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/mock-partners ./apps/mock-partners

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cih/mock-partners build

FROM node:20-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

ENV NODE_ENV=production
ENV MOCK_PARTNERS_PORT=4000

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mock-partners/package.json ./apps/mock-partners/
COPY apps/mock-partners/dist ./apps/mock-partners/dist

RUN pnpm install --prod --frozen-lockfile

USER node
EXPOSE 4000

CMD ["node", "apps/mock-partners/dist/main.js"]
