FROM node:22.23.3-slim

# openssl: para generar el certificado del servidor cuando cambia la dirección de ngrok.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs openssl-legacy.cnf ./
ENV OPENSSL_CONF=/app/openssl-legacy.cnf \
    NODE_ENV=production

EXPOSE 8443
CMD ["node", "server.mjs"]
