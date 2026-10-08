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
# pnpm asks nothing with `CI` set; without it, reshaping node_modules waits for
# an answer nobody is there to give, which is how the first image build hung.
ENV CI=true
WORKDIR /app
COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" 
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/kit/package.json packages/kit/tsconfig.json packages/kit/
COPY connectors/git/package.json connectors/git/tsconfig.json connectors/git/
RUN pnpm install --frozen-lockfile
COPY packages/kit/src packages/kit/src
COPY connectors/git/src connectors/git/src
# `prune --prod` rather than a second install: an install leaves every dev
# package in the virtual store, and the prune leaves the SDK — 132 entries
# against 3, measured.
RUN pnpm build && pnpm prune --prod

FROM ${BASE}
USER root
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /app /app
# `node:sqlite` still announces itself as experimental on Node 24, and the log
# is JSON lines — one prose line per start is a line every reader has to skip.
ENV CONNECTOR_STATE=/state/connector.sqlite PORT=9400 NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN mkdir -p /state && chown node:node /state
VOLUME ["/state"]
USER node
EXPOSE 9400
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "connectors/git/dist/main.js"]
