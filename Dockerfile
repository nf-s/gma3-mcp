# The default target bundles source tools, never a documentation corpus.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts/stamp-build.mjs ./scripts/
RUN npm run build

FROM debian:bookworm-slim AS reference-source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Public, reviewed application source pinned to an immutable commit.
RUN mkdir /reference && curl -fsSL https://github.com/nf-s/ma3-docs/archive/bd84aeacbfa5fc64b67a74d9a0801ff2b49bfe98.tar.gz | tar -xz --strip-components=1 -C /reference

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production GMA3_BRIDGE_HOST=host.docker.internal GMA3_OSC_HOST=host.docker.internal GMA3_INSTALL_DIR=/gma3
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/reference-python && /opt/reference-python/bin/pip install --no-cache-dir lxml 'pypdf[image]' pdfplumber
ENV PATH="/opt/reference-python/bin:${PATH}"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=reference-source --chown=node:node /reference /opt/ma3-docs
COPY plugin ./plugin
COPY scripts ./scripts
COPY docs ./docs
COPY LICENSE README.md ./
USER node
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]

# Opt-in local corpus supplied as a separately prepared, named build context.
FROM runtime AS offline
LABEL org.opencontainers.image.source="https://github.com/nf-s/gma3-mcp"
COPY --from=corpus --chown=node:node / /opt/ma3-docs/
RUN python3 /opt/ma3-docs/scripts/build_index.py
ENV GMA3_DOCS_URL=http://127.0.0.1:8765 GMA3_DOCS_LOCAL=1

FROM runtime AS default
