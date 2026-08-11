import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const DB_PATH = process.env.DB_PATH || '/data/nokia.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_messages_user_chat_id ON messages(user_chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);
  CREATE INDEX IF NOT EXISTS idx_messages_media_key ON messages(media_key);
  CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_media_key ON attachments(media_key);
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
  db.exec(`ALTER TABLE wgroups ADD COLUMN sms_muted INTEGER DEFAULT 0`);
} catch {
  // Columna ya existe, ignorar
}

export const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (chat_id, username, unseen_count)
    VALUES (?, ?, 0)
    ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username
  `),

  getUserByChatId: db.prepare(`
    SELECT chat_id, username, unseen_count, sms_muted FROM users WHERE chat_id = ? LIMIT 1
  `),

  getUserByUsername: db.prepare(`
    SELECT chat_id, username, unseen_count, sms_muted FROM users WHERE username = ? LIMIT 1
  `),

  updateUserChatId: db.prepare(`
    UPDATE users SET chat_id = ? WHERE chat_id = ?
  `),

  incrementUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = unseen_count + 1 WHERE chat_id = ?
  `),

  resetUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = 0 WHERE chat_id = ?
  `),

  setUserSmsMuted: db.prepare(`
    UPDATE users SET sms_muted = ? WHERE chat_id = ?
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
    SELECT group_id, group_name, unseen_count, sms_muted FROM wgroups WHERE group_name = ? LIMIT 1
  `),

  getGroupById: db.prepare(`
    SELECT group_id, group_name, unseen_count, sms_muted FROM wgroups WHERE group_id = ? LIMIT 1
  `),

  incrementGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = unseen_count + 1 WHERE group_id = ?
  `),

  resetGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = 0 WHERE group_id = ?
  `),

  setGroupSmsMuted: db.prepare(`
    UPDATE wgroups SET sms_muted = ? WHERE group_id = ?
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

  updateMessageAckByWhatsappId: db.prepare(`
    UPDATE messages SET ack_status = ? WHERE whatsapp_msg_id = ? AND ack_status < ?
  `),

  insertMessageSafe: db.prepare(`
    INSERT OR IGNORE INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, media_key, whatsapp_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           g.group_name,
           a.file_path_thumb
    FROM messages m
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.user_chat_id = ? AND m.group_id IS NULL
    ORDER BY m.hour_send DESC, m.id DESC
    LIMIT ? OFFSET ?
  `),

  getGroupMessagesPaginated: db.prepare(`
    SELECT m.id, m.text, m.hour_send, m.from_me, m.has_media, m.is_sticker, m.ack_status,
           u.username, u.chat_id AS user_chat_id,
           a.file_path_thumb
    FROM messages m
    LEFT JOIN users u ON u.chat_id = m.user_chat_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.group_id = ?
    ORDER BY m.hour_send DESC, m.id DESC
    LIMIT ? OFFSET ?
  `),

  getAllMessagesPaginated: db.prepare(`
    SELECT m.id, m.text, m.hour_send, m.from_me,
           u.username, g.group_name
    FROM messages m
    LEFT JOIN users   u ON u.chat_id  = m.user_chat_id
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    ORDER BY m.hour_send DESC, m.id DESC
    LIMIT ? OFFSET ?
  `),

  countUserMessages: db.prepare(`
    SELECT COUNT(*) AS total FROM messages WHERE user_chat_id = ? AND group_id IS NULL
  `),

  countGroupMessages: db.prepare(`
    SELECT COUNT(*) AS total FROM messages WHERE group_id = ?
  `),

  countAllMessages: db.prepare(`
    SELECT COUNT(*) AS total FROM messages
  `),

  getAllUsers: db.prepare(`
    SELECT u.chat_id, u.username, u.unseen_count FROM users u
    WHERE EXISTS (
      SELECT 1 FROM messages m WHERE m.user_chat_id = u.chat_id AND m.group_id IS NULL
    )
  `),

  getAllGroups: db.prepare(`
    SELECT group_id, group_name, unseen_count FROM wgroups
  `),

  deleteMessagesOlderThan: db.prepare(`
    DELETE FROM messages WHERE hour_send IS NOT NULL AND hour_send <= ?
  `),

  adjustUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = (
      SELECT COUNT(*) FROM messages
      WHERE user_chat_id = users.chat_id AND group_id IS NULL
    ) WHERE chat_id = ?
  `),

  adjustGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = (
      SELECT COUNT(*) FROM messages WHERE group_id = wgroups.group_id
    ) WHERE group_id = ?
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

  insertAttachment: db.prepare(`
    INSERT INTO attachments (message_id, media_key, mime_type, file_name, file_size, file_path_full, file_path_view, file_path_thumb, album_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getLastMessageWithMedia: db.prepare(`
    SELECT m.id, m.text, m.has_media, a.file_path_thumb, a.mime_type
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.user_chat_id = ? AND m.group_id IS NULL
    ORDER BY m.id DESC LIMIT 1
  `),

  getLastGroupMessageWithMedia: db.prepare(`
    SELECT m.id, m.text, m.has_media, a.file_path_thumb, a.mime_type
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.group_id = ?
    ORDER BY m.id DESC LIMIT 1
  `),

  getAttachmentsByMediaKey: db.prepare(`
    SELECT * FROM attachments WHERE media_key = ? ORDER BY album_order
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

  getAttachmentsByCreatedAt: db.prepare(`
    SELECT id, file_path_full, file_path_view, file_path_thumb, file_name, created_at
    FROM attachments
    WHERE created_at < (CAST(strftime('%s', 'now') AS INTEGER) - ?)
  `),

  updateAttachmentMessageId: db.prepare(`
    UPDATE attachments SET message_id = ? WHERE id = ?
  `),

  getMessageByIdWithMedia: db.prepare(`
    SELECT m.id, m.text, m.day_send, m.hour_send, m.from_me, m.has_media, m.is_sticker, m.media_key,
           u.username, u.chat_id AS user_chat_id,
           g.group_name, m.group_id,
           a.file_path_full, a.file_path_view, a.file_path_thumb, a.mime_type
    FROM messages m
    LEFT JOIN users   u ON u.chat_id  = m.user_chat_id
    LEFT JOIN wgroups g ON g.group_id = m.group_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.id = ?
    LIMIT 1
  `),

  getAlbumAttachments: db.prepare(`
    SELECT a.* FROM attachments a
    INNER JOIN messages m ON m.id = a.message_id
    WHERE m.media_key = ? AND m.media_key IS NOT NULL
    ORDER BY a.album_order
  `),

  // Añade esto justo al final de tu objeto stmts en db.js
  markMessageAsSeenByUser: db.prepare(`
    UPDATE messages SET from_me = 1 WHERE user_chat_id = ? AND from_me = 0
  `), // Nota: Como no tienes columna 'seen', esto es un ejemplo. Si no usas 'seen', mejor usa la Opción 1.

  recalculateUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = 0 WHERE chat_id = ?
  `),

  resetAllUsersUnseen: db.prepare(`
    UPDATE users SET unseen_count = 0
  `),

  resetAllGroupsUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = 0
  `),

  getUsersWithUnseen: db.prepare(`
    SELECT chat_id FROM users WHERE unseen_count > 0
  `),

  getGroupsWithUnseen: db.prepare(`
    SELECT group_id FROM wgroups WHERE unseen_count > 0
  `),

  updateUserUnseen: db.prepare(`
    UPDATE users SET unseen_count = ? WHERE chat_id = ? OR chat_id LIKE ?
  `),

  updateGroupUnseen: db.prepare(`
    UPDATE wgroups SET unseen_count = ? WHERE group_id = ?
  `),

  getUserByPhonePattern: db.prepare(`
    SELECT chat_id, username FROM users WHERE chat_id LIKE ? LIMIT 1
  `),
};

// Cierre seguro de la base de datos para evitar corrupción del modo WAL
process.on('SIGINT', () => {
  console.log('[DB] Cerrando conexión SQLite (SIGINT)...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[DB] Cerrando conexión SQLite (SIGTERM)...');
  db.close();
  process.exit(0);
});

export default db;