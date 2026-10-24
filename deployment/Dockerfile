FROM node:26.12.1-bookworm-slim AS build
RUN npm install --global npm@12.2.1 --ignore-scripts
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/components/package.json packages/components/package.json
RUN npm ci --ignore-scripts
COPY packages/components/tsconfig.json packages/components/build.mjs packages/components/
COPY packages/components/src packages/components/src
COPY packages/components/web packages/components/web
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/src backend/src
COPY extension extension
COPY deployment/onboarding deployment/onboarding
COPY scripts/bundle-extension.mjs scripts/bundle-extension.mjs
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26.12.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/components/package.json ./packages/components/package.json
COPY --from=build --chown=node:node /app/packages/components/dist ./packages/components/dist
COPY --chown=node:node package.json ./
RUN npm install --global npm@12.2.1 --ignore-scripts && mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "dist/cli.js", "relay", "--data", "/data"]
