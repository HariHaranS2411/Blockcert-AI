FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

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
