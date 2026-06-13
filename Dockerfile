FROM node:18-slim

# Instalar dependencias de ejecución del sistema para Chrome y SQLite
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    libgbm1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    libnspr4 \
    libnss3 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Variables críticas de ejecución limpia para saltar compilaciones lentas de sharp
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
    PUPPETEER_CACHE_DIR=/usr/src/app/.puppeteer_cache \
    NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./

# npm install estándar saltándose auditorías y bloqueos estrictos del lockfile
RUN npm install --omit=dev --no-audit --no-fund

COPY . /usr/src/app

RUN chmod -R 777 /usr/src/app

CMD ["node", "src/index.js"]
