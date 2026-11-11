FROM node:22.23.3-slim

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
    ffmpeg \
    # El ffmpeg de Debian no trae codificador AMR: sox + opencore lo codifica
    # para que las notas de voz se puedan reproducir en el Nokia.
    sox \
    libsox-fmt-all \
    libopencore-amrnb0 \
    && rm -rf /var/lib/apt/lists/*

# Variables críticas de ejecución limpia para saltar compilaciones lentas de sharp
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
    PUPPETEER_CACHE_DIR=/usr/src/app/.puppeteer_cache \
    NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./

# patch-package se ejecuta durante `npm install` (postinstall), así que los
# parches deben estar presentes antes de instalar las dependencias.
COPY patches ./patches

# npm install estándar saltándose auditorías y bloqueos estrictos del lockfile
RUN npm install --omit=dev --no-audit --no-fund

COPY . /usr/src/app

# Sin «RUN chmod -R 777 /usr/src/app»: el contenedor corre como root (no hace falta) y esa
# capa duplicaba node_modules (~850 MB) en cada cambio de código, haciendo lento el build.

CMD ["node", "src/index.js"]
