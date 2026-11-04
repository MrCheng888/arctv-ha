# Базовый образ Home Assistant (Alpine + s6-overlay); его подставляет сам HA
ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs

WORKDIR /app
COPY app/ ./

# /config — папка аддона в addon_configs (видна через Samba); TZ задаёт Home Assistant
ENV NODE_ENV=production DATA_DIR=/config PORT=8090

EXPOSE 8090
CMD ["node", "/app/server.js"]
