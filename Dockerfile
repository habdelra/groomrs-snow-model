# SNOWPACK's prebuilt .deb needs a newer libstdc++ (GLIBCXX_3.4.32) than
# Debian bookworm ships, so the runtime is Ubuntu 24.04 with Node copied in
# from the official image. TypeScript runs natively (Node 24 type stripping):
# there is no build step.
ARG NODE_VERSION=24.17.0
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM node AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM ubuntu:24.04
ARG SNOWPACK_VERSION=3.7.0
ARG SNOWPACK_SHA256=9e0b0f9d6244b4d242192e842a76ea7c111dd95274baf120e9d368cb2f0b47da
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/snowpack.deb \
     "https://gitlabext.wsl.ch/api/v4/projects/32/packages/generic/snowpack/${SNOWPACK_VERSION}/Snowpack-${SNOWPACK_VERSION}-x86_64.deb" \
  && echo "${SNOWPACK_SHA256}  /tmp/snowpack.deb" | sha256sum -c - \
  && dpkg -i /tmp/snowpack.deb \
  && rm /tmp/snowpack.deb \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config ./config
COPY migrations ./migrations
COPY migrations-removal ./migrations-removal
COPY scripts ./scripts
COPY src ./src

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    HOST=0.0.0.0 \
    PORT=8090 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8090
CMD ["node", "src/server.ts"]
