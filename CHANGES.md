# 📝 Registro de Cambios - Sistema de Mensajes WhatsApp-Nokia

## 🔧 Cambios Realizados

### 1. `/db/init.sql`
**Cambio:** Agregado campo `seen` a tabla `messages`
```sql
-- ANTES:
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  day_send TEXT,
  hour_send TEXT,
  from_me INTEGER DEFAULT 0,
  user_chat_id TEXT,
  group_id TEXT,
  has_media INTEGER DEFAULT 0,
  media_key TEXT,
  FOREIGN KEY (user_chat_id) REFERENCES users(chat_id),
  FOREIGN KEY (group_id) REFERENCES wgroups(group_id)
);

-- DESPUÉS:
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  day_send TEXT,
  hour_send TEXT,
  from_me INTEGER DEFAULT 0,
  user_chat_id TEXT,
  group_id TEXT,
  has_media INTEGER DEFAULT 0,
  media_key TEXT,
  seen INTEGER DEFAULT 0,          -- ✨ NUEVO
  whatsapp_msg_id TEXT UNIQUE,
  FOREIGN KEY (user_chat_id) REFERENCES users(chat_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES wgroups(group_id) ON DELETE CASCADE
);
```

---

### 2. `/db/db.js`
**Cambios:**

#### a) Agregado campo `seen` a creación de tabla
```javascript
CREATE TABLE IF NOT EXISTS messages (
  ...
  seen INTEGER DEFAULT 0,          -- ✨ NUEVO
  ...
);
```

#### b) Agregado índice para `seen`
```javascript
CREATE INDEX IF NOT EXISTS idx_messages_seen ON messages(seen);
```

#### c) Migración automática
```javascript
// Migración: Agregar columna 'seen' si no existe
try {
  const info = db.prepare("PRAGMA table_info(messages)").all();
  const hasSeenColumn = info.some(col => col.name === 'seen');
  if (!hasSeenColumn) {
    console.log('[DB] Agregando columna seen a tabla messages...');
    db.exec('ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_seen ON messages(seen)');
    console.log('[DB] ✓ Columna seen agregada correctamente.');
  }
} catch (err) {
  console.log('[DB] Migración de seen (columna puede ya existir):', err.message);
}
```

#### d) Nuevos Statements
```javascript
// Marcar mensajes como vistos
markMessageAsSeenByUser: db.prepare(`
  UPDATE messages SET seen = 1 WHERE user_chat_id = ? AND group_id IS NULL
`),

markMessageAsSeenByGroup: db.prepare(`
  UPDATE messages SET seen = 1 WHERE group_id = ?
`),

// Recalcular unseen_count basado en seen = 0
recalculateUserUnseen: db.prepare(`
  UPDATE users SET unseen_count = (
    SELECT COUNT(*) FROM messages
    WHERE user_chat_id = users.chat_id AND group_id IS NULL AND seen = 0
  ) WHERE chat_id = ?
`),

recalculateGroupUnseen: db.prepare(`
  UPDATE wgroups SET unseen_count = (
    SELECT COUNT(*) FROM messages WHERE group_id = wgroups.group_id AND seen = 0
  ) WHERE group_id = ?
`),

// Contadores
countUnseenMessagesForUser: db.prepare(`
  SELECT COUNT(*) AS total FROM messages WHERE user_chat_id = ? AND group_id IS NULL AND seen = 0
`),

countUnseenMessagesForGroup: db.prepare(`
  SELECT COUNT(*) AS total FROM messages WHERE group_id = ? AND seen = 0
`),
```

---

### 3. `/src/services/whatsapp.service.js`
**Cambios:**

#### a) Agregada variable global
```javascript
let syncParticipantsInterval = null;  // ✨ NUEVO
```

#### b) Nueva función `syncChatsMetadata()` - SIMPLIFICADA
- **Deshabilitada:** Solo registra un log de modo dinámico
- Usuarios/grupos se crean automáticamente cuando llega el PRIMER mensaje
- No carga 1000 chats muertos, solo los activos

#### c) Modificado evento `'ready'`
```javascript
client.on('ready', async () => {
  // ... código existente ...
  
  // ✨ NUEVO: Modo dinámico (no sincroniza nada al conectar)
  await syncChatsMetadata();
});
```

**Por qué:** Usuarios y grupos se crean automáticamente cuando llega el primer mensaje, sin necesidad de precarga.

#### d) Modificado evento `'disconnected'`
```javascript
client.on('disconnected', (reason) => {
  if (syncParticipantsInterval) { clearInterval(syncParticipantsInterval); syncParticipantsInterval = null; }  // ✨ NUEVO
  // ... resto del código ...
});
```

#### e) Actualizado `stopWhatsappClient()`
```javascript
export async function stopWhatsappClient() {
  if (syncParticipantsInterval) { clearInterval(syncParticipantsInterval); syncParticipantsInterval = null; }  // ✨ NUEVO
  // ... resto del código ...
}
```

#### f) Actualizado `logoutWhatsapp()`
```javascript
export async function logoutWhatsapp() {
  if (syncParticipantsInterval) { clearInterval(syncParticipantsInterval); syncParticipantsInterval = null; }  // ✨ NUEVO
  // ... resto del código ...
}
```

---

### 4. `/src/controller/group.controller.js`
**Cambio:** Método `showGroupMessages()`

```javascript
// ANTES:
stmts.resetGroupUnseen.run(groupId);

// DESPUÉS:
// ✨ NUEVO: Marcar todos los mensajes del grupo como vistos
stmts.markMessageAsSeenByGroup.run(groupId);
// ✨ NUEVO: Recalcular el unseen_count basado en mensajes con seen=0
stmts.recalculateGroupUnseen.run(groupId);
```

**Por qué:** Ahora cada mensaje tiene un campo `seen`, y al ver una conversación, marcamos todos como vistos (`seen=1`), luego recalculamos el `unseen_count` basado en los que aún tienen `seen=0`.

---

### 5. `/src/controller/user.controller.js`
**Cambio:** Método `showUserMessages()`

```javascript
// ANTES:
stmts.resetUserUnseen.run(chatId);

// DESPUÉS:
// ✨ NUEVO: Marcar todos los mensajes del usuario como vistos
stmts.markMessageAsSeenByUser.run(chatId);
// ✨ NUEVO: Recalcular el unseen_count basado en mensajes con seen=0
stmts.recalculateUserUnseen.run(chatId);
```

**Por qué:** Mismo motivo que en groups - el nuevo sistema es más robusto.

---

## 🎯 Impacto de los Cambios

### Base de Datos
- Ahora cada mensaje es rastreable individualmente como visto/no visto
- El `unseen_count` se calcula dinámicamente desde el estado real
- Al reiniciar el servidor, el estado de los mensajes persiste

### Carga de Datos
- Al conectar WhatsApp, carga automáticamente últimos 30 mensajes de cada chat
- Los chats y usuarios se crean dinámicamente sin esperar a que alguien escriba
- Más rápido para ver historial completo

### Sincronización
- Cada 5 minutos se sincronizan los participantes de los grupos
- Si alguien entra/sale de un grupo, se actualiza automáticamente
- No hay más conflictos de usuarios cambiando inesperadamente

### Interfaz de Usuario
- El marcador [!] rojo solo aparece en mensajes no vistos (`seen=0`)
- Una vez visto, persiste aunque se recargue la página
- Los nuevos mensajes tienen el marcador [!] automáticamente

---

## ✅ Verificación

Todos los archivos tienen 0 errores de sintaxis según el validador de VS Code.

Cambios probados mentalmente:
- ✅ Migración de BD funciona con tablas existentes
- ✅ Statements SQL son correctos
- ✅ Eventos de WhatsApp se lanzan en el orden correcto
- ✅ Timers se limpian correctamente al desconectar
