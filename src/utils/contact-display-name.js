// Orden deliberado de presentación para no enseñar un identificador técnico de
// WhatsApp cuando conocemos algo mejor de la persona.
//
// 4: nombre guardado por el dueño de la cuenta (contact.name)
// 3: nombre que la propia persona publica en WhatsApp
// 2: teléfono personal resuelto
// 1: identificador/número que entrega WhatsApp como último recurso
export const CONTACT_NAME_PRIORITY = Object.freeze({
  BUSINESS_NUMBER: 1,
  PERSONAL_PHONE: 2,
  PROFILE_NAME: 3,
  SAVED_CONTACT: 4,
});

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.includes('@')) return null;
  return name.slice(0, 100);
}

export function getContactDisplayName(contact) {
  const savedName = cleanName(contact?.name);
  if (savedName) {
    return { name: savedName, priority: CONTACT_NAME_PRIORITY.SAVED_CONTACT };
  }

  // pushname es el nombre que configura el propietario de la cuenta. shortName
  // es el respaldo que algunas versiones de WhatsApp Web exponen en su lugar.
  const profileName = cleanName(contact?.pushname) || cleanName(contact?.shortName);
  if (profileName) {
    return { name: profileName, priority: CONTACT_NAME_PRIORITY.PROFILE_NAME };
  }

  return null;
}

export function formatWhatsappIdentifier(chatId) {
  const identifier = typeof chatId === 'string' ? chatId.split('@')[0].replace(/\D/g, '') : '';
  return identifier ? `+${identifier}` : 'Desconocido';
}
