FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs ./docs
COPY infrastructure ./infrastructure
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @online-learning/database generate
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY --from=build /app ./
CMD ["node", "apps/api/dist/main.js"]
