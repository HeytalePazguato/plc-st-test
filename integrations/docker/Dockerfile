# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f integrations/docker/Dockerfile -t plc-st-test:dev .
# Base: node:26-alpine3.24 multi-arch index digest, resolved 2026-10-31. Dependabot (docker ecosystem) bumps it.

FROM node:26-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /src
# Node 25+ no longer ships corepack, so pnpm is installed with npm at the exact version the repo pins in the packageManager field.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# pnpm 11 `deploy` works as-is here (no --legacy, no inject-workspace-packages): it copies the workspace packages and their production dependencies into /out, including tree-sitter-iec61131-3-st with its grammar .wasm, the only grammar wasm the CLI loads today (the beckhoff and br dialects reuse it).
RUN pnpm --filter plc-st-test deploy --prod /out

FROM node:26-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
LABEL org.opencontainers.image.title="plc-st-test" \
      org.opencontainers.image.description="Unit test runner for IEC 61131-3 Structured Text. No PLC runtime, no license." \
      org.opencontainers.image.source="https://github.com/HeytalePazguato/plc-st-test" \
      org.opencontainers.image.licenses="MIT"
COPY --from=builder /out /opt/plc-st-test
RUN ln -s /opt/plc-st-test/dist/cli.js /usr/local/bin/plc-st-test && chmod +x /opt/plc-st-test/dist/cli.js
# Results go to ./plc-st-test-results by default. With a read-only /work mount pass --out-dir /tmp/results (or mount a writable volume) or the run exits 2.
USER node
WORKDIR /work
ENTRYPOINT ["plc-st-test"]
CMD ["--help"]
