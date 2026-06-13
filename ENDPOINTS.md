# Nokia Server

## Arranque

Con la configuracion actual de `.env`, el servidor debe arrancarse con Docker Compose:

```bash
docker compose up --build
```

Eso levanta:

- MySQL en el contenedor `mysqldb`
- La app Node en el contenedor `app`

Cuando este arriba, puedes abrir:

```text
http://localhost:8080
```

## Resumen de uso principal

**MacroDroid (bot)** captura notificaciones de WhatsApp y envía un POST:

```bash
POST /notificacion
Content-Type: application/json

{
  "title": "Juan",                    # Usuario o "Grupo:Usuario"
  "message": "Contenido del mensaje",
  "time": "14:30:00",                # Opcional
  "date": "2026-04-11"               # Opcional
}
```

El servidor:
- ✅ Crea usuarios/grupos automáticamente si no existen
- ✅ Guarda el mensaje con fecha y hora
- ✅ Incrementa el contador de mensajes no vistos
- ✅ Puede disparar un aviso al Nokia 6111 enviando un correo al buzón POP3
- ✅ Aparece en el Nokia en la lista "Ultimos mensajes"
- ✅ Desaparece al visitar ese usuario/grupo en el Nokia

## Notificaciones por correo para el Nokia 6111

El proyecto ya puede levantar un servidor de correo legacy local dentro de Docker Compose para hacer de buzón del Nokia:

- `SMTP` local del backend en `mailserver:3025`
- `POP3` legacy para el Nokia en el puerto público configurado en `POP3_PUBLIC_PORT`
- Un único buzón sandbox: `nokia@legacy.local`

Variables nuevas en `.env`:

```env
LEGACY_MAIL_DOMAIN=legacy.local
LEGACY_MAIL_USER=nokia
LEGACY_MAIL_PASS=nokianot
SMTP_PUBLIC_PORT=3025
POP3_PUBLIC_PORT=3110
GREENMAIL_API_PORT=8081

MAIL_NOTIFICATIONS_ENABLED=true
SMTP_HOST=mailserver
SMTP_PORT=3025
SMTP_SECURE=false
SMTP_IGNORE_TLS=true
SMTP_USER=nokia@legacy.local
SMTP_PASS=nokianot
SMTP_FROM=nokia@legacy.local
SMTP_TO=nokia@legacy.local
SMTP_SUBJECT_PREFIX=[Nokia 6111]
SMTP_CONNECTION_TIMEOUT=10000
```

Notas:

- `SMTP_IGNORE_TLS=true` fuerza una conexión SMTP plana, sin negociar STARTTLS.
- El backend envía al contenedor `mailserver`, no a un hosting externo.
- El Nokia no puede usar el dominio HTTP de `ngrok` como servidor de correo.
- Para que el Nokia acceda desde fuera de tu red, necesitas exponer `POP3` y opcionalmente `SMTP` con puertos TCP reales o un túnel TCP.
- Si usas Docker Compose, reinicia la app tras cambiar `.env`.

### Ajustes del Nokia

Configuración recomendada para el Nokia 6111:

- Tipo de cuenta: `POP3`
- Servidor entrante: la IP pública o dominio TCP que apunte a tu máquina
- Puerto POP3: el valor de `POP3_PUBLIC_PORT` o `110` si haces un reenvío externo `110 -> 3110`
- Seguridad POP3: `sin SSL/TLS`
- Usuario: `nokia@legacy.local`
- Contraseña: `nokianot`

Para envío SMTP desde el backend ya no necesitas configurar nada en el Nokia.

### Limitación importante

`ngrok` en modo HTTP solo te sirve para:

- `http://.../notificacion`
- la interfaz XHTML del Nokia

No te sirve para POP3 ni SMTP. Para correo necesitas una de estas opciones:

- abrir y redirigir puertos TCP en tu router
- usar un túnel TCP real
- poner el proyecto en una VPS con puertos accesibles

## Exposicion publica con ngrok

Si el servidor ya esta corriendo en `localhost:8080`, abre el tunel con:

```bash
npm run tunnel
```

O si quieres arrancar app + tunel juntos fuera de Docker:

```bash
npm run expose
```

Nota:

- `npm run expose` solo te sirve si la app puede conectar a la base de datos desde tu maquina.
- Con tu `.env` actual, lo normal es usar `docker compose up --build` y luego `npm run tunnel`.
- Si `NGROK_HTTP_URL` esta vacio, ngrok normalmente te dara una URL `https://...`.

## Endpoints

### `GET /`

Página inicial. Muestra:
- **ESTADO SMARTPHONE**: Batería y conectividad del dispositivo principal
- **Últimos mensajes**: Los 10 últimos usuarios/grupos que enviaron mensajes (solo con contador > 0)

Ejemplo:

```text
http://localhost:8080/
```

Nota: Los usuarios/grupos desaparecen de la lista al visitar su página de mensajes.

### `GET /usuario`

Lista paginada de todos los usuarios.

Ejemplo:

```text
http://localhost:8080/usuario
http://localhost:8080/usuario?p=2
```

### `GET /usuario/:id`

Muestra los mensajes del usuario indicado. **Resetea el contador de mensajes no vistos a 0**.

Ejemplo:

```text
http://localhost:8080/usuario/1
http://localhost:8080/usuario/1?p=2
```

### `POST /usuario/:id/mensaje`

El bot envía un mensaje a un usuario específico e incrementa el contador de mensajes no vistos.

Ejemplo:

```bash
curl -X POST http://localhost:8080/usuario/1/mensaje \
  -H "Content-Type: application/json" \
  -d '{"text": "Hola desde el bot"}'
```

Respuesta:

```json
{
  "success": true,
  "message": "Mensaje creado"
}
```

### `GET /grupo`

Lista paginada de todos los grupos.

Ejemplo:

```text
http://localhost:8080/grupo
http://localhost:8080/grupo?p=2
```

### `GET /grupo/:id`

Muestra los mensajes del grupo indicado. **Resetea el contador de mensajes no vistos a 0**.

Ejemplo:

```text
http://localhost:8080/grupo/1
http://localhost:8080/grupo/1?p=2
```

### `POST /grupo/:id/mensaje`

El bot envía un mensaje a un grupo específico e incrementa el contador de mensajes no vistos.

Ejemplo:

```bash
curl -X POST http://localhost:8080/grupo/1/mensaje \
  -H "Content-Type: application/json" \
  -d '{"text": "Mensaje en grupo", "userId": 1}'
```

Parámetros:
- `text`: Contenido del mensaje (requerido)
- `userId`: ID del usuario que envía (opcional)

Respuesta:

```json
{
  "success": true,
  "message": "Mensaje creado en grupo"
}
```

### `POST /notificacion`

**PRINCIPAL - MacroDroid** envía notificaciones de WhatsApp capturadas. El servidor crea automáticamente usuarios/grupos si no existen.

Ejemplo usuario:

```bash
curl -X POST http://localhost:8080/notificacion \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Juan",
    "message": "Hola, cómo estás?",
    "time": "14:30:00",
    "date": "2026-04-11"
  }'
```

Ejemplo grupo:

```bash
curl -X POST http://localhost:8080/notificacion \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Amigos:Juan",
    "message": "Mensaje en grupo",
    "time": "14:35:00",
    "date": "2026-04-11"
  }'
```

Parámetros:
- `title`: Nombre del usuario O "NombreGrupo:NombreUsuario" para grupos (requerido)
- `message`: Contenido del mensaje (requerido)
- `time`: Hora en formato HH:MM:SS (opcional)
- `date`: Fecha en formato YYYY-MM-DD (opcional)

Respuesta usuario:

```json
{
  "success": true,
  "message": "Mensaje de usuario creado",
  "type": "user",
  "userId": 5,
  "messageId": 42,
  "emailNotification": {
    "status": "sent"
  }
}
```

Respuesta grupo:

```json
{
  "success": true,
  "message": "Mensaje de grupo creado",
  "type": "group",
  "groupId": 3,
  "userId": 5,
  "messageId": 43,
  "emailNotification": {
    "status": "sent"
  }
}
```

Notas:
- Si el correo está desactivado, `emailNotification.status` será `disabled`.
- Si falta configuración SMTP, `emailNotification.status` será `misconfigured`.
- Si guardar el mensaje funciona pero el SMTP falla, la API sigue guardando el mensaje y devuelve `emailNotification.status = failed`.

### `POST /notificacion/test-email`

Envía un correo de prueba al buzón configurado en `SMTP_TO`, sin crear mensajes en la base de datos. Sirve para validar primero el servidor SMTP y el Nokia.

Ejemplo:

```bash
curl -X POST http://localhost:8080/notificacion/test-email \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Prueba Nokia",
    "message": "Correo de prueba para comprobar el aviso",
    "type": "user"
  }'
```

Respuesta correcta:

```json
{
  "success": true,
  "emailNotification": {
    "status": "sent"
  }
}
```

### `GET /device-status`

Obtiene el estado actual del dispositivo principal (batería y conectividad).

Ejemplo:

```bash
curl http://localhost:8080/device-status
```

Respuesta:

```json
{
  "battery_level": 85,
  "network_type": "4G",
  "is_connected": true,
  "last_update": "2026-04-11 14:30:00"
}
```

### `POST /device-status`

El bot (MacroDroid) envía el estado del dispositivo principal. Se ejecuta **cada hora** o cuando cambia el estado.

Ejemplo:

```bash
curl -X POST http://localhost:8080/device-status \
  -H "Content-Type: application/json" \
  -d '{
    "battery_level": 85,
    "network_type": "4G",
    "is_connected": true
  }'
```

Parámetros:
- `battery_level`: Nivel de batería 0-100 (requerido)
- `network_type`: "WiFi", "4G", "3G", "2G", "LTE", etc. (opcional)
- `is_connected`: true si hay conexión, false si no (opcional, default: true)

Respuesta:

```json
{
  "success": true,
  "message": "Estado del dispositivo actualizado"
}
```

## Flujo recomendado

1. Arranca la app:

```bash
docker compose up --build
```

2. Comprueba localmente:

```text
http://localhost:8080
```

3. Prueba el correo sandbox:

```bash
curl -X POST http://localhost:8080/notificacion/test-email \
  -H "Content-Type: application/json" \
  -d '{"title":"Prueba Nokia","message":"Correo de prueba para el buzón local","type":"user"}'
```

4. Si quieres compartir la web fuera:

```bash
npm run tunnel
```

5. Usa la URL publica que te devuelva ngrok para HTTP.

6. Para que el Nokia reciba correo desde fuera, expón también POP3 por TCP.

## Errores habituales

### No conecta a MySQL

Si arrancas con `npm start` directamente en tu maquina, la app no encontrara `mysqldb`, porque ese host solo existe dentro de Docker Compose.

### ngrok no arranca

Revisa que exista en `.env`:

```env
NGROK_AUTHTOKEN=tu_token
```

### Quiero HTTP publico y no HTTPS

Para eso necesitas configurar una URL HTTP valida en ngrok. Si no defines `NGROK_HTTP_URL`, lo normal es obtener una URL publica `https://...`.
