# Образ задан прямо здесь: базовый образ Home Assistant (s6-overlay) не нужен — сервер это один процесс Node.js
FROM node:24-alpine

WORKDIR /app
COPY app/ ./

# /config — папка аддона в addon_configs (видна через Samba); TZ задаёт Home Assistant
ENV NODE_ENV=production DATA_DIR=/config PORT=8090

EXPOSE 8090
CMD ["node", "server.js"]
