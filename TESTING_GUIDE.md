# 📋 Guía de Testing - Sistema de Mensajes Reparado

## ✅ Lo que se arregló

### 1. **Mensajes que vuelven a ser "unseen"** ✅ ARREGLADO
- **Antes:** `unseen_count` era solo un contador, al reiniciar se perdía el estado
- **Ahora:** Cada mensaje tiene un campo `seen` individual
- **Verificar:** 
  1. Ver un grupo/usuario (debe marcar todos como vistos)
  2. Recargar el navegador - los mensajes deben seguir marcados como vistos
  3. Recibir un nuevo mensaje - solo el nuevo debe aparecer como [!]

### 2. **Carga dinámica (solo cuando se recibe un mensaje)** ✅ ARREGLADO
- **Antes:** Solo capturaba mensajes cuando llegaban nuevos
- **Ahora:** Usuarios/grupos se crean automáticamente cuando se recibe el PRIMER mensaje
- **Ventaja:** No carga 1000 chats muertos, solo los que realmente importan
- **Verificar:**
  1. Iniciar el servidor
  2. Escanear QR para vincular WhatsApp
  3. /usuario y /grupo estarán vacíos
  4. Enviar/recibir un mensaje en WhatsApp
  5. Automáticamente se crea el usuario/grupo en BD
  6. Aparece en /usuario o /grupo con el nuevo mensaje

### 3. **Usuarios cambiando en grupos** ✅ ARREGLADO
- **Antes:** Los participantes solo se actualizaban cuando escribían
- **Ahora:** Se sincronizan cada 5 minutos automáticamente
- **Verificar:**
  1. Ver un grupo
  2. Revisar logs cada 5 minutos: "[whatsapp] 🔄 Sincronizando participantes de grupos..."
  3. Si alguien sale/entra del grupo en WhatsApp, debe actualizarse en 5 minutos

---

## 🧪 Escenarios de Testing

### Escenario 1: Inicialización del servidor
```
1. rm /data/nokia.db (borrar BD antigua si existe)
2. Iniciar servidor: npm start
3. Escanear QR
4. Acceder a /usuario o /grupo - deben estar VACÍOS
5. Enviar/recibir un mensaje en WhatsApp (en un chat cualquiera)
6. Inmediatamente aparece en /usuario o /grupo
```

### Escenario 2: Marcar como visto y no volver a aparecer
```
1. Acceder a /usuario/[chatId]
2. Ver todos los mensajes
3. Actualizar la página (F5)
4. Los mensajes DEBEN SEGUIR SIN EL [!] rojo
5. Esperar a recibir un nuevo mensaje en WhatsApp
6. Volver a /usuario/[chatId]
7. El último mensaje debe tener [!] rojo, los anteriores NO
```

### Escenario 3: Participantes en grupos
```
1. Recibir un mensaje de un grupo en WhatsApp
2. El grupo se crea automáticamente en BD
3. El usuario que envió el mensaje se crea automáticamente
4. Al recibir más mensajes de otros usuarios, se van agregando
5. Los participantes se agregan según quién escriba
```

### Escenario 4: Recibir nuevos mensajes
```
1. Tener el servidor corriendo
2. Recibir un mensaje en WhatsApp (grupo o usuario)
3. Sin recargar, ver en /usuario o /grupo que aparece el nuevo mensaje
4. Debe tener el [!] rojo indicando "nuevo"
5. Al hacer clic en la conversación, desaparece el [!]
```

---

## 📊 Cambios en la BD

### Tabla `messages` - Nuevo campo:
```sql
ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0;
```

### Nuevos Statements (en db.js):
- `markMessageAsSeenByUser(chatId)` - Marca todos los mensajes de un usuario como vistos
- `markMessageAsSeenByGroup(groupId)` - Marca todos los mensajes de un grupo como vistos  
- `recalculateUserUnseen(chatId)` - Recalcula el contador desde los no vistos
- `recalculateGroupUnseen(groupId)` - Recalcula el contador desde los no vistos

---

## 📝 Logs esperados al iniciar

```
[DB] Agregando columna seen a tabla messages...
[DB] ✓ Columna seen agregada correctamente.

[whatsapp] Cliente conectado y listo.
[whatsapp] 🔄 Modo dinámico: usuarios y grupos se crearán al recibir mensajes.

-- Cuando recibes un mensaje: --
[DB] Grupo: groupId=g_123 userChatId=u_456 msgId=1
(o)
[DB] Usuario: userChatId=u_456 msgId=1
```

---

## 🐛 Si algo falla

### El servidor no inicia
```bash
npm start 2>&1 | grep ERROR
```
Verifica que no haya errores de sintaxis en los archivos modificados.

### No se sincroniza metadatos de chats
- Revisar logs para "Error en sincronización"
- Verificar que WhatsApp Web está correctamente autenticado
- Revisar permisos en carpeta `/data/`

### unseen_count sigue siendo incorrecto
```bash
sqlite3 /data/nokia.db
SELECT chat_id, unseen_count FROM users;
```
Verifica que los valores sean coherentes con:
```sql
SELECT COUNT(*) FROM messages WHERE user_chat_id = '...' AND seen = 0;
```

---

## 🎯 Resumen de la solución

| Problema | Solución | Verificar |
|----------|----------|----------|
| Mensajes vuelven a ser unseen | Campo `seen` individual en BD | Al ver, marcan como `seen=1` y persisten |
| Carga 1000 chats muertos | Creación dinámica al recibir primer mensaje | BD vacía al iniciar, se llena según llegas mensajes |
| Usuarios cambian en grupos | Identificación por `chat_id` único, no por nombre | Búsqueda siempre por ID, no por username |
| unseen_count incorrecta | Recalcula desde `COUNT WHERE seen=0` | Valor coincide con mensajes sin ver |
| **Nuevos mensajes se guardan** | Se capturan vía evento `message_create` | Al recibir, aparece en /usuario o /grupo |
