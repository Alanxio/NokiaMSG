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

## Dos formas de arrancarlo

**Solo NokiaMSN** (`scripts/standalone.sh`, todo lo necesario está en este repo; ver
[Puesta en marcha](#puesta-en-marcha)):

```
Nokia ──HTTP──▶ ngrok (HTTP) ───────────────────────────▶ nokia-msn:3001
Nokia ──HTTPS─▶ playit.gg / ngrok TCP ─▶ nokia-tls:8443 ─▶ nokia-msn:3001
```

**Dentro de GateWayNK** (carpeta hermana `../GateWayNK`), que añade un proxy inverso
común con otros servicios, un watchdog que reinicia lo que se cuelga y avisa por SMS,
copias de seguridad y un panel de estado:

```
Nokia ──HTTP──▶ ngrok (HTTP) ──────────────────────────▶ gateway:8080 ──▶ nokia-msn:3001
Nokia ──HTTPS─▶ playit.gg / ngrok TCP ─▶ nokia-tls:8443 ─▶ gateway:8080 ──▶ nokia-msn:3001
```

- **nokia-tls** (`tls-proxy/` de este repo): habla el TLS 1.0 que entiende el 6111 y
  reenvía en claro a NokiaMSN (o al gateway).
- **ngrok**: túnel HTTP público (y opcionalmente el TCP para el HTTPS).

En los dos casos los puertos se publican solo en `127.0.0.1`; lo único que llega desde
fuera son los túneles.

## Limitaciones

**De WhatsApp**

- Usa WhatsApp Web de forma **no oficial**. WhatsApp puede romperlo con cualquier
  actualización (por eso `whatsapp-web.js` está fijado a un commit concreto) y, en teoría,
  bloquear la cuenta. Úsalo con tu propia cuenta y bajo tu responsabilidad.
- Una sola cuenta por instalación, vinculada como un dispositivo más; el teléfono
  principal tiene que seguir conectándose de vez en cuando.
- Chromium consume bastante RAM: en Docker está limitado a 2 GB (`NOKIA_MSN_MEM_LIMIT`
  en el `.env`, o en el de GateWayNK).
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

Esta guía arranca NokiaMSN por su cuenta con `scripts/standalone.sh`: no hace falta nada
más que este repo. (Si ya usas GateWayNK, mira [Con GateWayNK](#con-gatewaynk) al final.)

### 1. Requisitos

- Un PC con **Linux** que se quede encendido (en macOS/Windows: Docker Desktop y una
  terminal bash, sin probar).
- **Docker** con **Docker Compose** (`docker compose version` debe funcionar) y tu usuario
  con permiso para usarlo (grupo `docker`).
- Unos **3 GB de RAM** libres (Chromium) y ~2 GB de disco para la imagen.
- Una cuenta de **WhatsApp** en un smartphone, para vincularla.
- Una cuenta de **[ngrok](https://ngrok.com)** (la gratuita vale) para entrar desde
  Internet, con su [dominio estático gratuito](https://dashboard.ngrok.com/domains).
- Opcional: [playit.gg](https://playit.gg) Premium (HTTPS con dirección fija),
  [Groq](https://console.groq.com) (transcribir audios) y [Twilio](https://www.twilio.com)
  (avisos por SMS).

No hace falta instalar Node.js: todo se construye y corre dentro de Docker.

### 2. Descargar y elegir el PIN

```bash
git clone https://github.com/Alanxio/NokiaMSG.git NokiaMSN
cd NokiaMSN
./scripts/standalone.sh pin
```

El script crea el `.env` a partir de [.env.example](.env.example) y te pide el **PIN** con
el que entrarás desde el Nokia. Para cifrarlo (bcrypt) usa la imagen de NokiaMSN, así que
la primera vez la construye antes (unos minutos). Para cambiarlo, vuelve a ejecutar `pin`.

### 3. Configurar ngrok

Abre `.env` y rellena, en la sección «Arranque sin GateWayNK»:

```env
# https://dashboard.ngrok.com/get-started/your-authtoken
NGROK_AUTHTOKEN=tu_authtoken
```

y, más arriba, tu dominio estático:

```env
# https://dashboard.ngrok.com/domains
NGROK_HTTP_URL=https://tu-dominio.ngrok-free.app
```

Con esto ya tienes la entrada **HTTP** (sin cifrar) y el **HTTPS del Nokia** por un túnel
TCP de ngrok. El resto de opciones del `.env` (SMS, transcripción, limpieza…) son
opcionales y están explicadas en el propio fichero.

### 4. Arrancar

```bash
./scripts/standalone.sh
```

Construye lo que haya cambiado, arranca los contenedores, abre los túneles y termina con
un resumen como este:

```
══════════════════════════════════════════════════════════
  NokiaMSN
══════════════════════════════════════════════════════════
  Local:        http://127.0.0.1:3001/
  HTTP:         http://tu-dominio.ngrok-free.app
  Nokia HTTPS:  https://0.tcp.eu.ngrok.io:12345/  (ngrok)
  Raíz TLS:     http://0.tcp.eu.ngrok.io:12345/ca.cer  (instálalo una vez en el Nokia como autoridad)
  WhatsApp:     waiting_qr  → vincula en http://127.0.0.1:3001/whatsapp/qr
══════════════════════════════════════════════════════════
```

Los contenedores siguen funcionando al cerrar la terminal y se reinician solos si el PC
arranca de nuevo (mientras Docker esté activo).

### 5. Vincular WhatsApp

En el navegador del PC abre `http://127.0.0.1:3001/whatsapp/qr`, entra con el PIN y escanea
el QR desde WhatsApp → *Dispositivos vinculados* → *Vincular un dispositivo*. Si pones tu
número en `WHATSAPP_PAIRING_PHONE` (`.env`), puedes pedir en su lugar un código de 8
caracteres. La sesión se guarda en `.wwebjs_auth/` y sobrevive a los reinicios.

### 6. Preparar el Nokia

**Por HTTP** (lo más sencillo, sin cifrar): abre en el navegador del Nokia la dirección
`HTTP:` del resumen y entra con el PIN. Guárdala como favorito.

**Por HTTPS** (cifrado; se hace una sola vez):

1. Abre en el Nokia la dirección `Raíz TLS:` del resumen (`http://…/ca.cer`, en claro) y
   acepta instalar el certificado como **autoridad**.
2. A partir de ahí entra por la dirección `Nokia HTTPS:` (`https://…/`).

La raíz se crea la primera vez en `data/tls/ca.{key,pem,cer}` y el script no la vuelve a
tocar. **Haz una copia de `data/tls/`**: si se pierde o se regenera, el teléfono deja de
confiar en el servidor y hay que instalarla de nuevo. Los certificados del servidor
(`server-<host>.*`) sí se regeneran solos cuando cambia la dirección.

> El HTTPS propio de ngrok (`https://tu-dominio…`) no sirve: el Nokia no entiende TLS 1.2.
> Por eso el HTTPS del 6111 va por un túnel TCP hasta `nokia-tls`.

**Con ngrok gratuito la dirección HTTPS cambia** cada vez que ngrok se reinicia (al
reiniciar el PC, por ejemplo). `./scripts/standalone.sh status` avisa cuando pasa; vuelve a
ejecutar `./scripts/standalone.sh` y apunta el Nokia a la nueva dirección (si tienes Twilio
configurado, te la manda por SMS). La raíz instalada sigue valiendo.

### HTTPS con dirección fija (playit.gg)

Para no cambiar de dirección (y que NokiaMSN vea la IP real del teléfono):

1. En [playit.gg](https://playit.gg) instala su agente en el PC (servicio del sistema) y
   crea un túnel **TCP** hacia `127.0.0.1:8443`, con **PROXY protocol v1** activado.
2. En `.env`:

   ```env
   NOKIA_TLS_PROVIDER=playit
   NOKIA_TLS_PUBLIC_ADDRESS=algo.tun.ply.gg:12345
   ```

3. `./scripts/standalone.sh`: el resumen debe decir «HTTPS del Nokia comprobado».

### Uso del script

| Comando | Qué hace |
|---|---|
| `./scripts/standalone.sh` | Construye, arranca y expone (también `npm run standalone`) |
| `… --http` / `--https` / `--both` | Solo HTTP, solo HTTPS del Nokia, o las dos |
| `… --local` | Sin túneles: solo `http://127.0.0.1:3001/` |
| `… --no-build` | Arranca sin reconstruir las imágenes |
| `… -f` | Al terminar, se queda mostrando los logs |
| `… status` | Estado de los contenedores, de WhatsApp y de las direcciones |
| `… logs [servicio]` | Logs en directo (`nokia-msn`, `nokia-tls`, `ngrok`) |
| `… restart [servicio]` | Reinicia uno o todos |
| `… pin` | Cambia el PIN |
| `… stop` | Para todo |

Sin flag, qué se expone lo decide `EXPOSE_TUNNELS` del `.env` (`both` por defecto). Los
puertos locales se cambian con `NOKIA_MSN_PORT`, `NOKIA_TLS_PORT` y `NGROK_API_PORT`.

**Actualizar:** `git pull` y `./scripts/standalone.sh` (reconstruye lo que haya cambiado).

**Copia de seguridad:** `.env`, `data/` (base de datos y raíz TLS) y `.wwebjs_auth/`
(sesión de WhatsApp; sin ella hay que volver a vincular).

### Si algo falla

- **«No se puede hablar con Docker»**: arranca Docker (`sudo systemctl start docker`) o
  añade tu usuario al grupo `docker` y vuelve a iniciar sesión.
- **«Falta NGROK_AUTHTOKEN»**: sin token solo hay acceso local; revisa el paso 3.
- **ngrok no abre el túnel TCP** (cuentas nuevas pueden necesitar verificar una tarjeta
  para TCP): el script sigue solo con HTTP y lo dice. Usa HTTP o playit.
- **ngrok falla con «ERR_NGROK_108»** (límite de sesiones): la cuenta gratuita admite una
  sola sesión a la vez; cierra cualquier otro ngrok que use la misma cuenta.
- **WhatsApp no conecta** o el QR no aparece: `./scripts/standalone.sh logs nokia-msn`.
  Si la sesión se rompe, desvincula el dispositivo en el móvil y vuelve a escanear.
- **El Nokia dice que el certificado no es de confianza**: falta instalar `ca.cer` (paso 6)
  o se regeneró la raíz.

### Con GateWayNK

Si usas el stack de **GateWayNK** (carpeta hermana `../GateWayNK`), NokiaMSN no se arranca
con `standalone.sh` sino desde allí, y los túneles se configuran en `GateWayNK/Gateway/.env`
(las mismas claves: `NGROK_AUTHTOKEN`, `NGROK_HTTP_URL`, `NOKIA_TLS_PROVIDER`,
`NOKIA_TLS_PUBLIC_ADDRESS`, `EXPOSE_TUNNELS`). Desde este repo, `npm run expose` redirige a
`../GateWayNK/scripts/expose.sh` con los mismos argumentos:

```bash
npm run expose             # todo: HTTP + HTTPS
npm run expose -- --http   # solo HTTP
npm run expose -- --https  # solo HTTPS del Nokia
```

GateWayNK añade el watchdog (reinicia lo que se cuelga, actualiza solo la dirección HTTPS
de ngrok y avisa por SMS), copias de seguridad y un panel de estado. No arranques
`standalone.sh` a la vez: comparten la sesión de WhatsApp y los puertos.

## Desarrollo

```bash
npm install
npm run dev     # nodemon; fuera de Docker define DB_PATH=./data/nokia.db en .env
npm test        # tests con node --test
```

`docker compose up` con el `docker-compose.yml` de este repo levanta solo la app en
`127.0.0.1:3001`, sin túneles ni HTTPS (los perfiles `tls` y `ngrok` los activa
`scripts/standalone.sh`).

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
scripts/        arranque (standalone.sh, expose.sh → GateWayNK), migraciones, prueba de TLS
data/           base de datos, avatares y certificados (no se sube a git)
.wwebjs_auth/   sesión de WhatsApp (no se sube a git)
```
