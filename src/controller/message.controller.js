import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { escapeXml, formatPhoneNumber, isNumericOrJid, renderMediaLine, renderMentions, renderPhoneLink, sendPage } from './page.controller.js';
import { processAndAttachMedia } from '../utils/media.js';
import multer from 'multer';
import pkg from 'whatsapp-web.js';

const { MessageMedia } = pkg;

function normalizeGroupName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return null;
  }
  const trimmed = rawName.trim();
  if (isNumericOrJid(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 100);
}

// Asegúrate de que esta ruta apunte correctamente a donde exportas el cliente
import { client, resolveContactPhone } from '../services/whatsapp.service.js';
import { ensureGroupDisplayName } from './group.controller.js';
import { registerPendingOutgoing } from '../services/pending-outgoing.service.js';

const EXISTING_CONTACT_ICON_HTML = '<img src="/assets/user.jpeg" alt="Contacto" height="14" width="18" style="vertical-align:5px; margin-top:-5px; margin-bottom:-5px;" />';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imagenes JPG o PNG'), false);
    }
  },
});

export async function renderComposePage(req, res, next) {
  try {
    const { q, to, type } = req.query;

    // =========================================================================
    // CASO 1: FORMULARIO DE ESCRITURA (Estilo clásico limpio)
    // =========================================================================
    if (to && type) {
      let destinoNombre = to;
      let urlCancelar = '/';

      const textoPrevio = req.query.text || '';

      if (type === 'user') {
        const u = db.prepare('SELECT username FROM users WHERE chat_id = ?').get(to);
        if (u) {
          destinoNombre = u.username;
          urlCancelar = `/usuario/${encodeURIComponent(to)}`;
        } else {
          urlCancelar = '/usuario';
        }
      } else if (type === 'group') {
        const g = db.prepare('SELECT group_id, group_name FROM wgroups WHERE group_id = ?').get(to);
        if (g) {
          const resolvedGroup = await ensureGroupDisplayName(g);
          destinoNombre = resolvedGroup.group_name;
          urlCancelar = `/grupo/${encodeURIComponent(to)}`;
        } else {
          urlCancelar = '/grupo';
        }
      }

      let body = `<h1>Para: ${escapeXml(destinoNombre)}</h1>`;

      if (type === 'group') {
        try {
          const participants = db.prepare(`
            SELECT DISTINCT u.chat_id, u.username FROM group_participants gp
            JOIN users u ON u.chat_id = gp.user_chat_id
            WHERE gp.group_id = ? AND u.username IS NOT NULL AND u.username != ''
            ORDER BY u.username ASC
            LIMIT 15
          `).all(to);

          if (participants && participants.length > 0) {
            body += `<p><font size="1" color="#555555">Mencionar en grupo:</font><br/>`;
            body += participants.map(p => {
              const textWithMention = (textoPrevio ? textoPrevio + ' ' : '') + '@' + p.username + ' ';
              return `<a href="/mensaje/componer?to=${encodeURIComponent(to)}&type=group&text=${encodeURIComponent(textWithMention)}">@${escapeXml(p.username)}</a>`;
            }).join(' | ');
            body += `</p>`;
          }
        } catch (e) {}
      }

      body += `
        <form action="/mensaje/validar-y-crear" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="phone" value="${escapeXml(to)}"/>
          <input type="hidden" name="type" value="${escapeXml(type)}"/>
          <p>
            <textarea name="text" rows="5" cols="22">${escapeXml(textoPrevio)}</textarea>
          </p>
          <p>
            <input type="file" name="image" accept="image/jpeg,image/png"/>
          </p>
          <p>
            <input type="submit" value="Enviar"/> <a href="${urlCancelar}">Cancelar</a>
          </p>
        </form>
      `;

      sendPage(req, res, 200, 'Redactar', body);
      return;
    }

    // =========================================================================
    // CASO 2: PANTALLA DEL BUSCADOR DE CONTACTOS
    // =========================================================================
    let body = '<h1>Buscar en WhatsApp</h1>';
    body += '<p><a href="/">Inicio</a> | <a href="/usuario">Ver Contactos</a></p>';

    body += `
      <form action="/mensaje/componer" method="GET">
        <p><b>Buscar Nombre o Grupo:</b><br/>
          <input type="text" name="q" value="${escapeXml(q || '')}" size="15"/>
          <input type="submit" value="Buscar"/>
        </p>
      </form>
    `;

    if (q && q.trim() !== '') {
      const queryClean = q.trim().toLowerCase();
      body += '<h2>Resultados:</h2>';

      // client.getContacts()/getChats() serializan TODA la libreta a través de Puppeteer: en
      // una cuenta real pueden tardar mucho, quedarse colgados, o (getChats() en concreto,
      // confirmado en logs) reventar con el mismo "r: r" ya documentado para
      // groupMetadata/getChatById — frágil en general en este entorno. Antes esa excepción
      // se colaba sin capturar hasta el manejador de errores (página 500), que el navegador
      // WAP del Nokia no sabe mostrar bien ("respuesta desconocida"). Aquí se atrapa
      // cualquier fallo o lentitud y se sigue con lo que ya tengamos de la BD local, en vez
      // de dejar caer toda la petición.
      const withTimeout = (promise, ms) =>
        Promise.race([
          Promise.resolve(promise).catch((err) => {
            console.warn('[buscador] llamada en vivo a WhatsApp falló:', err?.name, err?.message);
            return null;
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), ms)),
        ]);

      // Búsqueda local primero: rápida y siempre disponible. `users.username` se rellena para
      // cualquiera que haya escrito alguna vez, sea por mensaje directo o dentro de un grupo
      // (ver upsertUser en notification.controller.js) — así encontramos también a gente sin
      // historial de mensajes directos, que es justo el caso que fallaba con solo
      // client.getContacts() (que solo conoce contactos guardados en la agenda del teléfono).
      const localMatches = db.prepare(`
        SELECT DISTINCT chat_id, username FROM users
        WHERE username IS NOT NULL AND username != '' AND LOWER(username) LIKE ?
        ORDER BY username ASC
        LIMIT 10
      `).all(`%${queryClean}%`);

      const localGroupMatches = db.prepare(`
        SELECT group_id, group_name FROM wgroups
        WHERE group_name IS NOT NULL AND group_name != '' AND LOWER(group_name) LIKE ?
        ORDER BY group_name ASC
        LIMIT 10
      `).all(`%${queryClean}%`);

      const allContacts = (await withTimeout(client.getContacts(), 8000)) || [];
      const uniqueContactsMap = new Map();

      function normalizeContactName(value) {
        return value ? String(value).trim().toLowerCase() : '';
      }

      function shouldPreferCandidate(existing, candidate) {
        if (existing.isBusiness && !candidate.isBusiness) return true;
        if (existing.isMyContact !== candidate.isMyContact) return candidate.isMyContact;
        if (existing.hasRealName !== candidate.hasRealName) return candidate.hasRealName;
        if (existing.isLid && !candidate.isLid) return true;
        return false;
      }

      allContacts.forEach(c => {
        if (c.isUser && !c.isMe && c.number) {
          const basePhone = c.number.split(':')[0].trim();
          const server = c.id && c.id.server ? c.id.server : 'c.us';
          const chatId = `${basePhone}@${server}`;
          const displayName = (c.name || c.pushname || c.shortName || `+${basePhone}`).trim();
          const dedupKey = c.name ? normalizeContactName(c.name) : basePhone;
          const candidate = {
            chatId,
            displayName,
            hasRealName: !!c.name,
            isBusiness: !!c.isBusiness,
            isMyContact: !!c.isMyContact,
            isLid: server === 'lid' || basePhone.length > 14,
          };

          if (!uniqueContactsMap.has(dedupKey)) {
            uniqueContactsMap.set(dedupKey, candidate);
          } else {
            const existingContact = uniqueContactsMap.get(dedupKey);
            if (shouldPreferCandidate(existingContact, candidate)) {
              uniqueContactsMap.set(dedupKey, candidate);
            }
          }
        }
      });

      const filteredContacts = Array.from(uniqueContactsMap.values()).filter(contact => {
        const nameLower = contact.displayName.toLowerCase();
        return nameLower.includes(queryClean) || contact.chatId.includes(queryClean);
      });

      // Añadir los resultados de la BD local que la vía en vivo no trajo (gente sin
      // historial de mensaje directo, o si getContacts() no respondió a tiempo), evitando
      // duplicar a alguien que ya haya salido por la vía en vivo (mismo chat_id o mismo
      // nombre).
      const liveChatIds = new Set(filteredContacts.map(c => c.chatId));
      const liveNames = new Set(filteredContacts.map(c => normalizeContactName(c.displayName)));
      localMatches.forEach(u => {
        if (liveChatIds.has(u.chat_id) || liveNames.has(normalizeContactName(u.username))) return;
        filteredContacts.push({
          chatId: u.chat_id,
          displayName: u.username,
          hasRealName: true,
          isBusiness: false,
          isMyContact: false,
          isLid: false,
        });
      });

      // Si la misma persona aparece con cuenta personal y de empresa bajo nombres distintos
      // (por lo que el deduplicado de arriba, que compara por nombre, no los une), priorizar
      // la personal: quien busca casi siempre quiere hablar con la persona, no con el número
      // de empresa. `sort` es estable, así que dentro de cada grupo se conserva el orden
      // original.
      filteredContacts.sort((a, b) => (a.isBusiness === b.isBusiness) ? 0 : (a.isBusiness ? 1 : -1));

      // Número de teléfono por resultado, mismo criterio que ya usa showGroupDetails en
      // group.controller.js: para @lid (id interno, no son dígitos de un número real) hace
      // falta resolverlo en vivo; para @c.us los dígitos ya están en el propio chat_id.
      await Promise.all(filteredContacts.map(async (contact) => {
        contact.phone = contact.chatId.endsWith('@lid')
          ? await resolveContactPhone(contact.chatId)
          : formatPhoneNumber(contact.chatId);
      }));

      // El icono de "contacto existente" indica que ya está en los Contactos del Nokia (la
      // BD local), es decir, que tiene historial de mensaje directo — el mismo criterio que
      // usa la lista de /usuario (getAllUsers). No usar "viene de la vía en vivo": alguien
      // como Olga puede existir en WhatsApp pero no estar todavía guardada como contacto en
      // el Nokia, y no debe llevar el icono aunque la búsqueda la haya encontrado en vivo.
      const candidateIds = filteredContacts.map(c => c.chatId);
      const existingContactIds = candidateIds.length > 0
        ? new Set(
            db.prepare(`
              SELECT DISTINCT user_chat_id FROM messages
              WHERE group_id IS NULL AND user_chat_id IN (${candidateIds.map(() => '?').join(',')})
            `).all(...candidateIds).map(r => r.user_chat_id)
          )
        : new Set();
      filteredContacts.forEach(contact => {
        contact.isExistingContact = existingContactIds.has(contact.chatId);
      });

      const allChats = (await withTimeout(client.getChats(), 8000)) || [];
      const filteredGroups = allChats.filter(c => {
        const groupName = (c.name || '').toLowerCase();
        return c.isGroup && groupName.includes(queryClean);
      });

      const liveGroupIds = new Set(filteredGroups.map(g => g.id._serialized));
      localGroupMatches.forEach(g => {
        if (liveGroupIds.has(g.group_id)) return;
        filteredGroups.push({
          id: { _serialized: g.group_id },
          name: g.group_name,
        });
      });

      let coincidenciaEncontrada = false;

      if (filteredContacts.length > 0) {
        coincidenciaEncontrada = true;
        body += '<h3>Contactos</h3>';
        filteredContacts.slice(0, 5).forEach(contact => {
          const iconHtml = contact.isExistingContact ? `${EXISTING_CONTACT_ICON_HTML} ` : '';
          const phoneHtml = contact.phone ? `<br/>${renderPhoneLink(contact.phone)}` : '';
          body += `<p>${iconHtml}• <a href="/mensaje/componer?to=${encodeURIComponent(contact.chatId)}&type=user"><b>${escapeXml(contact.displayName)}</b></a>${phoneHtml}</p>`;
        });
      }

      if (filteredGroups.length > 0) {
        coincidenciaEncontrada = true;
        body += '<h3>Grupos</h3>';
        filteredGroups.slice(0, 5).forEach(group => {
          const groupId = group.id._serialized;
          const displayGroupName = group.name || 'Grupo sin nombre';
          body += `<p>👥 <a href="/mensaje/componer?to=${encodeURIComponent(groupId)}&type=group"><b>${escapeXml(displayGroupName)}</b></a></p>`;
        });
      }

      if (!coincidenciaEncontrada) {
        body += '<p>No se encontraron resultados.</p>';
        const soloNumeros = queryClean.replace(/[^0-9]/g, '');
        if (soloNumeros.length >= 9) {
          body += `
            <form action="/mensaje/validar-y-crear" method="POST">
              <input type="hidden" name="phone" value="${soloNumeros}"/>
              <input type="hidden" name="type" value="user"/>
              <p>
                <textarea name="text" rows="3" cols="18"></textarea>
              </p>
              <input type="submit" value="Enviar"/>
            </form>
          `;
        }
      }
    }

    sendPage(req, res, 200, 'Buscador Live', body);
  } catch (error) {
    next(error);
  }
}

export async function validateAndCreateChat(req, res, next) {
  // ===========================================================================
  // 1. Procesar posible imagen adjunta con multer
  // ===========================================================================
  try {
    await new Promise((resolve, reject) => {
      upload.single('image')(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    let message = 'Error al procesar la imagen.';
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      message = 'La imagen es demasiado grande. Maximo 5 MB.';
    } else if (err.message === 'Solo se permiten imagenes JPG o PNG') {
      message = err.message;
    }
    return sendPage(
      req,
      res,
      400,
      'Error',
      `<p>${escapeXml(message)}</p><p><a href="/mensaje/componer">Volver</a></p>`
    );
  }

  try {
    const { phone, text, type } = req.body;
    const imageFile = req.file;

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    const hasText = trimmedText !== '';
    const hasImage = !!imageFile;

    if (!phone || (!hasText && !hasImage)) {
      return sendPage(
        req,
        res,
        400,
        'Error',
        '<p>Debes escribir un mensaje o adjuntar una imagen.</p><p><a href="/mensaje/componer">Volver</a></p>'
      );
    }

    let processedText = hasText ? convertEmojisToAscii(trimmedText) : '';

    let targetJid = phone.trim();

    if (!targetJid.includes('@')) {
      const numberDetails = await client.getNumberId(targetJid);
      if (!numberDetails) {
        return sendPage(
          req,
          res,
          400,
          'Error',
          '<h1>Error</h1><p>El número no tiene WhatsApp registrado.</p><p><a href="/mensaje/componer">Volver</a></p>'
        );
      }
      targetJid = numberDetails._serialized;
    }

    // =========================================================================
    // 2. Enviar mensaje de texto, imagen o imagen con caption
    // =========================================================================
    const options = {};
    if (type === 'group' || targetJid.endsWith('@g.us')) {
      const mentionRegex = /@[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü+\-:.]{2,}/g;
      const mentionMatches = processedText.match(mentionRegex);
      if (mentionMatches && mentionMatches.length > 0) {
        const mentionedJids = [];
        // Mapa texto-original -> "@<digitos>", que es el formato que WhatsApp
        // necesita en el cuerpo del mensaje para reconocer y resaltar la mención
        // en el dispositivo del destinatario (no basta con pasar `mentions`).
        const textReplacements = new Map();
        for (const match of mentionMatches) {
          if (textReplacements.has(match)) continue;
          const cleanName = match.slice(1).trim();
          const cleanDigits = cleanName.replace(/[^0-9]/g, '');
          let user = db.prepare('SELECT chat_id FROM users WHERE username = ? LIMIT 1').get(cleanName);
          if (!user && cleanDigits.length >= 8) {
            user = db.prepare('SELECT chat_id FROM users WHERE chat_id LIKE ? LIMIT 1').get(`${cleanDigits}%`);
          }
          if (user && user.chat_id) {
            if (!mentionedJids.includes(user.chat_id)) {
              mentionedJids.push(user.chat_id);
            }
            textReplacements.set(match, `@${user.chat_id.split('@')[0]}`);
          }
        }
        if (textReplacements.size > 0) {
          processedText = processedText.replace(mentionRegex, (m) => textReplacements.get(m) || m);
        }
        if (mentionedJids.length > 0) {
          options.mentions = mentionedJids;
        }
      }

      const existingGroup = stmts.getGroupById.get(targetJid);
      const existingIsRaw = existingGroup ? isNumericOrJid(existingGroup.group_name) : false;
      let nameToSave = existingGroup ? existingGroup.group_name : null;

      if (!nameToSave || existingIsRaw) {
        let candidateName = targetJid.replace(/@.*$/, '');
        if (client) {
          try {
            const chat = await client.getChatById(targetJid);
            if (chat?.name && !isNumericOrJid(chat.name)) {
              candidateName = chat.name;
            }
          } catch (e) {
            // Ignorar error de resolución de grupo.
          }
        }
        const normalizedName = normalizeGroupName(candidateName) || 'Grupo sin nombre';
        nameToSave = normalizedName;
      }

      if (!existingGroup || existingGroup.group_name !== nameToSave) {
        stmts.upsertGroup.run(targetJid, nameToSave);
      }
    }

    options.waitUntilMsgSent = true;

    let sentMessage = null;
    if (hasImage) {
      const media = new MessageMedia(
        imageFile.mimetype,
        imageFile.buffer.toString('base64'),
        imageFile.originalname
      );
      sentMessage = await client.sendMessage(targetJid, media, { ...options, caption: processedText });
    } else {
      sentMessage = await client.sendMessage(targetJid, processedText, options);
    }

    // En esta versión de whatsapp-web.js, client.sendMessage() puede no devolver el
    // Message con su id (el mensaje se manda bien de todos modos) — comprobado en vivo:
    // sin excepción, sin id. Si no llega aquí, se enlaza más tarde de forma asíncrona
    // cuando WhatsApp confirme el envío por su cuenta vía el evento message_create (ver
    // registerPendingOutgoing más abajo y su consumo en whatsapp.service.js).
    const whatsappMsgId = sentMessage?.id?._serialized || null;

    // CONTROL ESTRICTO DE FECHA/HORA EN FORMATO SQLITE ("YYYY-MM-DD HH:MM:SS")
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const pad = (n) => String(n).padStart(2, '0');
    const daySend = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hourSend = `${daySend} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const finalText = processedText || '[Imagen]';
    let urlDestino = '/';
    let insertedMessageId = null;

    if (type === 'group' || targetJid.endsWith('@g.us')) {
      const g = db.prepare('SELECT group_id FROM wgroups WHERE group_id = ?').get(targetJid);
      if (!g) {
        let groupName = 'Grupo sin nombre';
        try {
          const chat = await client.getChatById(targetJid);
          if (chat && chat.name) groupName = chat.name;
        } catch (e) {}
        stmts.upsertGroup.run(targetJid, groupName);
      }
      if (hasImage) {
        const result = stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, null, targetJid, null, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      } else {
        const result = stmts.insertMessage.run(finalText, daySend, hourSend, 1, null, targetJid, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      }
      urlDestino = `/grupo/${encodeURIComponent(targetJid)}`;
    } else {
      const u = db.prepare('SELECT chat_id FROM users WHERE chat_id = ?').get(targetJid);
      if (!u) {
        let finalName = `+${targetJid.split('@')[0]}`;
        try {
          const contact = await client.getContactById(targetJid);
          if (contact) {
            finalName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || finalName;
          }
        } catch (e) {}
        stmts.upsertUser.run(targetJid, finalName);
      }
      if (hasImage) {
        const result = stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, targetJid, null, null, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      } else {
        const result = stmts.insertMessage.run(finalText, daySend, hourSend, 1, targetJid, null, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      }
      urlDestino = `/usuario/${encodeURIComponent(targetJid)}`;
    }

    if (!whatsappMsgId && insertedMessageId) {
      registerPendingOutgoing(targetJid, insertedMessageId);
    }

    if (hasImage && insertedMessageId && imageFile?.buffer) {
      try {
        await processAndAttachMedia(insertedMessageId, imageFile.buffer, {
          mediaKey: `out_${insertedMessageId}_${Date.now()}`,
          filename: imageFile.originalname || `out_${insertedMessageId}.jpg`,
          mimeType: imageFile.mimetype || 'image/jpeg',
        });
      } catch (mediaErr) {
        console.error('[mensaje] Error guardando attachment saliente:', mediaErr.message);
      }
    }

    // Pantalla nostálgica de espera de 3 segundos sin botones
    res.setHeader('Refresh', `1; url=${urlDestino}`);
    res.status(200).send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://wapforum.org">
      <html xmlns="http://www.w3.org/1999/xhtml">
        <head>
          <meta http-equiv="refresh" content="3;url=${urlDestino}" />
          <title>Enviando</title>
          <style>
            body { font-family: sans-serif; text-align: center; background-color: #ffffff; color: #000000; padding-top: 30px; }
            h2 { font-size: 14px; font-weight: bold; }
          </style>
        </head>
        <body>
          <h2>Enviando Mensaje...</h2>
        </body>
      </html>
    `);

  } catch (error) {
    next(error);
  }
}

export async function showMessageDetail(req, res, next) {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(messageId)) {
      return sendPage(req, res, 404, 'No encontrado', '<p>Mensaje no encontrado.</p><p><a href="/">Inicio</a></p>');
    }

    const message = stmts.getMessageByIdWithMedia.get(messageId);
    if (!message) {
      return sendPage(req, res, 404, 'No encontrado', '<p>Mensaje no encontrado.</p><p><a href="/">Inicio</a></p>');
    }

    const attachments = stmts.getAttachmentsByMessageId.all(messageId);
    const attachment = attachments[0] || null;

    let fromToLabel = '';
    let backUrl = '/';

    if (message.group_id) {
      const resolvedGroup = await ensureGroupDisplayName({ group_id: message.group_id, group_name: message.group_name });
      fromToLabel = `Grupo: ${escapeXml(resolvedGroup.group_name || 'Grupo sin nombre')}`;
      backUrl = `/grupo/${encodeURIComponent(message.group_id)}`;
    } else if (message.user_chat_id) {
      const isOutgoing = Number(message.from_me) === 1;
      const name = escapeXml(message.username || message.user_chat_id.replace(/@.*$/, ''));
      const phone = formatPhoneNumber(message.user_chat_id, message.username);
      const phoneLink = phone ? ` ${renderPhoneLink(phone)}` : '';
      fromToLabel = isOutgoing ? `Para: ${name}` : `De: ${name}${phoneLink}`;
      backUrl = `/usuario/${encodeURIComponent(message.user_chat_id)}`;
    }

    const sentAt = message.hour_send || `${message.day_send} 00:00:00`;
    const timeMatch = sentAt.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    const dateTimeLabel = timeMatch
      ? `${timeMatch[1]} ${timeMatch[2]}`
      : escapeXml(sentAt);

    const isSticker = Number(message.is_sticker) === 1;
    const mediaType = message.media_type || null;
    let contentHtml = '';

    if (isSticker && attachment?.file_path_thumb) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_thumb)}" alt="Sticker" width="40"/></p>`;
    } else if (attachment?.file_path_view) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_view)}" alt="Imagen" width="${attachment.view_width || 120}" height="${attachment.view_height || 90}"/></p>`;
    } else if (mediaType) {
      contentHtml += `<p>${renderMediaLine(message, {})}</p>`;
    }

    if (message.text && message.text !== '[Imagen]') {
      contentHtml += `<p>${renderMentions(message.text)}</p>`;
    } else if (!attachment?.file_path_view && !isSticker && !mediaType) {
      contentHtml += `<p>${renderMentions(message.text || '')}</p>`;
    }

    if (!isSticker && !mediaType && attachment?.file_path_full) {
      const fileName = attachment.file_path_full.split('/').pop();
      contentHtml += `<p><a href="/descargar/${escapeXml(fileName)}">Descargar imagen</a></p>`;
    }

    const body =
      '<h1>Mensaje</h1>' +
      `<p><b>${fromToLabel}</b><br/>${escapeXml(dateTimeLabel)}</p>` +
      contentHtml +
      `<p><a href="${backUrl}">Volver a la conversacion</a></p>`;

    sendPage(req, res, 200, 'Mensaje', body);
  } catch (error) {
    next(error);
  }
}
