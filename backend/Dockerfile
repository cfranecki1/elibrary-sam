FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p data uploads
EXPOSE 4000
CMD ["node", "src/server.js"]
