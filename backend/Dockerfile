FROM node:22-bookworm-slim AS widget
WORKDIR /app/widget
ARG NPM_CONFIG_OFFLINE=false
COPY widget/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY widget/tsconfig.json ./
COPY widget/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS build

WORKDIR /app/backend
ARG NPM_CONFIG_OFFLINE=false

COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations

RUN npm run build

FROM build AS migrations

CMD ["npm", "run", "migrate", "--", "up"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app/backend
ARG NPM_CONFIG_OFFLINE=false

COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/backend/dist ./dist
COPY --from=widget /app/widget/dist ./widget

COPY knowledge /app/knowledge

EXPOSE 3000

USER node

CMD ["node", "dist/server.js"]
# OCR dependencies are isolated from the HTTP image. Installation and version checks
# run against Bookworm during the build, so unavailable packages fail the build.
FROM runtime AS worker
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ocrmypdf tesseract-ocr tesseract-ocr-eng poppler-utils \
  && ocrmypdf --version \
  && tesseract --version \
  && pdftoppm -v \
  && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "dist/ingestion/worker.js"]
