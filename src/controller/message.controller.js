import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { escapeXml, sendPage } from './page.controller.js';
import { processAndAttachMedia } from '../utils/media.js';
import multer from 'multer';
import pkg from 'whatsapp-web.js';

const { MessageMedia } = pkg;

// Asegúrate de que esta ruta apunte correctamente a donde exportas el cliente
import { client } from '../services/whatsapp.service.js';

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
        const g = db.prepare('SELECT group_name FROM wgroups WHERE group_id = ?').get(to);
        if (g) {
          destinoNombre = g.group_name;
          urlCancelar = `/grupo/${encodeURIComponent(to)}`;
        } else {
          urlCancelar = '/grupo';
        }
      }

      let body = `<h1>Para: ${escapeXml(destinoNombre)}</h1>`;

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

      const allContacts = await client.getContacts();
      const uniqueContactsMap = new Map();

      allContacts.forEach(c => {
        if (c.isUser && !c.isMe && c.number) {
          const basePhone = c.number.split(':')[0].trim();
          
          // Construir el chatId real respetando si es @c.us o @lid
          const server = c.id && c.id.server ? c.id.server : 'c.us';
          const baseChatId = `${basePhone}@${server}`;
          
          const displayName = (c.name || c.pushname || c.shortName || `+${basePhone}`).trim();

          // Usamos el nombre de la agenda como clave primaria de deduplicación si existe.
          // Si no existe nombre, usamos el teléfono para no agrupar gente sin nombre.
          const dedupKey = c.name ? c.name.trim().toLowerCase() : basePhone;

          if (!uniqueContactsMap.has(dedupKey)) {
            uniqueContactsMap.set(dedupKey, { 
              chatId: baseChatId, 
              displayName: displayName, 
              hasRealName: !!c.name,
              isLid: server === 'lid' || basePhone.length > 14
            });
          } else {
            const existingContact = uniqueContactsMap.get(dedupKey);
            const isCurrentLid = server === 'lid' || basePhone.length > 14;
            
            // Si el contacto guardado es LID y el actual NO lo es, sobreescribimos con el real
            if (existingContact.isLid && !isCurrentLid) {
              existingContact.chatId = baseChatId;
              existingContact.isLid = false;
            }
            
            // Si el actual tiene nombre de agenda y el guardado no, actualizamos el nombre
            if (c.name && !existingContact.hasRealName) {
              existingContact.displayName = displayName;
              existingContact.hasRealName = true;
            }
          }
        }
      });

      const filteredContacts = Array.from(uniqueContactsMap.values()).filter(contact => {
        const nameLower = contact.displayName.toLowerCase();
        return nameLower.includes(queryClean) || contact.chatId.includes(queryClean);
      });

      const allChats = await client.getChats();
      const filteredGroups = allChats.filter(c => {
        const groupName = (c.name || '').toLowerCase();
        return c.isGroup && groupName.includes(queryClean);
      });

      let coincidenciaEncontrada = false;

      if (filteredContacts.length > 0) {
        coincidenciaEncontrada = true;
        body += '<h3>Contactos</h3>';
        filteredContacts.slice(0, 5).forEach(contact => {
          body += `<p>• <a href="/mensaje/componer?to=${encodeURIComponent(contact.chatId)}&type=user"><b>${escapeXml(contact.displayName)}</b></a></p>`;
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

    const processedText = hasText ? convertEmojisToAscii(trimmedText) : '';

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
    if (hasImage) {
      const media = new MessageMedia(
        imageFile.mimetype,
        imageFile.buffer.toString('base64'),
        imageFile.originalname
      );
      await client.sendMessage(targetJid, media, { caption: processedText });
    } else {
      await client.sendMessage(targetJid, processedText);
    }

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
        const result = stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, null, targetJid, null);
        insertedMessageId = result.lastInsertRowid;
      } else {
        const result = stmts.insertMessage.run(finalText, daySend, hourSend, 1, null, targetJid);
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
            finalName = contact.name || contact.pushname || contact.verifiedName || contact.shortName || finalName;
          }
        } catch (e) {}
        stmts.upsertUser.run(targetJid, finalName);
      }
      if (hasImage) {
        const result = stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, targetJid, null, null);
        insertedMessageId = result.lastInsertRowid;
      } else {
        const result = stmts.insertMessage.run(finalText, daySend, hourSend, 1, targetJid, null);
        insertedMessageId = result.lastInsertRowid;
      }
      urlDestino = `/usuario/${encodeURIComponent(targetJid)}`;
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
      fromToLabel = `Grupo: ${escapeXml(message.group_name || 'Grupo sin nombre')}`;
      backUrl = `/grupo/${encodeURIComponent(message.group_id)}`;
    } else if (message.user_chat_id) {
      const isOutgoing = Number(message.from_me) === 1;
      const name = escapeXml(message.username || message.user_chat_id.replace(/@.*$/, ''));
      fromToLabel = isOutgoing ? `Para: ${name}` : `De: ${name}`;
      backUrl = `/usuario/${encodeURIComponent(message.user_chat_id)}`;
    }

    const sentAt = message.hour_send || `${message.day_send} 00:00:00`;
    const timeMatch = sentAt.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    const dateTimeLabel = timeMatch
      ? `${timeMatch[1]} ${timeMatch[2]}`
      : escapeXml(sentAt);

    const isSticker = Number(message.is_sticker) === 1;
    let contentHtml = '';

    if (isSticker && attachment?.file_path_thumb) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_thumb)}" alt="Sticker" width="40"/></p>`;
    } else if (attachment?.file_path_view) {
      contentHtml += `<p><img src="${escapeXml(attachment.file_path_view)}" alt="Imagen" width="${attachment.view_width || 120}" height="${attachment.view_height || 90}"/></p>`;
    }

    if (message.text && message.text !== '[Imagen]') {
      contentHtml += `<p>${escapeXml(message.text)}</p>`;
    } else if (!attachment?.file_path_view && !isSticker) {
      contentHtml += `<p>${escapeXml(message.text || '')}</p>`;
    }

    if (!isSticker && attachment?.file_path_full) {
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
