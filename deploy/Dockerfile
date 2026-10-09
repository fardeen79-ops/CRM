# Sourcing CRM: one container, no build step. Data lives in the mounted /data volume.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Anthropic's SDK, for the verification bot's AI.
RUN npm ci --omit=dev
COPY src ./src
COPY bot ./bot
COPY public ./public
COPY scripts ./scripts
# Serve the Emirates ID scanner files from this server instead of the public internet.
RUN npm run setup:ocr
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/crm.db
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
