# One image, three commands:
#   web      node server.js          (the default)
#   worker   node dist/worker.mjs
#   migrate  node dist/migrate.mjs   (the release step; needs DATABASE_OWNER_URL)
#
# Build: docker build -t kalendr:local .
# No secret is baked in. Every value is read from the environment when a container starts,
# and the web app refuses to start in production when a required secret is missing.

ARG NODE_IMAGE=node:26.13.0-bookworm-slim

# Node 25 and later no longer ship corepack, so install the pnpm that package.json pins.
FROM ${NODE_IMAGE} AS pnpm
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global --no-fund --no-audit pnpm@11.23.0

FROM pnpm AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM pnpm AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && pnpm build:jobs

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
