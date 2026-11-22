# One image, three services: the compose file picks the entrypoint.
FROM node:20-slim AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package.json ./
USER node
# tsc emits to dist/src/... (rootDir is the repo root because scripts/ is
# compiled too). The monolith's `node dist/main.js` pointed at a file that
# never existed, which is why the original compose stack crash-looped.
CMD ["node", "dist/src/apps/fleet-api/main.js"]
