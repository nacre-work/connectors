# One connector, one image. Built from the workspace so the kit is compiled
# with it; the runtime carries git, because the connector shells out to it,
# and runs as `node` with the state in a volume.
#
# `BASE` exists for a build behind a registry mirror; the default is what the
# release builds. pnpm is installed at the version `packageManager` pins rather
# than through corepack, which Node 25 stopped shipping.
ARG BASE=node:24-alpine
FROM ${BASE} AS build
USER root
WORKDIR /app
COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" 
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/kit/package.json packages/kit/tsconfig.json packages/kit/
COPY connectors/git/package.json connectors/git/tsconfig.json connectors/git/
RUN pnpm install --frozen-lockfile
COPY packages/kit/src packages/kit/src
COPY connectors/git/src connectors/git/src
RUN pnpm build && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM ${BASE}
USER root
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /app /app
ENV CONNECTOR_STATE=/state/connector.sqlite PORT=9400 NODE_ENV=production
RUN mkdir -p /state && chown node:node /state
VOLUME ["/state"]
USER node
EXPOSE 9400
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "connectors/git/dist/main.js"]
