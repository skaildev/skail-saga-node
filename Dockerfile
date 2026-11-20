# Builds the console app and runs it with the repository folder mounted on /data (scripts/run.sh does it):
# the app reads .env from there, so the key never goes into the image. Only SKAIL_WORKLOAD comes in at build time,
# because the skail bundle is built for it.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
ARG SKAIL_WORKLOAD
RUN test -n "$SKAIL_WORKLOAD" || (echo "build-arg SKAIL_WORKLOAD is required (name:version)" >&2; exit 1)
RUN npm run build
WORKDIR /data
ENTRYPOINT ["node", "--enable-source-maps", "/app/dist/main.js"]
