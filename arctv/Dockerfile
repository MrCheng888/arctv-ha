ARG BUILD_FROM=node:24-alpine
FROM ${BUILD_FROM}

WORKDIR /app
COPY app/ ./

# /config — папка аддона в addon_configs (видна через Samba); TZ задаёт Home Assistant
ENV NODE_ENV=production DATA_DIR=/config PORT=8090

EXPOSE 8090
CMD ["node", "server.js"]
