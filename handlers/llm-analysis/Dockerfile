# syntax=docker/dockerfile:1
# The model handler for Achtung. Build it from the repository's root, which holds the
# workspace it belongs to:
#   docker build -f handlers/llm-analysis/Dockerfile -t achtung-llm-analysis .
# Node runs the TypeScript sources directly, so there is no build step.
# Keep the Node version in sync with .tool-versions.
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# No dependencies outside the workspace: the handler and the SDK are all there is to run.
COPY sdk/typescript/package.json sdk/typescript/package.json
COPY sdk/typescript/src sdk/typescript/src
COPY handlers/llm-analysis/package.json handlers/llm-analysis/package.json
COPY handlers/llm-analysis/src handlers/llm-analysis/src
# Linked as in the workspace: Node runs TypeScript sources only from outside node_modules,
# and follows the link to where they are.
RUN mkdir -p handlers/llm-analysis/node_modules/@achtung && \
    ln -s /app/sdk/typescript handlers/llm-analysis/node_modules/@achtung/handover-sdk
WORKDIR /app/handlers/llm-analysis
USER node
CMD ["node", "src/main.ts"]
