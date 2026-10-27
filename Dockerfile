FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# The ganache/chokidar dependency chain has native modules (bcrypt, keccak,
# secp256k1, leveldown, bufferutil, utf-8-validate). They normally install from
# bundled prebuilt binaries; the toolchain is here so a missing prebuild still
# compiles, and it is purged in the same layer so it never reaches the image.
# npm install is the fallback: unlike npm ci it reconciles platform-specific
# lockfile entries instead of failing the build on a stray one.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) \
    && npm cache clean --force \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY contracts ./contracts
COPY database ./database
COPY models ./models
COPY config ./config
COPY controllers ./controllers
COPY middleware ./middleware
COPY routes ./routes
COPY services ./services
COPY scripts ./scripts
COPY utils ./utils
COPY public ./public
COPY server.js package.json ./

ENV NODE_ENV=production
# Keep V8 heap modest: the free-tier container has ~512 MB and OCR peaks.
ENV NODE_OPTIONS=--max-old-space-size=384

EXPOSE 10000
CMD ["node", "scripts/cloud-boot.js"]
