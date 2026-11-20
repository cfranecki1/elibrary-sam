FROM node:22-bookworm-slim
# python3/make/g++ are needed only if the better-sqlite3 prebuilt binary
# cannot be fetched and it has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/
COPY web/ ./web/
CMD ["node", "backend/live-server.js"]
