# Pixelgame multiplayer server (and, with SERVE_STATIC=1, the game itself).
#   docker compose up -d --build        (see docker-compose.yml)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The shared game code and data, the server, and the static game files.
COPY src ./src
COPY data/v1 ./data/v1
COPY server ./server
COPY index.html manifest.webmanifest sw.js precache-manifest.js ./
COPY css ./css
COPY fonts ./fonts
COPY icons ./icons

RUN mkdir -p /app/server-data && chown -R node:node /app/server-data
USER node
VOLUME ["/app/server-data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
