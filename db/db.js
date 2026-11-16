import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const DB_PATH = process.env.DB_PATH || '/data/nokia.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const directoryNameReplacements = [
  ['Á', 'a'], ['á', 'a'], ['É', 'e'], ['é', 'e'],
  ['Í', 'i'], ['í', 'i'], ['Ó', 'o'], ['ó', 'o'],
  ['Ú', 'u'], ['ú', 'u'], ['Ü', 'u'], ['ü', 'u'],
  ['Ñ', 'n{'], ['ñ', 'n{'], ['Ç', 'c'], ['ç', 'c'],
];
function directoryNameSortKey(column) {
  const translated = directoryNameReplacements.reduce(
    (expression, [from, to]) => `replace(${expression}, '${from}', '${to}')`,
    column
  );
  return `lower(${translated})`;
}
const userDirectorySortKey = directoryNameSortKey('username');
const groupDirectorySortKey = directoryNameSortKey('group_name');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    name_priority INTEGER DEFAULT 0,
    unseen_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wgroups (
    group_id TEXT PRIMARY KEY,
    group_name TEXT,
    unseen_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT,
    day_send TEXT,
    hour_send TEXT,
    from_me INTEGER DEFAULT 0,
    user_chat_id TEXT,
    group_id TEXT,
    has_media INTEGER DEFAULT 0,
    is_sticker INTEGER DEFAULT 0,
    media_key TEXT,
    whatsapp_msg_id TEXT UNIQUE,
    FOREIGN KEY (user_chat_id) REFERENCES users(chat_id),
    FOREIGN KEY (group_id) REFERENCES wgroups(group_id)
  );

  CREATE TABLE IF NOT EXISTS group_participants (
    user_chat_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    PRIMARY KEY (user_chat_id, group_id),
    FOREIGN KEY (user_chat_id) REFERENCES users(chat_id),
    FOREIGN KEY (group_id) REFERENCES wgroups(group_id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    media_key TEXT,
    mime_type TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_path_full TEXT,
    file_path_view TEXT,
    file_path_thumb TEXT,
    album_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    local_id INTEGER NOT NULL,
    option_name TEXT NOT NULL,
    option_order INTEGER DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    option_id INTEGER NOT NULL,
    voter_chat_id TEXT NOT NULL,
    voted_at_ts INTEGER,
    FOREIGN KEY (option_id) REFERENCES poll_options(id)
  );

  -- Reacciones (una por persona y mensaje, como en WhatsApp). Solo se muestran.
  -- ON DELETE CASCADE: al borrar un chat o en la limpieza diaria se van con su mensaje.
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    reacted_at INTEGER,
    PRIMARY KEY (message_id, sender_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_chat_id ON messages(user_chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);
  CREATE INDEX IF NOT EXISTS idx_messages_media_key ON messages(media_key);
  DROP INDEX IF EXISTS idx_users_directory_order;
  DROP INDEX IF EXISTS idx_groups_directory_order;
  CREATE INDEX IF NOT EXISTS idx_users_directory_es_order
    ON users(${userDirectorySortKey} COLLATE NOCASE, chat_id);
  CREATE INDEX IF NOT EXISTS idx_groups_directory_es_order
    ON wgroups(${groupDirectorySortKey} COLLATE NOCASE, group_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_media_key ON attachments(media_key);
  CREATE INDEX IF NOT EXISTS idx_poll_options_message_id ON poll_options(message_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_options_message_local ON poll_options(message_id, local_id);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_option_id ON poll_votes(option_id);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_chat_id);
`);

// Migración suave: añadir columnas si la BD es antigua
try {
  db.exec(`ALTER TABLE attachments ADD COLUMN file_path_view TEXT`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN is_sticker INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN ack_status INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN sms_muted INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN name_priority INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE wgroups ADD COLUMN sms_muted INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN sms_notified INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE wgroups ADD COLUMN sms_notified INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN quoted_text TEXT`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN quoted_sender TEXT`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN is_system INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN media_type TEXT`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN transcription TEXT`);
} catch {
  // Columna ya existe, ignorar
}
try {
  // 1 si el mensaje (entrante, de grupo) menciona a esta cuenta: «@» en la bandeja.
  db.exec(`ALTER TABLE messages ADD COLUMN mentions_me INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}
try {
  db.exec(`ALTER TABLE attachments ADD COLUMN duration_sec INTEGER`);
} catch {
  // Columna ya existe, ignorar
}

export const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (chat_id, username, unseen_count)
    VALUES (?, ?, 0)
    ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username
  `),

  // Un dato de menor calidad no debe reemplazar un contacto guardado previamente.
  upsertUserNameIfPreferred: db.prepare(`
    INSERT INTO users (chat_id, username, name_priority, unseen_count)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = CASE WHEN excluded.name_priority >= users.name_priority THEN excluded.username ELSE users.username END,
      name_priority = MAX(users.name_priority, excluded.name_priority)
  `),

  getUserByChatId: db.prepare(`
    SELECT chat_id, username, name_priority, unseen_count, sms_muted, sms_notified FROM users WHERE chat_id = ? LIMIT 1
  `),

  getUserByUsername: db.prepare(`
    SELECT chat_id, username, unseen_count, sms_muted, sms_notified FROM users WHERE username = ? LIMIT 1
  `),

  incrementUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = unseen_count + 1 WHERE chat_id = ?
  `),

  resetUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = 0, sms_notified = 0 WHERE chat_id = ?
  `),

  setUserSmsMuted: db.prepare(`
    UPDATE users SET sms_muted = ? WHERE chat_id = ?
  `),

  setUserSmsNotified: db.prepare(`
    UPDATE users SET sms_notified = 1 WHERE chat_id = ?
  `),

  clearUserSmsNotified: db.prepare(`
    UPDATE users SET sms_notified = 0 WHERE chat_id = ?
  `),

  countMessagesByUserChatId: db.prepare(`
    SELECT COUNT(*) AS total FROM messages WHERE user_chat_id = ?
  `),

  getDmAttachmentsByUserChatId: db.prepare(`
    SELECT a.* FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE m.user_chat_id = ? AND m.group_id IS NULL
  `),

  deleteDmAttachmentsByUserChatId: db.prepare(`
    DELETE FROM attachments WHERE message_id IN (
      SELECT id FROM messages WHERE user_chat_id = ? AND group_id IS NULL
    )
  `),

  // Las encuestas cuelgan de sus mensajes (FK sin ON DELETE CASCADE): se borran antes, o
  // borrar un chat con una encuesta falla con «FOREIGN KEY constraint failed».
  deleteDmPollVotesByUserChatId: db.prepare(`
    DELETE FROM poll_votes WHERE option_id IN (
      SELECT po.id FROM poll_options po
      JOIN messages m ON m.id = po.message_id
      WHERE m.user_chat_id = ? AND m.group_id IS NULL
    )
  `),

  deleteDmPollOptionsByUserChatId: db.prepare(`
    DELETE FROM poll_options WHERE message_id IN (
      SELECT id FROM messages WHERE user_chat_id = ? AND group_id IS NULL
    )
  `),

  deleteDmMessagesByUserChatId: db.prepare(`
    DELETE FROM messages WHERE user_chat_id = ? AND group_id IS NULL
  `),

  deleteParticipantsByUserChatId: db.prepare(`
    DELETE FROM group_participants WHERE user_chat_id = ?
  `),

  deleteUserRow: db.prepare(`
    DELETE FROM users WHERE chat_id = ?
  `),

  upsertGroup: db.prepare(`
    INSERT INTO wgroups (group_id, group_name, unseen_count)
    VALUES (?, ?, 0)
    ON CONFLICT(group_id) DO UPDATE SET group_name = excluded.group_name
  `),

  getGroupByName: db.prepare(`
    SELECT group_id, group_name, unseen_count, sms_muted, sms_notified FROM wgroups WHERE group_name = ? LIMIT 1
  `),

  getGroupById: db.prepare(`
    SELECT group_id, group_name, unseen_count, sms_muted, sms_notified FROM wgroups WHERE group_id = ? LIMIT 1
  `),

  incrementGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = unseen_count + 1 WHERE group_id = ?
  `),

  resetGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = 0, sms_notified = 0 WHERE group_id = ?
  `),

  setGroupSmsMuted: db.prepare(`
    UPDATE wgroups SET sms_muted = ? WHERE group_id = ?
  `),

  setGroupSmsNotified: db.prepare(`
    UPDATE wgroups SET sms_notified = 1 WHERE group_id = ?
  `),

  clearGroupSmsNotified: db.prepare(`
    UPDATE wgroups SET sms_notified = 0 WHERE group_id = ?
  `),

  getAttachmentsByGroupId: db.prepare(`
    SELECT a.* FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE m.group_id = ?
  `),

  deleteAttachmentsByGroupId: db.prepare(`
    DELETE FROM attachments WHERE message_id IN (
      SELECT id FROM messages WHERE group_id = ?
    )
  `),

  // Igual que en los chats individuales: encuestas antes que sus mensajes.
  deletePollVotesByGroupId: db.prepare(`
    DELETE FROM poll_votes WHERE option_id IN (
      SELECT po.id FROM poll_options po
      JOIN messages m ON m.id = po.message_id
      WHERE m.group_id = ?
    )
  `),

  deletePollOptionsByGroupId: db.prepare(`
    DELETE FROM poll_options WHERE message_id IN (
      SELECT id FROM messages WHERE group_id = ?
    )
  `),

  deleteMessagesByGroupId: db.prepare(`
    DELETE FROM messages WHERE group_id = ?
  `),

  deleteParticipantsByGroupId: db.prepare(`
    DELETE FROM group_participants WHERE group_id = ?
  `),

  deleteGroupRow: db.prepare(`
    DELETE FROM wgroups WHERE group_id = ?
  `),

  insertParticipant: db.prepare(`
    INSERT OR IGNORE INTO group_participants (user_chat_id, group_id) VALUES (?, ?)
  `),

  getParticipantsByGroupId: db.prepare(`
    SELECT u.chat_id, u.username
    FROM group_participants gp
    JOIN users u ON u.chat_id = gp.user_chat_id
    WHERE gp.group_id = ?
    ORDER BY u.username ASC
  `),

  insertMessage: db.prepare(`
    INSERT INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, media_key, whatsapp_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `),

  insertMessageWithMedia: db.prepare(`
    INSERT INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, media_key, whatsapp_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `),

  findMessageByWhatsappId: db.prepare(`
    SELECT id FROM messages WHERE whatsapp_msg_id = ? LIMIT 1
  `),

  // ¿Alguno de los últimos `unseen` mensajes del grupo (los no leídos) me menciona?
  groupHasUnreadMention: db.prepare(`
    SELECT 1 FROM (
      SELECT mentions_me FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?
    ) WHERE mentions_me = 1 LIMIT 1
  `),

  // Mensaje propio escrito desde otro dispositivo (móvil, WhatsApp Web…). Mismas columnas
  // que guarda saveInteraction, con from_me = 1; OR IGNORE + whatsapp_msg_id UNIQUE descartan
  // un segundo intento con el mismo mensaje.
  insertOwnMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, is_sticker, media_key, whatsapp_msg_id, quoted_text, quoted_sender, is_system, media_type)
    VALUES (@text, @day_send, @hour_send, 1, @user_chat_id, @group_id, @has_media, @is_sticker, @media_key, @whatsapp_msg_id, @quoted_text, @quoted_sender, 0, @media_type)
  `),

  // Fila enviada por el Nokia que se quedó sin whatsapp_msg_id (se perdió el enlace en
  // memoria, p. ej. por un reinicio justo al enviar): mismo chat, mismo texto, reciente.
  findUnlinkedOwnMessage: db.prepare(`
    SELECT id FROM messages
    WHERE from_me = 1 AND whatsapp_msg_id IS NULL AND text = @text AND hour_send >= @since
      AND ((@user_chat_id IS NOT NULL AND user_chat_id = @user_chat_id)
        OR (@group_id IS NOT NULL AND group_id = @group_id))
    ORDER BY id DESC LIMIT 1
  `),

  updateMessageAckByWhatsappId: db.prepare(`
    UPDATE messages SET ack_status = ? WHERE whatsapp_msg_id = ? AND ack_status < ?
  `),

  setMessageWhatsappId: db.prepare(`
    UPDATE messages SET whatsapp_msg_id = ? WHERE id = ?
  `),

  setMessageMediaType: db.prepare(`
    UPDATE messages SET media_type = ? WHERE id = ?
  `),

  markMessageDeleted: db.prepare(`
    UPDATE messages SET is_deleted = 1 WHERE whatsapp_msg_id = ?
  `),

  markMessageEdited: db.prepare(`
    UPDATE messages SET text = ?, is_edited = 1 WHERE whatsapp_msg_id = ?
  `),

  getMessageById: db.prepare(`
    SELECT m.id, m.text, m.day_send, m.hour_send, m.from_me, m.has_media, m.media_key,
           u.username, u.chat_id AS user_chat_id,
           g.group_name, m.group_id
    FROM messages m
    LEFT JOIN users   u ON u.chat_id  = m.user_chat_id
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    WHERE m.id = ?
    LIMIT 1
  `),

  getRecentUsersWithUnseen: db.prepare(`
    SELECT u.chat_id, u.username, u.unseen_count, MAX(m.hour_send) AS last_message
    FROM messages m
    INNER JOIN users u ON u.chat_id = m.user_chat_id
    WHERE u.unseen_count > 0 AND m.group_id IS NULL
    GROUP BY u.chat_id
    ORDER BY last_message DESC
    LIMIT ?
  `),

  getRecentGroupsWithUnseen: db.prepare(`
    SELECT g.group_id, g.group_name, g.unseen_count, MAX(m.hour_send) AS last_message
    FROM messages m
    INNER JOIN wgroups g ON g.group_id = m.group_id
    WHERE g.unseen_count > 0
    GROUP BY g.group_id
    ORDER BY last_message DESC
    LIMIT ?
  `),

  getUserMessagesPaginated: db.prepare(`
    SELECT m.id, m.text, m.hour_send, m.from_me, m.has_media, m.is_sticker, m.ack_status,
           m.quoted_text, m.quoted_sender, m.whatsapp_msg_id, m.is_deleted, m.is_edited, m.is_system,
           m.media_type, m.group_id, m.day_send,
           g.group_name, u.username,
           a.file_path_thumb, a.file_path_full, a.file_name, a.duration_sec
    FROM messages m
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    LEFT JOIN users u ON u.chat_id = m.user_chat_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.user_chat_id = ? AND m.group_id IS NULL
    ORDER BY m.hour_send DESC, m.id DESC
    LIMIT ? OFFSET ?
  `),

  getGroupMessagesPaginated: db.prepare(`
    SELECT m.id, m.text, m.hour_send, m.from_me, m.has_media, m.is_sticker, m.ack_status,
           m.quoted_text, m.quoted_sender, m.whatsapp_msg_id, m.is_deleted, m.is_edited, m.is_system,
           m.media_type, m.group_id, m.day_send,
           u.username, u.chat_id AS user_chat_id, g.group_name,
           a.file_path_thumb, a.file_path_full, a.file_name, a.duration_sec
    FROM messages m
    LEFT JOIN users u ON u.chat_id = m.user_chat_id
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.group_id = ?
    ORDER BY m.hour_send DESC, m.id DESC
    LIMIT ? OFFSET ?
  `),

  getReplyMessageById: db.prepare(`
    SELECT m.id, m.text, m.from_me, m.whatsapp_msg_id, m.user_chat_id, m.group_id,
           m.is_deleted, m.has_media, m.is_sticker, m.media_type, u.username
    FROM messages m
    LEFT JOIN users u ON u.chat_id = m.user_chat_id
    WHERE m.id = ?
    LIMIT 1
  `),

  updateMessageQuote: db.prepare(`
    UPDATE messages SET quoted_text = ?, quoted_sender = ? WHERE id = ?
  `),

  countUserMessages: db.prepare(`
    SELECT COUNT(*) AS total FROM messages WHERE user_chat_id = ? AND group_id IS NULL
  `),

  countGroupMessages: db.prepare(`
    SELECT COUNT(*) AS total FROM messages WHERE group_id = ?
  `),

  getAllUsers: db.prepare(`
    SELECT u.chat_id, u.username, u.unseen_count FROM users u
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.user_chat_id = u.chat_id AND m.group_id IS NULL
    )
  `),

  countDirectoryUsers: db.prepare(`
    SELECT COUNT(*) AS total FROM users u
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.user_chat_id = u.chat_id AND m.group_id IS NULL
    )
  `),

  getDirectoryUsersPage: db.prepare(`
    SELECT u.chat_id, u.username, u.unseen_count FROM users u
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.user_chat_id = u.chat_id AND m.group_id IS NULL
    )
    ORDER BY ${userDirectorySortKey} COLLATE NOCASE, u.chat_id
    LIMIT ? OFFSET ?
  `),

  // Buscador de las listas: se filtra en JS (sin acentos ni mayúsculas), así que se
  // piden todas las filas del directorio sin paginar.
  getAllDirectoryUsers: db.prepare(`
    SELECT u.chat_id, u.username, u.unseen_count FROM users u
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.user_chat_id = u.chat_id AND m.group_id IS NULL
    )
  `),

  getAllDirectoryGroups: db.prepare(`
    SELECT group_id, group_name, unseen_count FROM wgroups
  `),

  countDirectoryGroups: db.prepare(`
    SELECT COUNT(*) AS total FROM wgroups
  `),

  getDirectoryGroupsPage: db.prepare(`
    SELECT group_id, group_name, unseen_count FROM wgroups
    ORDER BY ${groupDirectorySortKey} COLLATE NOCASE, group_id
    LIMIT ? OFFSET ?
  `),

  deleteMessagesOlderThan: db.prepare(`
    DELETE FROM messages WHERE hour_send IS NOT NULL AND hour_send <= ?
  `),

  // Tras borrar mensajes antiguos (limpieza diaria): los no leídos son los últimos mensajes
  // RECIBIDOS, así que el contador solo puede BAJAR hasta los recibidos que quedan; nunca
  // subir. Antes se ponía el total de mensajes del chat (propios y ya leídos incluidos), y
  // cada limpieza marcaba casi todos los chats como no leídos.
  adjustUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = MIN(unseen_count, (
      SELECT COUNT(*) FROM messages
      WHERE user_chat_id = users.chat_id AND group_id IS NULL AND from_me = 0
    )) WHERE chat_id = ?
  `),

  adjustGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = MIN(unseen_count, (
      SELECT COUNT(*) FROM messages WHERE group_id = wgroups.group_id AND from_me = 0
    )) WHERE group_id = ?
  `),

  deleteUsersWithoutMessages: db.prepare(`
    DELETE FROM users WHERE chat_id NOT IN (
      SELECT DISTINCT user_chat_id FROM messages WHERE user_chat_id IS NOT NULL
    )
  `),

  deleteGroupsWithoutMessages: db.prepare(`
    DELETE FROM wgroups WHERE group_id NOT IN (
      SELECT DISTINCT group_id FROM messages WHERE group_id IS NOT NULL
    )
  `),

  deleteParticipantsWithoutMessages: db.prepare(`
    DELETE FROM group_participants
    WHERE user_chat_id NOT IN (
      SELECT DISTINCT user_chat_id FROM messages WHERE user_chat_id IS NOT NULL
    )
    OR group_id NOT IN (
      SELECT DISTINCT group_id FROM messages WHERE group_id IS NOT NULL
    )
  `),

  // Stickers deduplicados: varios adjuntos comparten los mismos archivos (media_key
  // = hash del contenido), así que antes de borrar un archivo hay que ver si alguien
  // más lo sigue usando.
  getAttachmentByMediaKey: db.prepare(`
    SELECT media_key, mime_type, file_name, file_size, file_path_full, file_path_view, file_path_thumb
    FROM attachments WHERE media_key = ? ORDER BY id DESC LIMIT 1
  `),

  isMediaPathReferenced: db.prepare(`
    SELECT 1 FROM attachments
    WHERE file_path_full = @path OR file_path_view = @path OR file_path_thumb = @path
    LIMIT 1
  `),

  insertAttachment: db.prepare(`
    INSERT INTO attachments (message_id, media_key, mime_type, file_name, file_size, file_path_full, file_path_view, file_path_thumb, duration_sec, album_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  saveMessageTranscription: db.prepare(`
    UPDATE messages SET transcription = ? WHERE id = ?
  `),

  getAttachmentsByMessageId: db.prepare(`
    SELECT * FROM attachments WHERE message_id = ? ORDER BY album_order
  `),

  updateAttachmentPaths: db.prepare(`
    UPDATE attachments SET file_path_full = ?, file_path_thumb = ? WHERE id = ?
  `),

  markMessageHasMedia: db.prepare(`
    UPDATE messages SET has_media = 1 WHERE id = ?
  `),

  getAttachmentsByMessageCutoff: db.prepare(`
    SELECT a.id, a.file_path_full, a.file_path_view, a.file_path_thumb
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE m.hour_send IS NOT NULL AND m.hour_send <= ?
  `),

  deletePollVotesByMessageCutoff: db.prepare(`
    DELETE FROM poll_votes
    WHERE option_id IN (
      SELECT po.id
      FROM poll_options po
      JOIN messages m ON m.id = po.message_id
      WHERE m.hour_send IS NOT NULL AND m.hour_send <= ?
    )
  `),

  deletePollOptionsByMessageCutoff: db.prepare(`
    DELETE FROM poll_options
    WHERE message_id IN (
      SELECT id FROM messages WHERE hour_send IS NOT NULL AND hour_send <= ?
    )
  `),

  deleteAttachmentsByMessageCutoff: db.prepare(`
    DELETE FROM attachments
    WHERE message_id IN (
      SELECT id FROM messages WHERE hour_send IS NOT NULL AND hour_send <= ?
    )
  `),

  getMessageByIdWithMedia: db.prepare(`
    SELECT m.id, m.text, m.day_send, m.hour_send, m.from_me, m.has_media, m.is_sticker, m.media_key,
           m.media_type, m.whatsapp_msg_id, m.transcription, m.is_deleted, m.is_system,
           u.username, u.chat_id AS user_chat_id,
           g.group_name, m.group_id,
           a.file_path_full, a.file_path_view, a.file_path_thumb, a.mime_type, a.file_name, a.duration_sec
    FROM messages m
    LEFT JOIN users   u ON u.chat_id  = m.user_chat_id
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.id = ?
    LIMIT 1
  `),

  insertPollOption: db.prepare(`
    INSERT INTO poll_options (message_id, local_id, option_name, option_order)
    VALUES (?, ?, ?, ?)
  `),

  insertPollVote: db.prepare(`
    INSERT INTO poll_votes (option_id, voter_chat_id, voted_at_ts)
    VALUES (?, ?, ?)
  `),

  deleteVotesForVoterInPoll: db.prepare(`
    DELETE FROM poll_votes
    WHERE voter_chat_id = ? AND option_id IN (SELECT id FROM poll_options WHERE message_id = ?)
  `),

  getPollOptionByMessageAndLocalId: db.prepare(`
    SELECT * FROM poll_options WHERE message_id = ? AND local_id = ? LIMIT 1
  `),

  getPollOptionById: db.prepare(`
    SELECT * FROM poll_options WHERE id = ? LIMIT 1
  `),

  getPollOptionCountsByMessageId: db.prepare(`
    SELECT po.id AS option_id, po.local_id, po.option_name, po.option_order,
           COUNT(pv.id) AS vote_count
    FROM poll_options po
    LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.message_id = ?
    GROUP BY po.id
    ORDER BY po.option_order ASC
  `),

  getVotersForOption: db.prepare(`
    SELECT voter_chat_id, voted_at_ts FROM poll_votes WHERE option_id = ? ORDER BY voted_at_ts ASC
  `),

  resetAllUsersUnseen: db.prepare(`
    UPDATE users SET unseen_count = 0, sms_notified = 0
  `),

  resetAllGroupsUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = 0, sms_notified = 0
  `),

  getUsersWithUnseen: db.prepare(`
    SELECT chat_id FROM users WHERE unseen_count > 0
  `),

  getGroupsWithUnseen: db.prepare(`
    SELECT group_id FROM wgroups WHERE unseen_count > 0
  `),

  // sms_notified solo se resetea aquí cuando WhatsApp reporta el chat como leído (0) desde
  // otro dispositivo — si el valor que llega es mayor que 0 se deja tal cual, para no pisar
  // la marca de "ya avisé por SMS" que pone saveInteraction.
  updateUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = ?, sms_notified = CASE WHEN ? = 0 THEN 0 ELSE sms_notified END
    WHERE chat_id = ? OR chat_id LIKE ?
  `),

  updateGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = ?, sms_notified = CASE WHEN ? = 0 THEN 0 ELSE sms_notified END
    WHERE group_id = ?
  `),

  // Nombres conocidos, para delimitar exactamente las menciones al mostrarlas.
  getAllUsernames: db.prepare(`
    SELECT DISTINCT username FROM users WHERE username IS NOT NULL AND username != ''
  `),

  getUserByPhonePattern: db.prepare(`
    SELECT chat_id, username FROM users WHERE chat_id LIKE ? LIMIT 1
  `),

  // ── Reacciones ──
  // Mensaje por el id corto de WhatsApp (el tramo aleatorio de «fromMe_chat_ID[_autor]»),
  // para cuando el id completo de la reacción no coincide con el guardado (el chat puede
  // venir como @lid en uno y @c.us en otro). Ese tramo es único en la práctica.
  findMessageByShortId: db.prepare(`
    SELECT id FROM messages
    WHERE whatsapp_msg_id LIKE '%\\_' || @shortId ESCAPE '\\'
       OR whatsapp_msg_id LIKE '%\\_' || @shortId || '\\_%' ESCAPE '\\'
    ORDER BY id DESC LIMIT 1
  `),
  upsertReaction: db.prepare(`
    INSERT INTO message_reactions (message_id, sender_id, reaction, reacted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, sender_id) DO UPDATE SET
      reaction = excluded.reaction, reacted_at = excluded.reacted_at
  `),
  deleteReaction: db.prepare(`
    DELETE FROM message_reactions WHERE message_id = ? AND sender_id = ?
  `),
  // ids: JSON con la lista de ids de mensaje (una sola consulta para toda la página).
  getReactionsForMessages: db.prepare(`
    SELECT message_id, sender_id, reaction, reacted_at
    FROM message_reactions
    WHERE message_id IN (SELECT value FROM json_each(?))
    ORDER BY reacted_at, sender_id
  `),
  getReactionsForMessage: db.prepare(`
    SELECT r.sender_id, r.reaction, r.reacted_at, u.username, u.name_priority
    FROM message_reactions r
    LEFT JOIN users u ON u.chat_id = r.sender_id
    WHERE r.message_id = ?
    ORDER BY r.reacted_at, r.sender_id
  `),
};

// Cierre de la conexión (vuelca el WAL al fichero principal). Lo llama SOLO el apagado
// ordenado de src/index.js, como último paso: aquí no se registran manejadores de señales
// propios, porque un process.exit() desde este módulo cortaba el apagado de index.js antes
// de cerrar Chromium y el servidor HTTP. Idempotente: llamarlo dos veces no falla.
export function closeDb() {
  if (!db.open) return;
  try {
    db.close();
    console.log('[DB] Conexión SQLite cerrada.');
  } catch (err) {
    console.error('[DB] Error al cerrar SQLite:', err?.message || err);
  }
}

export default db;
