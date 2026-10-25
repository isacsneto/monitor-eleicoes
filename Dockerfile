# Painel de apuração: Node sem dependências externas.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY data/history ./data/history
COPY data/polls ./data/polls
COPY data/ref ./data/ref
COPY data/seed ./data/seed

# Volume persistente montado em /data (série ao vivo, boletins do exterior, chat).
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/index.js"]
