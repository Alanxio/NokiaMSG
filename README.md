# NokiaMSG

## Transcripcion de audios

Las notas de voz y audios se transcriben automaticamente al recibirlos. La transcripcion
en castellano/valenciano se guarda junto al mensaje y aparece en sus detalles; los audios
anteriores se transcriben automaticamente al abrir sus detalles.

Configura `GROQ_API_KEY` en el archivo `.env` y reinicia NokiaMSN. La imagen Docker instala
`ffmpeg` (incluye `ffprobe`), necesario para preparar los audios antes de enviarlos a Groq.

Para probar la transcripcion con un audio hablado, configura `GROQ_API_KEY` en `.env` y
ejecuta `AUDIO_TEST_FILE=/ruta/al/audio npm test`. La prueba llama a Groq y valida el
resultado completo; se omite si falta la clave o `AUDIO_TEST_FILE`.

Para mantener las descargas compatibles con cambios recientes de WhatsApp Web, NokiaMSN
usa el commit fijado de `whatsapp-web.js` en `package.json` y carga la versión web actual
sin reutilizar HTML cacheado.

## Fotos de visualización única

Cuando llega una foto de visualización única, NokiaMSN muestra el aviso
`[Foto de visualización única]` en la conversación y conserva cualquier texto adjunto.
No descarga ni guarda la imagen; para verla hay que usar el dispositivo principal de
WhatsApp.

## Avisos de llamadas de WhatsApp

Las llamadas entrantes individuales y grupales quedan registradas como avisos de sistema
dentro de su chat. Si las notificaciones SMS están activadas y Twilio está configurado,
cualquier llamada de un chat no silenciado genera su propio SMS, aunque haya mensajes sin
leer o NokiaMSN esté abierto. El SMS individual prioriza el número personal que WhatsApp
resuelve para el contacto antes de recurrir al número del identificador; el de grupo
identifica la llamada como grupal.
