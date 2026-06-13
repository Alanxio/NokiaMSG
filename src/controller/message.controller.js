import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { escapeXml, sendPage } from './page.controller.js';

// Asegúrate de que esta ruta apunte correctamente a donde exportas el cliente
import { client } from '../services/whatsapp.service.js';

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
        <form action="/mensaje/validar-y-crear" method="POST">
          <input type="hidden" name="phone" value="${escapeXml(to)}"/>
          <input type="hidden" name="type" value="${escapeXml(type)}"/>
          <p>
            <textarea name="text" rows="5" cols="22">${escapeXml(textoPrevio)}</textarea>
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
  try {
    const { phone, text, type } = req.body;

    if (!phone || !text || text.trim() === '') {
      res.redirect('/mensaje/componer');
      return;
    }

    let targetJid = phone.trim();
    const processedText = convertEmojisToAscii(text.trim());

    if (!targetJid.includes('@')) {
      const numberDetails = await client.getNumberId(targetJid);
      if (!numberDetails) {
        const errorBody = '<h1>Error</h1><p>El número no tiene WhatsApp registrado.</p><p><a href="/mensaje/componer">Volver</a></p>';
        sendPage(req, res, 400, 'Error', errorBody);
        return;
      }
      targetJid = numberDetails._serialized;
    }

    await client.sendMessage(targetJid, processedText);

    // CONTROL ESTRICTO DE FECHA/HORA EN FORMATO SQLITE ("YYYY-MM-DD HH:MM:SS")
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const pad = (n) => String(n).padStart(2, '0');
    const daySend = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hourSend = `${daySend} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let urlDestino = '/';

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
      stmts.insertMessage.run(processedText, daySend, hourSend, 1, null, targetJid);
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
      stmts.insertMessage.run(processedText, daySend, hourSend, 1, targetJid, null);
      urlDestino = `/usuario/${encodeURIComponent(targetJid)}`;
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
