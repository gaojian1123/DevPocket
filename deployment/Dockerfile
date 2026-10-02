FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/src backend/src
COPY extension extension
COPY scripts/bundle-extension.mjs scripts/bundle-extension.mjs
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "dist/cli.js", "relay", "--data", "/data"]
