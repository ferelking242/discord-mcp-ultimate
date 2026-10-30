# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

# Stage 2: Run
FROM node:26-alpine

LABEL io.modelcontextprotocol.server.name="io.github.ferelking242/discord-mcp-ultimate"
LABEL org.opencontainers.image.title="Discord MCP Ultimate"
LABEL org.opencontainers.image.description="Discord MCP server with 177 tools, plus a 24/7 bot for reaction roles and HTTP MCP"
LABEL org.opencontainers.image.source="https://github.com/ferelking242/discord-mcp-ultimate"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

COPY --from=builder /app/dist/ dist/

# Reaction-role menus are stored here. Mount a volume so a restart does not drop
# every menu the bot was serving.
RUN mkdir -p /app/.data && chown -R nodejs:nodejs /app/.data

USER nodejs
ENV NODE_ENV=production

# Default entry is the stdio server, so this image stays a drop-in replacement for
# the upstream one. For the long-running bot, override the entrypoint:
#   docker run --env-file .env -p 127.0.0.1:3000:3000 \
#     -v discord-mcp-data:/app/.data discord-mcp-ultimate \
#     node dist/bot/index.js
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
