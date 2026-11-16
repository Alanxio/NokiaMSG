import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii, renderMiniEmoji } from '../utils/emoji.js';
import { isMyId } from '../utils/my-identity.js';
import { mergeContactCandidates } from '../utils/contact-search.js';
import { getSerializedId as getSerializedIdSafe } from '../whatsapp/ids.js';
import { buildAudioFileName, escapeXml, formatPhoneNumber, renderMediaLine, renderMentions, renderPhoneLink, sendInvalidEntity, sendMissingEntity, sendPage } from './page.controller.js';
import { convertAudioToAmr, getAmrFileName, getMediaDir } from '../utils/media.js';
import { queueAudioTranscription } from '../services/audio-transcription.service.js';
import { getMessageQuotePreview } from '../utils/message-preview.js';
import { CONTACT_NAME_PRIORITY } from '../utils/contact-display-name.js';
import multer from 'multer';
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';

// Asegúrate de que esta ruta apunte correctamente a donde exportas el cliente
import { castPollVote, client, refreshPollVotesFromWhatsapp, resolveContactPhone, resolveMyVoterIds } from '../services/whatsapp.service.js';
import { resolveUnknownMentionNames } from '../utils/mentions.js';
import { ensureGroupDisplayName, getGroupMentionCandidates } from './group.controller.js';
import { findComposeMentions } from '../utils/mention-text.js';
import { isGroupTarget, resolveTargetJid, sendOutgoingMessages, SendMessageError } from '../domain/messaging.service.js';
import { getRequestBaseUrl } from '../utils/public-url.js';

// Contacto que ya está en el Nokia (tiene chat): Profile.png, mismo estilo que los iconos de
// 12 px de la interfaz (Chat, Eye, Max…). Grupo: el mismo icono que la portada.
const EXISTING_CONTACT_ICON_HTML = '<img src="/assets/Profile.png" alt="[N]" width="12" height="12" style="vertical-align:middle;"/>';
const GROUP_ICON_HTML = '<img src="/assets/group.jpeg" alt="G" height="14" width="18" style="vertical-align:middle;"/>';

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

      // Para mencionar basta con escribir «@» y el nombre (sin tildes ni mayúsculas): al
      // enviar se completa solo. Recordatorio en una línea corta justo bajo el campo de texto
      // (la pantalla del 6111 es pequeña), con enlace a los participantes del grupo.
      const mentionHintHtml = type === 'group'
        ? `<font size="1" color="#555555">Menciona: @nombre &#183; ` +
          `<a href="/grupo/${encodeURIComponent(to)}/detalles">Participantes</a></font>`
        : '';

      body += `
        <form action="/mensaje/validar-y-crear" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="phone" value="${escapeXml(to)}"/>
          <input type="hidden" name="type" value="${escapeXml(type)}"/>
          ${replyMessage ? `<input type="hidden" name="replyTo" value="${replyMessage.id}"/>` : ''}
          <p>
            <textarea name="text" rows="5" cols="22">${escapeXml(textoPrevio)}</textarea>
            ${mentionHintHtml}
          </p>
          <p>
            <br/>
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
    const query = typeof q === 'string' ? q.trim().slice(0, 40) : '';
    let body = '<h1>Buscar en WhatsApp</h1>' +
      // Mismo buscador que las listas de Usuarios y Grupos: campo + lupa al lado (tabla,
      // porque el 6111 pone cada campo en su propia línea) y size="7" para sus 128 px.
      '<form action="/mensaje/componer" method="get">' +
      '<table cellpadding="0" cellspacing="0"><tr>' +
      `<td><input type="text" name="q" value="${escapeXml(query)}" size="7" maxlength="40"/></td>` +
      '<td><input type="image" src="/assets/Search.png" width="16" height="16" alt="Buscar"/></td>' +
      '</tr></table></form>';

    if (!query) {
      body += '<p><font size="1" color="#666666">Nombre, número o grupo. Encuentra también a quien aún no está en el Nokia.</font></p>';
    }

    if (query) {
      const queryClean = query.toLowerCase();

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
      const queryDigits = queryClean.replace(/[^0-9]/g, '');

      // Candidatos: agenda del móvil (en vivo) y BD del Nokia. La misma persona puede venir
      // por número (@c.us) y por id interno (@lid); se unen abajo (mergeContactCandidates).
      const rawCandidates = [];
      allContacts.forEach(c => {
        if (!c.isUser || c.isMe || !c.number) return;
        const basePhone = c.number.split(':')[0].trim();
        const server = c.id && c.id.server ? c.id.server : 'c.us';
        const chatId = getSerializedIdSafe(c.id) || `${basePhone}@${server}`;
        const displayName = (c.name || c.pushname || c.shortName || `+${basePhone}`).trim();
        const matches = displayName.toLowerCase().includes(queryClean)
          || (queryDigits.length >= 3 && basePhone.includes(queryDigits));
        if (!matches) return;
        rawCandidates.push({
          chatId,
          displayName,
          hasRealName: !!c.name,
          isBusiness: !!c.isBusiness,
          isMyContact: !!c.isMyContact,
        });
      });
      localMatches.forEach(u => {
        rawCandidates.push({
          chatId: u.chat_id,
          displayName: u.username,
          hasRealName: false,
          isBusiness: false,
          isMyContact: false,
        });
      });

      // LID ↔ número de cada candidato, de una sola llamada (solo los que encajan con la
      // búsqueda, no toda la agenda).
      const candidateChatIds = [...new Set(rawCandidates.map(c => c.chatId))];
      const aliases = new Map();
      if (candidateChatIds.length && typeof client?.getContactLidAndPhone === 'function') {
        // Si un id hace fallar la llamada entera (p. ej. un número sin WhatsApp), se pide
        // uno a uno para no perder la unión de los demás.
        let resolved = await withTimeout(client.getContactLidAndPhone(candidateChatIds), 5000);
        if (!Array.isArray(resolved)) {
          resolved = await Promise.all(candidateChatIds.map(async (id) =>
            (await withTimeout(client.getContactLidAndPhone([id]), 3000))?.[0] || null));
        }
        resolved.forEach((entry, index) => {
          if (entry) aliases.set(candidateChatIds[index], { lid: getSerializedIdSafe(entry.lid), pn: getSerializedIdSafe(entry.pn) });
        });
      }

      // ¿Quién tiene ya chat en el Nokia? Con todos los ids posibles de cada persona.
      const allIds = [...new Set([
        ...candidateChatIds,
        ...[...aliases.values()].flatMap(a => [a.lid, a.pn]).filter(Boolean),
      ])];
      const existingContactIds = allIds.length > 0
        ? new Set(
            db.prepare(`
              SELECT DISTINCT user_chat_id FROM messages
              WHERE group_id IS NULL AND user_chat_id IN (SELECT value FROM json_each(?))
            `).all(JSON.stringify(allIds)).map(r => r.user_chat_id)
          )
        : new Set();

      const filteredContacts = mergeContactCandidates(rawCandidates, { aliases, existingIds: existingContactIds });

      // Primero las cuentas personales: quien busca casi siempre quiere a la persona, no su
      // número de empresa (sort estable: se conserva el orden dentro de cada grupo).
      filteredContacts.sort((a, b) => (a.isBusiness === b.isBusiness) ? 0 : (a.isBusiness ? 1 : -1));

      // Teléfono de cada resultado: el número personal que ya dio WhatsApp; si no, se
      // resuelve (los @lid no son dígitos de un teléfono real).
      await Promise.all(filteredContacts.slice(0, 5).map(async (contact) => {
        contact.phone = (contact.pn ? formatPhoneNumber(contact.pn) : null)
          || (await resolveContactPhone(contact.chatId))
          || formatPhoneNumber(contact.chatId);
      }));

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

      const shownContacts = filteredContacts.slice(0, 5);
      const shownGroups = filteredGroups.slice(0, 5);
      const total = shownContacts.length + shownGroups.length;

      body += `<p><font size="1">${total} resultado${total === 1 ? '' : 's'} para «${escapeXml(query)}» ` +
        '<a href="/mensaje/componer">[Quitar]</a></font></p>';

      if (shownContacts.length > 0) {
        body += '<p><b>Contactos</b>';
        // Leyenda solo si hace falta: el icono marca a quien ya tienes en el Nokia.
        if (shownContacts.some(contact => contact.isExistingContact)) {
          body += `<br/><font size="1" color="#666666">${EXISTING_CONTACT_ICON_HTML} = ya en el Nokia</font>`;
        }
        body += '</p>';
        shownContacts.forEach(contact => {
          const iconHtml = contact.isExistingContact ? `${EXISTING_CONTACT_ICON_HTML} ` : '';
          // [Ver]: detalles (foto, info, teléfono) para distinguir contactos con el mismo
          // nombre; si aún no está en el Nokia se abre en modo temporal sin guardarlo.
          const detailsHref = `/usuario/${encodeURIComponent(contact.chatId)}/detalles?q=${encodeURIComponent(query)}`;
          const composeHref = `/mensaje/componer?to=${encodeURIComponent(contact.chatId)}&type=user`;
          const businessTag = contact.isBusiness ? '(empresa) ' : '';
          // Teléfono en su propia línea (sin paréntesis): enlace wtai para llamar desde el Nokia.
          const phoneHtml = contact.phone
            ? `<a href="wtai://wp/mc;${escapeXml(contact.phone.replace(/[^0-9+]/g, ''))}"><font color="#666666">${escapeXml(contact.phone)}</font></a> `
            : '';
          const name = convertEmojisToAscii(contact.displayName) || contact.displayName;
          body += '<hr/>' +
            `<p>${iconHtml}<a href="${escapeXml(composeHref)}"><b>${escapeXml(name)}</b></a>` +
            `<br/><font size="1" color="#666666">${phoneHtml}${businessTag}<a href="${escapeXml(detailsHref)}">[Ver]</a></font></p>`;
        });
      }

      if (shownGroups.length > 0) {
        body += `${shownContacts.length ? '<hr/>' : ''}<p><b>Grupos</b></p>`;
        shownGroups.forEach(group => {
          const groupId = group.id._serialized;
          const displayGroupName = convertEmojisToAscii(group.name || '') || 'Grupo sin nombre';
          const composeHref = `/mensaje/componer?to=${encodeURIComponent(groupId)}&type=group`;
          body += `<hr/><p>${GROUP_ICON_HTML} <a href="${escapeXml(composeHref)}"><b>${escapeXml(displayGroupName)}</b></a></p>`;
        });
      }

      if (total === 0) {
        body += '<p>No se encontraron resultados.</p>';
        const soloNumeros = queryClean.replace(/[^0-9]/g, '');
        if (soloNumeros.length >= 9) {
          body += `
            <p><font size="1" color="#666666">Escribir al +${soloNumeros}:</font></p>
            <form action="/mensaje/validar-y-crear" method="POST">
              <input type="hidden" name="phone" value="${soloNumeros}"/>
              <input type="hidden" name="type" value="user"/>
              <p>
                <textarea name="text" rows="3" cols="18"></textarea>
                <br/><input type="submit" value="Enviar"/>
              </p>
            </form>
          `;
        } else {
          body += '<p><font size="1" color="#666666">Prueba con parte del nombre o con el número completo.</font></p>';
        }
      }
    }

    body += '<hr/><p><a href="/">Inicio</a> | <a href="/usuario">Usuarios</a> | <a href="/grupo">Grupos</a></p>';

    sendPage(req, res, 200, 'Buscar', body);
  } catch (error) {
    next(error);
  }
}

// «@pau» encaja con varias personas: se pregunta a quién se refiere (una sola página para
// todas las dudas del mensaje) y se reenvía el mismo formulario con la elección. Las fotos o
// vídeos adjuntos no se pueden conservar entre páginas en el Nokia: se piden de nuevo.
function sendMentionChoicePage(req, res, { phone, type, text, replyTo, ambiguous, hadMedia, groupId }) {
  const questions = ambiguous.map(({ index, query, candidates }) =>
    `<p>¿Quién es <b>${escapeXml(query)}</b>?<br/>` +
    candidates.map((c, i) =>
      `<input type="radio" name="mention_pick_${index}" value="${escapeXml(c.id)}"${i === 0 ? ' checked="checked"' : ''}/>` +
      `${escapeXml(c.name)}<br/>`
    ).join('') +
    '</p>'
  ).join('');
  const mediaHtml = hadMedia
    ? '<p><font size="1" color="#cc0000">Vuelve a adjuntar la foto o el video:</font><br/>' +
      '<input type="file" name="image" accept="image/jpeg,image/png,.3gp,video/3gpp"/><br/>' +
      '<input type="file" name="image2" accept="image/jpeg,image/png"/></p>'
    : '';
  const body =
    '<h1>Mencionar</h1>' +
    `<p><font size="1" color="#555555">${escapeXml(String(text || '').slice(0, 160))}</font></p>` +
    '<form action="/mensaje/validar-y-crear" method="POST" enctype="multipart/form-data">' +
    `<input type="hidden" name="phone" value="${escapeXml(phone)}"/>` +
    `<input type="hidden" name="type" value="${escapeXml(type || 'group')}"/>` +
    // &#10;: en un atributo XML un salto de línea literal se convierte en espacio.
    `<input type="hidden" name="text" value="${escapeXml(text || '').replace(/\r?\n/g, '&#10;')}"/>` +
    (replyTo !== undefined && replyTo !== '' ? `<input type="hidden" name="replyTo" value="${escapeXml(replyTo)}"/>` : '') +
    questions +
    mediaHtml +
    `<p><input type="submit" value="Enviar"/> <a href="/grupo/${encodeURIComponent(groupId)}">Cancelar</a></p>` +
    '</form>';
  return sendPage(req, res, 200, 'Mencionar', body);
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
    const { phone, text, type, replyTo } = req.body;
    const mediaFiles = ['image', 'image2'].flatMap((field) => req.files?.[field] || []);

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

    const targetJid = await resolveTargetJid(phone);
    if (!targetJid) {
      return sendPage(
        req,
        res,
        400,
        'Error',
        '<h1>Error</h1><p>El número no tiene WhatsApp registrado.</p><p><a href="/mensaje/componer">Volver</a></p>'
      );
    }
    const isGroup = isGroupTarget(targetJid, type);

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
    let mentions = null;
    if (isGroup) {
      // Menciones: «@ana» o «@ana gar» se completan con el participante que encaja (lista
      // en vivo de WhatsApp). En el cuerpo viaja «@<número>», que es lo que WhatsApp necesita
      // para resaltarla y avisar a esa persona.
      if (processedText.includes('@')) {
        const picks = {};
        for (const [key, value] of Object.entries(req.body || {})) {
          const match = key.match(/^mention_pick_(\d+)$/);
          if (match && typeof value === 'string' && value) picks[match[1]] = value;
        }
        let { candidates, unknownCount } = await getGroupMentionCandidates(targetJid);
        let mentionResult = findComposeMentions(processedText, candidates, picks);
        // Lo escrito no encaja con nadie conocido: consultar a WhatsApp los nombres que
        // faltan (solo entonces, porque en grupos grandes tarda) y volver a intentarlo.
        if (mentionResult.unmatched.length && unknownCount > 0) {
          ({ candidates } = await getGroupMentionCandidates(targetJid, { resolveUnknown: true }));
          mentionResult = findComposeMentions(processedText, candidates, picks);
        }
        if (mentionResult.ambiguous.length) {
          return sendMentionChoicePage(req, res, {
            phone, type, text, replyTo, ambiguous: mentionResult.ambiguous, hadMedia: hasMedia, groupId: targetJid,
          });
        }
        processedText = mentionResult.sendText;
        if (mentionResult.mentionedIds.length) mentions = mentionResult.mentionedIds;
      }
    }

    let sentResults;
    try {
      sentResults = await sendOutgoingMessages({
        targetJid,
        isGroup,
        text: processedText,
        mediaFiles: outgoingMediaFiles,
        replyMessage,
        mentions,
      });
    } catch (error) {
      if (!(error instanceof SendMessageError)) throw error;
      if (replyMessage) {
        console.error('[mensaje] No se pudo enviar la respuesta:', error.cause?.message || error.cause || error.message);
        return sendPage(
          req,
          res,
          409,
          'No se pudo responder',
          '<p>WhatsApp no pudo vincular la respuesta al mensaje original; no se ha enviado como mensaje normal.</p><p><a href="/mensaje/componer">Volver</a></p>'
        );
      }
      throw error.cause ?? error;
    }

    // En privados el chat puede haberse guardado con el @lid del número escrito.
    const chatDestino = sentResults?.[0]?.chatId || targetJid;
    const urlDestino = isGroup
      ? `/grupo/${encodeURIComponent(chatDestino)}`
      : `/usuario/${encodeURIComponent(chatDestino)}`;

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
    await resolveUnknownMentionNames([message.text], client);

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

    contentHtml += await renderReactionsDetail(message.id);

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

// Nombre para mostrar de quien reacciona/vota: el de la agenda o perfil si lo hay; si solo
// tenemos un número, el teléfono personal (no el de empresa).
async function participantDisplayName(chatId) {
  const user = stmts.getUserByChatId.get(chatId);
  const hasRealName = user?.username && Number(user.name_priority) >= CONTACT_NAME_PRIORITY.PROFILE_NAME;
  return (hasRealName ? user.username : null)
    || (await resolveContactPhone(chatId))
    || user?.username
    || formatPhoneNumber(chatId)
    || chatId.replace(/@.*$/, '');
}

// Detalle del mensaje: una línea por reacción, «😂 Ana», con «Tú» para las propias.
async function renderReactionsDetail(messageId) {
  const reactions = stmts.getReactionsForMessage.all(messageId);
  if (!reactions.length) return '';
  const lines = await Promise.all(reactions.map(async (r) => {
    const name = isMyId(r.sender_id) ? 'Tú' : await participantDisplayName(r.sender_id);
    return `${renderMiniEmoji(r.reaction)} ${escapeXml(convertEmojisToAscii(name) || name)}`;
  }));
  return `<p><font size="1" color="#666666">Reacciones:</font><br/>${lines.join('<br/>')}</p>`;
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
