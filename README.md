# NokiaMSN

WhatsApp en un **Nokia 6111** (Series 40, 3.ª edición, 2005).

NokiaMSN es un servidor Node.js que mantiene abierta una sesión de WhatsApp Web
(con [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) y Chromium) y la sirve
como páginas XHTML-MP ligeras que el navegador del Nokia puede abrir. Desde el teléfono
se puede:

- ver la bandeja de chats y grupos con los mensajes sin leer, y abrir cada conversación;
- escribir y enviar mensajes (texto, foto o vídeo 3GP), con menciones en grupos;
- escuchar notas de voz (convertidas a AMR) y leer su transcripción automática;
- ver fotos, stickers, encuestas (y votar), estados y avisos de llamadas;
- silenciar chats, marcar como leído y cambiar ajustes;
- recibir un SMS cuando llega algo nuevo y no estás mirando.

Los mensajes se guardan en una base SQLite local (`data/nokia.db`) y se borran solos
pasados unos días. Además de las páginas web hay una API JSON en `/mobile` (con su propio
token, `X-Nokia-Token`) pensada para un cliente Java ME.

## Cómo encaja con GateWayNK

NokiaMSN no se expone a Internet por sí solo. En producción corre dentro del stack de
**GateWayNK** (carpeta hermana `../GateWayNK`), que lo levanta con Docker Compose:

```
Nokia ──HTTP──▶ ngrok (HTTP) ──────────────────────────▶ gateway:8080 ──▶ nokia-msn:3001
Nokia ──HTTPS─▶ playit.gg / ngrok TCP ─▶ nokia-tls:8443 ─▶ gateway:8080 ──▶ nokia-msn:3001
```

- **gateway**: proxy inverso; es la única puerta de entrada.
- **nokia-tls** (`tls-proxy/` de este repo): habla el TLS 1.0 que entiende el 6111 y
  reenvía en claro al gateway.
- **watchdog**: reinicia servicios colgados y avisa por SMS.
- **ngrok**: túnel HTTP público (y opcionalmente el TCP para el HTTPS).

Todos los puertos se publican solo en `127.0.0.1`; lo único que llega desde fuera son
los túneles.

## Limitaciones

**De WhatsApp**

- Usa WhatsApp Web de forma **no oficial**. WhatsApp puede romperlo con cualquier
  actualización (por eso `whatsapp-web.js` está fijado a un commit concreto) y, en teoría,
  bloquear la cuenta. Úsalo con tu propia cuenta y bajo tu responsabilidad.
- Una sola cuenta por instalación, vinculada como un dispositivo más; el teléfono
  principal tiene que seguir conectándose de vez en cuando.
- Chromium consume bastante RAM: en Docker está limitado a 2 GB (`NOKIA_MSN_MEM_LIMIT`
  en GateWayNK).
- Las fotos de visualización única no se descargan: solo aparece el aviso.
- Las llamadas no se pueden atender; solo quedan registradas como aviso.

**Del Nokia 6111**

- **El HTTPS moderno no funciona.** El teléfono solo habla TLS 1.0, sin SNI, y solo confía
  en la raíz propia «NokiaMSN Root CA» (RSA 2048 + SHA-1) instalada a mano. Por eso existe
  `nokia-tls` y hace falta un túnel **TCP en bruto** (playit.gg o ngrok TCP), no uno HTTP.
- **El audio no se reproduce dentro de la página.** Cada nota de voz se descarga en AMR-NB a
  Galería → Tonos mediante un descriptor OMA (`.dd`), que es lo único que respeta el nombre
  del fichero. Por defecto lleva DRM OMA 1.0 con `count=1`: se escucha sin límite la primera
  vez que se abre y luego el teléfono ofrece borrarlo (configurable con `AUDIO_PLAY_COUNT`).
- Pantalla, memoria y conexión muy limitadas: las páginas son mínimas y las imágenes se
  reducen en el servidor.

**De la red**

- Con la cuenta gratuita de ngrok el dominio HTTP es fijo, pero la dirección TCP cambia
  en cada arranque: el certificado del servidor se regenera y hay que volver a apuntar el
  teléfono a la nueva dirección. Además ngrok gratuito no permite `proxy_proto`, así que
  por HTTPS NokiaMSN no ve la IP real del teléfono. **playit.gg Premium** (dirección TCP
  fija + PROXY protocol v1) evita los dos problemas.
- Detrás de CGNAT no se puede abrir un puerto en el router; los túneles son la única vía.

**Privacidad**

- La limpieza diaria (02:00, hora de Madrid) **borra** los mensajes con más de
  `MESSAGE_RETENTION_DAYS` días. Si la desactivas, la base crece sin límite.
- La transcripción envía el audio a Groq; los SMS pasan por Twilio.

## Puesta en marcha

### 1. Requisitos

- Docker y Docker Compose.
- Este repo en `…/NokiaMSN` y GateWayNK en `…/GateWayNK` (carpetas hermanas).
- Una cuenta de [ngrok](https://ngrok.com) (la gratuita vale) con un dominio estático.
- Opcional: [playit.gg](https://playit.gg) Premium para el HTTPS, [Groq](https://console.groq.com)
  para transcribir y [Twilio](https://www.twilio.com) para los SMS.

### 2. Configurar el `.env` de NokiaMSN

```bash
cp .env.example .env
```

Lo mínimo imprescindible:

1. **PIN de acceso.** Genera el hash y pégalo entre comillas simples (lleva `$`):

   ```bash
   node -e "console.log(require('bcryptjs').hashSync('1234', 10));"
   ```

   ```env
   ACCESS_PIN_HASH_BCRYPT='$2b$10$...'
   ```

2. **`NGROK_HTTP_URL`**: tu dominio estático de ngrok (se usa en los enlaces de los SMS).

Todo lo demás es opcional y está explicado en [.env.example](.env.example): SMS con Twilio,
transcripción con Groq (`GROQ_API_KEY`), ticks azules, limpieza diaria, escuchas de audio,
vinculación por código (`WHATSAPP_PAIRING_PHONE`)…

Algunas opciones (SMS, ticks azules, limpieza y días de retención) también se cambian desde
**Ajustes** en el Nokia, y la app las reescribe en el `.env`.

### 3. Configurar ngrok (en GateWayNK)

El túnel no se configura aquí, sino en `GateWayNK/Gateway/.env`:

```env
# Token en https://dashboard.ngrok.com/get-started/your-authtoken
NGROK_AUTHTOKEN=tu_authtoken
# Dominio estático en https://dashboard.ngrok.com/domains
NGROK_HTTP_URL=https://tu-dominio.ngrok-free.app

# HTTPS del Nokia: «ngrok» (túnel TCP, dirección cambiante) o «playit» (dirección fija)
NOKIA_TLS_PROVIDER=ngrok
# Solo con playit: host:puerto público del túnel TCP que apunta a 127.0.0.1:8443
# NOKIA_TLS_PUBLIC_ADDRESS=algo.tun.ply.gg:12345

# Qué entradas abrir por defecto: http | https | both
# EXPOSE_TUNNELS=both
```

`GateWayNK/scripts/expose.sh` genera `.ngrok/ngrok.yml` a partir de esto (el token va por
variable de entorno, nunca al fichero) y solo arranca el contenedor de ngrok si hace falta.
Con playit, su agente corre fuera de Docker (servicio de systemd) y el túnel TCP debe
apuntar a `127.0.0.1:8443` con PROXY protocol v1 activado.

### 4. Arrancar

Desde NokiaMSN (redirige a GateWayNK con los mismos argumentos):

```bash
npm run expose             # todo: HTTP + HTTPS
npm run expose -- --http   # solo HTTP
npm run expose -- --https  # solo HTTPS del Nokia
```

o directamente `../GateWayNK/scripts/expose.sh [up|status|logs|top|stop…]`
(`--help` muestra todas las opciones). Al terminar enseña las direcciones públicas.
Ctrl+C solo cierra la terminal; los servicios siguen funcionando.

### 5. Vincular WhatsApp

Entra con el PIN y abre `/whatsapp/qr` (mejor desde el navegador del PC:
`http://127.0.0.1:3001/whatsapp/qr`). Escanea el QR desde WhatsApp → *Dispositivos
vinculados*. Si definiste `WHATSAPP_PAIRING_PHONE`, puedes pedir en su lugar un código de
8 caracteres. La sesión se guarda en `.wwebjs_auth/` y sobrevive a los reinicios.

### 6. Preparar el Nokia para HTTPS (una sola vez)

1. Con el stack levantado, abre en el Nokia `http://<dirección-https>/ca.cer` (mismo
   host y puerto que el HTTPS, pero en claro) e instala el certificado como autoridad.
2. A partir de ahí entra por `https://<dirección-https>/`.

La raíz está en `data/tls/ca.{key,pem,cer}`. **No la borres ni la regeneres**: el teléfono
dejaría de confiar en el servidor y habría que reinstalarla. Los certificados del servidor
(`server-<host>.*`) sí se regeneran solos cuando cambia la dirección.

> Por HTTP en claro (dominio de ngrok) también funciona, pero sin cifrar. El HTTPS propio
> de ngrok no sirve: el Nokia no entiende TLS 1.2.

## Desarrollo

```bash
npm install
npm run dev     # nodemon; fuera de Docker define DB_PATH=./data/nokia.db en .env
npm test        # tests con node --test
```

El `docker-compose.yml` de este repo levanta solo la app en `localhost:8080`, sin gateway,
túneles ni HTTPS; sirve para probar en local.

Para probar la transcripción con un audio real:

```bash
AUDIO_TEST_FILE=/ruta/al/audio npm test
```

La prueba llama a Groq y se omite si falta `GROQ_API_KEY` o `AUDIO_TEST_FILE`.

## Detalles de funcionamiento

### Transcripción de audios

Las notas de voz se transcriben al recibirlas con Whisper (Groq). El texto en
castellano/valenciano se guarda junto al mensaje y aparece en sus detalles; los audios
anteriores se transcriben al abrir sus detalles. La imagen Docker instala `ffmpeg` para
preparar el audio y `sox` + `opencore-amrnb` para codificar el AMR que reproduce el Nokia.

### Fotos de visualización única

Llegan como el aviso `[Foto de visualización única]`, conservando el texto adjunto. No se
descarga ni se guarda la imagen; hay que verla en el teléfono principal.

### Avisos de llamadas

Las llamadas entrantes, individuales y de grupo, quedan como avisos de sistema en su chat.
Con los SMS activados y Twilio configurado, cada llamada de un chat no silenciado genera su
propio SMS, aunque haya mensajes sin leer o NokiaMSN esté abierto. El SMS individual usa el
número personal que WhatsApp resuelve para el contacto antes que el del identificador; el
de grupo indica que la llamada es grupal.

## Estructura

```
src/            servidor Express (rutas, controladores, servicios, cliente de WhatsApp)
db/             acceso a SQLite (better-sqlite3)
tls-proxy/      servicio nokia-tls (TLS 1.0 para el 6111)
assets/         iconos y emojis que se sirven al teléfono
patches/        parches de patch-package sobre dependencias
scripts/        utilidades (expose.sh, migraciones, prueba de TLS)
data/           base de datos, avatares y certificados (no se sube a git)
.wwebjs_auth/   sesión de WhatsApp (no se sube a git)
```
