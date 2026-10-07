# apps/worker — Node + BullMQ (Baileys menyusul di Task 4)
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.9.1 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @reza-ai/core build
RUN pnpm --filter @reza-ai/worker build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/prisma ./packages/core/prisma
COPY --from=builder /app/node_modules ./node_modules
COPY apps/worker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Volume state auth WhatsApp (di-mount dari compose)
VOLUME ["/data/wa-auth"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/worker/dist/index.js"]
