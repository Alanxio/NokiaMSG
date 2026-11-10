import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { buildAudioFileName, escapeXml, formatPhoneNumber, isNumericOrJid, renderMediaLine, renderMentions, renderPhoneLink, sendInvalidEntity, sendMissingEntity, sendPage } from './page.controller.js';
import { convertAudioToAmr, getAmrFileName, getMediaDir, processAndAttachMedia, processAndAttachVideo } from '../utils/media.js';
import { queueAudioTranscription } from '../services/audio-transcription.service.js';
import { getMessageQuotePreview } from '../utils/message-preview.js';
import { CONTACT_NAME_PRIORITY } from '../utils/contact-display-name.js';
import multer from 'multer';
import pkg from 'whatsapp-web.js';
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';

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
import { castPollVote, client, refreshPollVotesFromWhatsapp, resolveContactPhone, resolveMyVoterIds, syncOutgoingMessageAck } from '../services/whatsapp.service.js';
import { ensureGroupDisplayName } from './group.controller.js';
import { registerPendingOutgoing, removeObservedOutgoing, takeObservedOutgoing } from '../services/pending-outgoing.service.js';
import { getRequestBaseUrl } from '../utils/public-url.js';

const EXISTING_CONTACT_ICON_HTML = '<img src="/assets/user.jpeg" alt="Contacto" height="14" width="18" style="vertical-align:5px; margin-top:-5px; margin-bottom:-5px;" />';

function getReplyMessageForTarget(messageId, targetJid) {
  if (typeof messageId !== 'string' || !/^[1-9]\d*$/.test(messageId)) {
    return null;
  }

  const message = stmts.getReplyMessageById.get(Number(messageId));
  const messageChatId = message?.group_id || message?.user_chat_id;
  if (
    !message ||
    !message.whatsapp_msg_id ||
    Number(message.is_deleted) === 1 ||
    messageChatId !== targetJid
  ) {
    return null;
  }
  return message;
}

function isVideoUpload(file) {
  const extension = String(file?.originalname || '').toLowerCase().split('.').pop();
  return extension === '3gp'
    && ['video/3gpp', 'video/3gp', 'application/x-3gp', 'application/octet-stream'].includes(file.mimetype);
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedImage = ['image/jpeg', 'image/png'].includes(file.mimetype);
    // El campo «Multimedia» (image) acepta tanto fotos como videos 3GP.
    const allowedVideo = file.fieldname === 'image' && isVideoUpload(file);
    if ((['image', 'image2'].includes(file.fieldname) && allowedImage) || allowedVideo) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imagenes JPG/PNG y videos 3GP'), false);
    }
  },
});

export async function renderComposePage(req, res, next) {
  try {
    const { q, to, type, replyTo } = req.query;

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

      const replyMessage = replyTo === undefined
        ? null
        : getReplyMessageForTarget(replyTo, to);
      if (replyTo !== undefined && !replyMessage) {
        return sendPage(
          req,
          res,
          400,
          'No se puede responder',
          '<p>El mensaje original ya no está disponible para responder.</p><p><a href="/">Inicio</a></p>'
        );
      }

      let body = `<h1>Para: ${escapeXml(destinoNombre)}</h1>`;
      if (replyMessage) {
        const quotedText = getMessageQuotePreview(replyMessage).slice(0, 120);
        const quotedSender = Number(replyMessage.from_me) === 1 ? 'Yo' : (replyMessage.username || 'Desconocido');
        body += `<p><font size="1" color="#555555">Respondiendo a ${escapeXml(quotedSender)}:</font><br/><i>${escapeXml(quotedText)}</i></p>`;
      }

      let mentionPickerHtml = '';
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
            mentionPickerHtml =
              `<p><font size="1" color="#555555">Mencionar en grupo:</font><br/>` +
              `<select name="mention">` +
              `<option value="">Elegir participante</option>` +
              participants.map((p) =>
                `<option value="${escapeXml(p.chat_id)}">@${escapeXml(p.username)}</option>`
              ).join('') +
              `</select> ` +
              `<button type="submit" name="compose_action" value="add_mention">Añadir mención</button></p>`;
          }
        } catch (e) {}
      }

      body += `
        <form action="/mensaje/validar-y-crear" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="phone" value="${escapeXml(to)}"/>
          <input type="hidden" name="type" value="${escapeXml(type)}"/>
          ${replyMessage ? `<input type="hidden" name="replyTo" value="${replyMessage.id}"/>` : ''}
          <p>
            <textarea name="text" rows="5" cols="22">${escapeXml(textoPrevio)}</textarea>
          </p>
          ${mentionPickerHtml}
          <p>
            Multimedia:<br/>
            <input type="file" name="image" accept="image/jpeg,image/png,.3gp,video/3gpp"/>
            Foto 2:<br/>
            <input type="file" name="image2" accept="image/jpeg,image/png"/>
          </p>
          <p>
            <input type="submit" value="Enviar"/>
            <a href="${urlCancelar}">Cancelar</a>
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
        contact.phone = (await resolveContactPhone(contact.chatId))
          || formatPhoneNumber(contact.chatId);
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
          // [Ver]: detalles (foto, info, teléfono) para distinguir contactos con el mismo
          // nombre; si aún no está en el Nokia se abre en modo temporal sin guardarlo.
          const detailsHref = `/usuario/${encodeURIComponent(contact.chatId)}/detalles?q=${encodeURIComponent(q.trim())}`;
          body += `<p>${iconHtml}• <a href="/mensaje/componer?to=${encodeURIComponent(contact.chatId)}&amp;type=user"><b>${escapeXml(contact.displayName)}</b></a> <a href="${escapeXml(detailsHref)}">[Ver]</a>${phoneHtml}</p>`;
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
  // 1. Procesar el campo Multimedia (foto o video 3GP) y una segunda foto con multer
  // ===========================================================================
  try {
    await new Promise((resolve, reject) => {
      upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'image2', maxCount: 1 },
      ])(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    let message = 'Error al procesar el archivo multimedia.';
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      message = 'Cada archivo puede ocupar como máximo 5 MB.';
    } else if (err.message === 'Solo se permiten imagenes JPG/PNG y videos 3GP') {
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
    const { phone, text, type, replyTo, mention, compose_action: composeAction } = req.body;
    const mediaFiles = ['image', 'image2'].flatMap((field) => req.files?.[field] || []);

    // En navegadores clásicos no hay forma de que un enlace lea el contenido
    // todavía no enviado de un textarea. Este submit vuelve al editor con la
    // mención añadida, conservando todo lo que el usuario ya había escrito.
    if (composeAction === 'add_mention') {
      const groupId = typeof phone === 'string' ? phone.trim() : '';
      const mentionId = typeof mention === 'string' ? mention.trim() : '';
      const participant = groupId && mentionId
        ? db.prepare(`
            SELECT u.username
            FROM group_participants gp
            JOIN users u ON u.chat_id = gp.user_chat_id
            WHERE gp.group_id = ? AND gp.user_chat_id = ?
            LIMIT 1
          `).get(groupId, mentionId)
        : null;

      if (type === 'group' && participant?.username) {
        let currentText = typeof text === 'string' ? text : '';
        // Permite escribir «Hola @» antes de elegir: el @ pendiente se sustituye
        // por la mención completa, sin dejar un segundo arroba.
        currentText = currentText.replace(/@\s*$/, '');
        const separator = currentText && !/\s$/.test(currentText) ? ' ' : '';
        const textWithMention = `${currentText}${separator}@${participant.username} `;
        const params = new URLSearchParams({
          to: groupId,
          type: 'group',
          text: textWithMention,
        });
        if (typeof replyTo === 'string' && replyTo) params.set('replyTo', replyTo);
        return res.redirect(`/mensaje/componer?${params.toString()}`);
      }
    }

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    const hasText = trimmedText !== '';
    const outgoingMediaFiles = mediaFiles.map((file) => ({
      file,
      mediaType: isVideoUpload(file) ? 'video' : 'image',
    }));
    const hasMedia = outgoingMediaFiles.length > 0;

    if (!phone || (!hasText && !hasMedia)) {
      return sendPage(
        req,
        res,
        400,
        'Error',
        '<p>Debes escribir un mensaje o adjuntar una imagen o un video.</p><p><a href="/mensaje/componer">Volver</a></p>'
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

    const replyMessage = replyTo === undefined
      ? null
      : getReplyMessageForTarget(replyTo, targetJid);
    if (replyTo !== undefined && !replyMessage) {
      return sendPage(
        req,
        res,
        400,
        'No se puede responder',
        '<p>El mensaje original ya no está disponible para responder.</p><p><a href="/mensaje/componer">Volver</a></p>'
      );
    }

    // =========================================================================
    // 2. Enviar mensaje de texto, imagen o video con caption
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

    if (replyMessage) {
      options.quotedMessageId = replyMessage.whatsapp_msg_id;
      options.ignoreQuoteErrors = false;
    }

    options.waitUntilMsgSent = true;
    const urlDestino = type === 'group' || targetJid.endsWith('@g.us')
      ? `/grupo/${encodeURIComponent(targetJid)}`
      : `/usuario/${encodeURIComponent(targetJid)}`;
    const outgoingMessages = hasMedia
      ? outgoingMediaFiles.map(({ file, mediaType }, index) => ({
        mediaFile: file,
        mediaType,
        text: index === 0 ? processedText : '',
      }))
      : [{ mediaFile: null, mediaType: null, text: processedText }];
    const sentMedia = [];

    for (const { mediaFile, mediaType, text: messageText } of outgoingMessages) {
      const hasAttachment = !!mediaFile;
      let sentMessage;
      if (mediaFile) {
        const media = new MessageMedia(
          mediaType === 'video' ? 'video/3gpp' : mediaFile.mimetype,
          mediaFile.buffer.toString('base64'),
          mediaFile.originalname
        );
        const mediaOptions = {
          ...options,
          caption: messageText,
        };
        if (!messageText) delete mediaOptions.mentions;
        try {
          sentMessage = await client.sendMessage(targetJid, media, mediaOptions);
        } catch (error) {
          if (replyMessage) {
            console.error('[mensaje] No se pudo enviar la respuesta:', error?.message || error);
            return sendPage(
              req,
              res,
              409,
              'No se pudo responder',
              '<p>WhatsApp no pudo vincular la respuesta al mensaje original; no se ha enviado como mensaje normal.</p><p><a href="/mensaje/componer">Volver</a></p>'
            );
          }
          throw error;
        }
      } else {
        try {
          sentMessage = await client.sendMessage(targetJid, messageText, options);
        } catch (error) {
          if (replyMessage) {
            console.error('[mensaje] No se pudo enviar la respuesta:', error?.message || error);
            return sendPage(
              req,
              res,
              409,
              'No se pudo responder',
              '<p>WhatsApp no pudo vincular la respuesta al mensaje original; no se ha enviado como mensaje normal.</p><p><a href="/mensaje/componer">Volver</a></p>'
            );
          }
          throw error;
        }
      }

      // whatsapp-web.js puede no devolver el id, así que se enlaza después del evento
      // message_create cuando WhatsApp confirme el envío.
      let whatsappMsgId = sentMessage?.id?._serialized || sentMessage?.id?.$1 || null;
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const pad = (n) => String(n).padStart(2, '0');
      const daySend = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const hourSend = `${daySend} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const finalText = messageText || (mediaType === 'video' ? '[Video]' : '[Imagen]');
      let insertedMessageId;

      if (type === 'group' || targetJid.endsWith('@g.us')) {
        const group = db.prepare('SELECT group_id FROM wgroups WHERE group_id = ?').get(targetJid);
        if (!group) {
          let groupName = 'Grupo sin nombre';
          try {
            const chat = await client.getChatById(targetJid);
            if (chat && chat.name) groupName = chat.name;
          } catch (e) {}
          stmts.upsertGroup.run(targetJid, groupName);
        }
        const result = hasAttachment
          ? stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, null, targetJid, null, whatsappMsgId)
          : stmts.insertMessage.run(finalText, daySend, hourSend, 1, null, targetJid, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      } else {
        const user = db.prepare('SELECT chat_id FROM users WHERE chat_id = ?').get(targetJid);
        if (!user) {
          let finalName = `+${targetJid.split('@')[0]}`;
          try {
            const contact = await client.getContactById(targetJid);
            if (contact) {
              finalName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || finalName;
            }
          } catch (e) {}
          stmts.upsertUser.run(targetJid, finalName);
        }
        const result = hasAttachment
          ? stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, targetJid, null, null, whatsappMsgId)
          : stmts.insertMessage.run(finalText, daySend, hourSend, 1, targetJid, null, whatsappMsgId);
        insertedMessageId = result.lastInsertRowid;
      }

      if (replyMessage && insertedMessageId) {
        stmts.updateMessageQuote.run(
          getMessageQuotePreview(replyMessage),
          (Number(replyMessage.from_me) === 1 ? 'Yo' : (replyMessage.username || 'Desconocido')).slice(0, 100),
          insertedMessageId
        );
      }

      if (insertedMessageId) {
        if (whatsappMsgId) {
          removeObservedOutgoing(targetJid, whatsappMsgId);
          syncOutgoingMessageAck(whatsappMsgId, sentMessage?.ack);
        } else {
          whatsappMsgId = takeObservedOutgoing(targetJid);
          if (whatsappMsgId) {
            stmts.setMessageWhatsappId.run(whatsappMsgId, insertedMessageId);
            syncOutgoingMessageAck(whatsappMsgId, sentMessage?.ack);
          } else {
            registerPendingOutgoing(targetJid, insertedMessageId);
          }
        }
      }

      if (mediaType === 'video' && insertedMessageId) {
        db.prepare('UPDATE messages SET media_type = ? WHERE id = ?').run('video', insertedMessageId);
      }

      if (mediaFile && insertedMessageId) {
        sentMedia.push({ messageId: insertedMessageId, mediaFile, mediaType });
      }
    }

    for (const { messageId, mediaFile, mediaType } of sentMedia) {
      try {
        const options = {
          mediaKey: `out_${messageId}_${Date.now()}`,
          filename: mediaFile.originalname || (mediaType === 'video' ? `out_${messageId}.3gp` : `out_${messageId}.jpg`),
          mimeType: mediaType === 'video' ? 'video/3gpp' : mediaFile.mimetype || 'image/jpeg',
        };
        const saved = mediaType === 'video'
          ? await processAndAttachVideo(messageId, mediaFile.buffer, options)
          : await processAndAttachMedia(messageId, mediaFile.buffer, options);
        if (saved.previewError) {
          console.error('[mensaje] Video guardado sin fotograma de vista previa:', saved.previewError.message);
        }
      } catch (mediaErr) {
        console.error(`[mensaje] Error guardando attachment saliente (${mediaType}):`, mediaErr.message);
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
      const phone = (await resolveContactPhone(message.user_chat_id))
        || formatPhoneNumber(message.user_chat_id, message.username);
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
    const isPoll = mediaType === 'poll';
    let contentHtml = '';

    if (isPoll && message.whatsapp_msg_id) {
      const refreshResult = await refreshPollVotesFromWhatsapp(message.whatsapp_msg_id, message.id);
      if (!refreshResult.success) {
        console.warn(`[poll] No se pudo refrescar votos del mensaje ${message.id}:`, refreshResult.code || refreshResult.error);
      }
    }

    if (isPoll) {
      const pollOptions = stmts.getPollOptionCountsByMessageId.all(message.id);
      const totalVotes = pollOptions.reduce((sum, o) => sum + Number(o.vote_count || 0), 0);
      const pollQuestion = message.text ? String(message.text).replace(/^\[Encuesta\]\s*/, '') : 'Encuesta';
      const myId = client?.info?.wid?._serialized || null;
      // La propia cuenta puede quedar registrada como votante en formato @lid o en formato
      // PN según la migración de identidad de WhatsApp (ver resolveMyVoterIds) — se compara
      // contra ambas variantes en vez de solo client.info.wid._serialized.
      const myIds = myId ? await resolveMyVoterIds(myId) : null;

      contentHtml += `<p><b>${escapeXml(pollQuestion)}</b></p>`;

      for (const [index, option] of pollOptions.entries()) {
        const voters = stmts.getVotersForOption.all(option.option_id);
        const isMine = myIds ? voters.some((v) => myIds.has(v.voter_chat_id)) : false;
        const voterNames = await Promise.all(voters.map(async (v) => {
          const user = stmts.getUserByChatId.get(v.voter_chat_id);
          // Un nombre real (agenda o perfil) se respeta; si solo tenemos un número,
          // se sustituye por el personal en lugar del de empresa.
          const hasRealName = user?.username && Number(user.name_priority) >= CONTACT_NAME_PRIORITY.PROFILE_NAME;
          const display = (hasRealName ? user.username : null)
            || (await resolveContactPhone(v.voter_chat_id))
            || user?.username
            || formatPhoneNumber(v.voter_chat_id)
            || v.voter_chat_id.replace(/@.*$/, '');
          return escapeXml(display);
        }));

        const accesskeyAttr = index < 9 ? ` accesskey="${index + 1}"` : '';
        const actionHtml = isMine
          ? '<font color="#006600">[Tu voto]</font>'
          : `<a${accesskeyAttr} href="/mensaje/${message.id}/votar/${option.option_id}">[Votar]</a>`;
        const votersLine = voterNames.length
          ? `<br/><font size="1" color="#888888">Votos: ${voterNames.join(', ')}</font>`
          : '<br/><font size="1" color="#888888">Sin votos aún</font>';

        contentHtml += `<p>${escapeXml(option.option_name)} — ${option.vote_count} voto(s) ${actionHtml}${votersLine}</p>`;
      }

      contentHtml += `<p><font size="1" color="#888888">Total: ${totalVotes} voto(s)</font></p>`;
    } else if (
      isSticker
      && (attachment?.file_path_view || attachment?.file_path_full || attachment?.file_path_thumb)
    ) {
      const stickerPath = attachment.file_path_view || attachment.file_path_full || attachment.file_path_thumb;
      const stickerWidth = attachment.file_path_view || attachment.file_path_full ? 120 : 40;
      contentHtml += `<p><img src="${escapeXml(stickerPath)}" alt="Sticker" width="${stickerWidth}"/></p>`;
    } else if (mediaType === 'video' && attachment?.file_path_view) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_view)}" alt="Primer fotograma del video" width="120"/></p>`;
      contentHtml += `<p>${renderMediaLine(message, { showPreview: false })}</p>`;
    } else if (attachment?.file_path_view) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_view)}" alt="Imagen" width="${attachment.view_width || 120}" height="${attachment.view_height || 90}"/></p>`;
    } else if (mediaType) {
      contentHtml += `<p>${renderMediaLine(message, {})}</p>`;
    }

    if (
      message.text
      && message.text !== '[Imagen]'
      && !(mediaType === 'video' && message.text === '[Video]')
      && !isPoll
    ) {
      contentHtml += `<p>${renderMentions(message.text)}</p>`;
    } else if (!attachment?.file_path_view && !isSticker && !mediaType) {
      contentHtml += `<p>${renderMentions(message.text || '')}</p>`;
    }

    if (mediaType === 'ptt' || mediaType === 'audio') {
      contentHtml += '<h2>Transcripción</h2>';
      if (message.transcription) {
        contentHtml += `<p>${escapeXml(message.transcription)}</p>`;
      } else if (message.file_path_full) {
        const audioPath = join(getMediaDir(), basename(message.file_path_full));
        if (existsSync(audioPath)) {
          queueAudioTranscription(message.id, audioPath);
          contentHtml += '<p>La transcripción se está preparando automáticamente. Vuelve a abrir este detalle en unos instantes.</p>';
        } else {
          contentHtml += '<p>El archivo de audio no está disponible para transcribir.</p>';
        }
      } else {
        contentHtml += '<p>El archivo de audio no está disponible para transcribir.</p>';
      }
    }

    if (!isSticker && !mediaType && attachment?.file_path_full) {
      const fileName = attachment.file_path_full.split('/').pop();
      contentHtml += `<p><a href="/descargar/${escapeXml(fileName)}">Descargar imagen</a></p>`;
    }

    const body =
      '<h1>Mensaje</h1>' +
      `<p><b>${fromToLabel}</b><br/>${escapeXml(dateTimeLabel)}${Number(message.is_deleted) === 1 ? ' <font size="1" color="#cc0000">(borrado)</font>' : ''}</p>` +
      contentHtml +
      `<p><a href="${backUrl}">Volver a la conversacion</a></p>`;

    sendPage(req, res, 200, 'Mensaje', body);
  } catch (error) {
    next(error);
  }
}

async function loadAudioMessage(req, res) {
  const messageId = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(messageId)) {
    sendInvalidEntity(req, res, 'Mensaje');
    return null;
  }
  const message = stmts.getMessageByIdWithMedia.get(messageId);
  if (!message) {
    sendMissingEntity(req, res, 'Mensaje');
    return null;
  }
  if (!['ptt', 'audio'].includes(message.media_type) || !message.file_path_full) {
    sendPage(req, res, 404, 'Audio', '<p>Este mensaje no tiene audio.</p>' +
      `<p><a href="/mensaje/${messageId}">Volver</a></p>`);
    return null;
  }
  try {
    await convertAudioToAmr(basename(message.file_path_full));
  } catch (convertErr) {
    console.error(`[audio] No se pudo convertir el audio del mensaje ${messageId}:`, convertErr.message);
    sendPage(req, res, 500, 'Audio', '<p>No se pudo preparar el audio.</p>' +
      `<p><a href="/mensaje/${messageId}">Volver</a></p>`);
    return null;
  }
  return message;
}

// El gestor de descargas del Nokia pide el objeto del descriptor por su cuenta y puede
// no enviar la cookie de sesión, así que esa URL va firmada (HMAC del id del mensaje).
// La clave es aleatoria por arranque: el descriptor se pide siempre justo antes.
const AUDIO_LINK_SECRET = crypto.randomBytes(32);

function signAudioLink(messageId) {
  return crypto.createHmac('sha256', AUDIO_LINK_SECRET).update(String(messageId)).digest('hex').slice(0, 32);
}

// El objectURI del descriptor va por la misma vía por la que ha entrado el Nokia:
// https:// si vino cifrado por nokia-tls, http:// si no (ver utils/public-url.js).
const getPublicBaseUrl = getRequestBaseUrl;

// PRUEBA — OMA DRM 1.0 «combined delivery»: el .amr viaja dentro de un mensaje DRM con
// un derecho de reproducción limitado a N escuchas (AUDIO_PLAY_COUNT, por defecto 1).
// Con AUDIO_PLAY_COUNT=0 se envía el .amr normal, sin DRM.
const AUDIO_PLAY_COUNT = Number.parseInt(process.env.AUDIO_PLAY_COUNT ?? '1', 10) || 0;
const DRM_BOUNDARY = 'nokiamsn-drm-boundary';

function buildAudioPayload(message, amrPath) {
  const amr = readFileSync(amrPath);
  if (AUDIO_PLAY_COUNT <= 0) return { contentType: 'audio/amr', body: amr };

  const cid = `audio${message.id}@nokiamsn`;
  const rights =
    '<o-ex:rights xmlns:o-ex="http://odrl.net/1.1/ODRL-EX" xmlns:o-dd="http://odrl.net/1.1/ODRL-DD" ' +
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#/">' +
    '<o-ex:context><o-dd:version>1.0</o-dd:version></o-ex:context>' +
    '<o-ex:agreement>' +
    `<o-ex:asset><o-ex:context><o-dd:uid>cid:${cid}</o-dd:uid></o-ex:context></o-ex:asset>` +
    '<o-ex:permission><o-dd:play><o-ex:constraint>' +
    `<o-dd:count>${AUDIO_PLAY_COUNT}</o-dd:count>` +
    '</o-ex:constraint></o-dd:play></o-ex:permission>' +
    '</o-ex:agreement>' +
    '</o-ex:rights>';
  const head =
    `--${DRM_BOUNDARY}\r\n` +
    'Content-Type: application/vnd.oma.drm.rights+xml\r\n' +
    'Content-Transfer-Encoding: binary\r\n' +
    '\r\n' +
    `${rights}\r\n` +
    `--${DRM_BOUNDARY}\r\n` +
    'Content-Type: audio/amr\r\n' +
    `Content-ID: <${cid}>\r\n` +
    'Content-Transfer-Encoding: binary\r\n' +
    '\r\n';
  const tail = `\r\n--${DRM_BOUNDARY}--\r\n`;
  return {
    contentType: `application/vnd.oma.drm.message; boundary=${DRM_BOUNDARY}`,
    body: Buffer.concat([Buffer.from(head, 'utf8'), amr, Buffer.from(tail, 'utf8')]),
  };
}

// GET /mensaje/:id/escuchar.dd — descriptor OMA Download con el nombre del archivo.
export async function serveAudioDescriptor(req, res, next) {
  try {
    const message = await loadAudioMessage(req, res);
    if (!message) return;
    const amrPath = join(getMediaDir(), getAmrFileName(basename(message.file_path_full)));
    const fileName = buildAudioFileName(message);
    const payload = buildAudioPayload(message, amrPath);
    const objectUri = `${getPublicBaseUrl(req)}/audio/${message.id}/${signAudioLink(message.id)}/${encodeURIComponent(fileName)}`;
    const descriptor =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<media xmlns="http://www.openmobilealliance.org/xmlns/dd">\n' +
      (AUDIO_PLAY_COUNT > 0 ? '<type>application/vnd.oma.drm.message</type>\n' : '') +
      '<type>audio/amr</type>\n' +
      `<size>${payload.body.length}</size>\n` +
      `<objectURI>${escapeXml(objectUri)}</objectURI>\n` +
      `<name>${escapeXml(fileName.replace(/\.amr$/, ''))}</name>\n` +
      '<DDVersion>1.0</DDVersion>\n' +
      '</media>\n';
    res.set({
      'Content-Type': 'application/vnd.oma.dd+xml',
      'Cache-Control': 'no-store',
    });
    res.send(descriptor);
  } catch (error) {
    next(error);
  }
}

// GET /audio/:id/:token/:fileName — sin cookie, validado por la firma.
export async function streamSignedAudio(req, res, next) {
  try {
    const expected = Buffer.from(signAudioLink(req.params.id));
    const given = Buffer.from(String(req.params.token || ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(403).send('Enlace no válido');
    }
    const message = await loadAudioMessage(req, res);
    if (!message) return;
    const amrPath = join(getMediaDir(), getAmrFileName(basename(message.file_path_full)));
    const payload = buildAudioPayload(message, amrPath);
    const fileName = buildAudioFileName(message).replace(/\.amr$/, AUDIO_PLAY_COUNT > 0 ? '.dm' : '.amr');
    res.set({
      'Content-Type': payload.contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    res.send(payload.body);
  } catch (error) {
    next(error);
  }
}

export async function showMessageReadReceipts(req, res, next) {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(messageId)) {
      return sendPage(req, res, 404, 'No encontrado', '<p>Mensaje no encontrado.</p><p><a href="/">Inicio</a></p>');
    }

    const message = stmts.getMessageByIdWithMedia.get(messageId);
    if (
      !message ||
      Number(message.from_me) !== 1 ||
      !message.whatsapp_msg_id ||
      Number(message.is_deleted) === 1 ||
      Number(message.is_system) === 1
    ) {
      return sendPage(req, res, 404, 'No encontrado', '<p>No hay recibos de lectura para este mensaje.</p><p><a href="/">Inicio</a></p>');
    }

    let backUrl = '/';
    if (message.group_id) {
      backUrl = `/grupo/${encodeURIComponent(message.group_id)}`;
    } else if (message.user_chat_id) {
      backUrl = `/usuario/${encodeURIComponent(message.user_chat_id)}`;
    }

    if (!client?.info) {
      return sendPage(req, res, 503, 'Leídos', '<h1>Leídos</h1><p>WhatsApp no está conectado; no se pueden consultar los recibos.</p>' +
        `<p><a href="/mensaje/${message.id}">Volver al mensaje</a></p>`);
    }

    const whatsappMessage = await client.getMessageById(message.whatsapp_msg_id);
    const info = whatsappMessage ? await whatsappMessage.getInfo() : null;
    if (!info) {
      return sendPage(req, res, 200, 'Leídos', '<h1>Leídos</h1><p>WhatsApp no ha devuelto información de lectura para este mensaje.</p>' +
        `<p><a href="/mensaje/${message.id}">Volver al mensaje</a> | <a href="${backUrl}">Volver a la conversación</a></p>`);
    }

    const readReceipts = Array.isArray(info.read) ? info.read : [];
    const readers = await Promise.all(readReceipts.map(async (receipt) => {
      const chatId = typeof receipt?.id === 'string'
        ? receipt.id
        : receipt?.id?._serialized || null;
      if (!chatId) {
        return { label: 'Contacto desconocido', timestamp: receipt?.t };
      }

      const storedUser = stmts.getUserByChatId.get(chatId);
      // Un username que solo es un número (posiblemente el de empresa) no cuenta como nombre.
      const localUser = storedUser?.username && Number(storedUser.name_priority) >= CONTACT_NAME_PRIORITY.PROFILE_NAME
        ? storedUser
        : null;
      let contact = null;
      if (!localUser?.username && typeof client.getContactById === 'function') {
        try {
          contact = await client.getContactById(chatId);
        } catch (error) {
          console.warn(`[mensaje] No se pudo resolver el lector ${chatId}:`, error.message);
        }
      }

      const displayName = localUser?.username || contact?.pushname || contact?.name || contact?.shortName;
      return {
        label: displayName
          || (await resolveContactPhone(chatId))
          || storedUser?.username
          || formatPhoneNumber(chatId)
          || chatId.replace(/@.*$/, ''),
        timestamp: receipt?.t,
      };
    }));

    const readersHtml = readers.length
      ? `<ul>${readers.map(({ label, timestamp }) => {
        const readAt = Number(timestamp) > 0
          ? ` <font size="1" color="#666666">${escapeXml(new Date(Number(timestamp) * 1000).toLocaleString('es-ES'))}</font>`
          : '';
        return `<li>${escapeXml(label)}${readAt}</li>`;
      }).join('')}</ul>`
      : '<p>Nadie ha leído este mensaje todavía.</p>';
    const readRemaining = Number(info.readRemaining);
    const remainingHtml = Number.isFinite(readRemaining) && readRemaining > 0
      ? `<p>${readRemaining} pendiente(s) de leer.</p>`
      : '';
    const sentAt = message.hour_send || message.day_send || '';

    const body =
      '<h1>Leídos</h1>' +
      `<p>Mensaje del ${escapeXml(sentAt)}</p>` +
      `<p>${renderMentions(message.text || '')}</p>` +
      `<p>Leído por ${readers.length} contacto(s):</p>` +
      readersHtml +
      remainingHtml +
      `<p><a href="/mensaje/${message.id}">Volver al mensaje</a> | <a href="${backUrl}">Volver a la conversación</a></p>`;
    sendPage(req, res, 200, 'Leídos', body);
  } catch (error) {
    next(error);
  }
}

export async function voteOnPoll(req, res, next) {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    const optionId = Number.parseInt(req.params.optionId, 10);
    if (Number.isNaN(messageId) || Number.isNaN(optionId)) {
      return sendInvalidEntity(req, res, 'Encuesta');
    }

    const message = stmts.getMessageByIdWithMedia.get(messageId);
    if (!message || message.media_type !== 'poll' || !message.whatsapp_msg_id) {
      return sendMissingEntity(req, res, 'Encuesta');
    }

    const option = stmts.getPollOptionById.get(optionId);
    if (!option || option.message_id !== messageId) {
      return sendMissingEntity(req, res, 'Opción de encuesta');
    }

    const result = await castPollVote(message.whatsapp_msg_id, messageId, option.local_id, option.option_name);

    const backUrl = `/mensaje/${messageId}`;
    const body = result.success
      ? `<p>Voto registrado.</p><p><a href="${backUrl}">Volver</a></p>`
      : `<p>No se pudo registrar el voto${result.error ? `: ${escapeXml(result.error)}` : ''}.</p><p><a href="${backUrl}">Volver</a></p>`;
    sendPage(req, res, 200, 'Nokia', body, `<meta http-equiv="refresh" content="0;url=${backUrl}"/>`);
  } catch (error) {
    next(error);
  }
}
