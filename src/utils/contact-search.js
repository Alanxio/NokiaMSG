// Resultados de «Buscar en WhatsApp»: une a la misma persona aunque llegue varias veces.
//
// WhatsApp identifica a cada persona por dos ids: su número (…@c.us) y un id interno
// (…@lid). La agenda del móvil (getContacts) la trae por número y con el nombre de la
// agenda; la BD del Nokia y el contacto @lid, con el nombre de perfil. Comparar por nombre
// no basta («Toni» vs «Antonio García»), así que se unen por esos ids: los del propio
// resultado y los que da WhatsApp (getContactLidAndPhone → { lid, pn }).
//
// candidate: { chatId, displayName, hasRealName, isBusiness, isMyContact }
//   hasRealName: nombre de la agenda del móvil (el mejor para mostrar).
// aliases: Map(chatId → { lid, pn }) — puede faltar alguno (WhatsApp no respondió).
// existingIds: Set de ids con chat en el Nokia — si la persona ya tiene chat, se usa ese id.
//
// Devuelve un resultado por persona, en el orden en que apareció por primera vez:
// { chatId, displayName, hasRealName, isBusiness, isMyContact, ids, pn }.
export function mergeContactCandidates(candidates, { aliases = new Map(), existingIds = new Set() } = {}) {
  const groups = [];
  const groupById = new Map();

  for (const candidate of candidates) {
    const alias = aliases.get(candidate.chatId) || {};
    const ids = [candidate.chatId, alias.lid, alias.pn].filter((id) => typeof id === 'string' && id.includes('@'));

    // Todos los grupos que ya comparten alguno de estos ids se funden en uno.
    const matched = [...new Set(ids.map((id) => groupById.get(id)).filter(Boolean))];
    let group = matched[0];
    if (!group) {
      group = { members: [], ids: new Set(), pn: null, order: groups.length };
      groups.push(group);
    }
    for (const other of matched.slice(1)) {
      group.members.push(...other.members);
      for (const id of other.ids) group.ids.add(id);
      group.pn ||= other.pn;
      group.order = Math.min(group.order, other.order);
      other.merged = true;
    }
    group.members.push(candidate);
    for (const id of ids) group.ids.add(id);
    group.pn ||= alias.pn || null;
    for (const id of group.ids) groupById.set(id, group);
  }

  // Mismo nombre que uno de la agenda: la misma persona aunque no se haya podido resolver su
  // LID/número (lo que ya hacía antes el buscador). Hace falta que uno de los dos sea de la
  // agenda: dos «Pablo» que solo son nombre de perfil pueden ser personas distintas.
  const agendaGroupByName = new Map();
  for (const group of groups) {
    if (group.merged) continue;
    for (const member of group.members) {
      const name = normalizeName(member.displayName);
      if (name && member.hasRealName && !agendaGroupByName.has(name)) agendaGroupByName.set(name, group);
    }
  }
  for (const group of groups) {
    if (group.merged) continue;
    const target = group.members
      .map((member) => agendaGroupByName.get(normalizeName(member.displayName)))
      .find((other) => other && other !== group && !other.merged);
    if (!target) continue;
    target.members.push(...group.members);
    for (const id of group.ids) target.ids.add(id);
    target.pn ||= group.pn;
    target.order = Math.min(target.order, group.order);
    group.merged = true;
  }

  return groups
    .filter((group) => !group.merged)
    .sort((a, b) => a.order - b.order)
    .map((group) => {
      const best = [...group.members].sort(compareForDisplay)[0];
      const ids = [...group.ids];
      // Id del resultado: el del chat que ya existe en el Nokia (así se abre esa misma
      // conversación); si no, el del mejor candidato.
      const chatId = ids.find((id) => existingIds.has(id)) || best.chatId;
      return {
        chatId,
        displayName: best.displayName,
        hasRealName: group.members.some((m) => m.hasRealName),
        isBusiness: group.members.every((m) => m.isBusiness),
        isMyContact: group.members.some((m) => m.isMyContact),
        isExistingContact: ids.some((id) => existingIds.has(id)),
        ids,
        pn: group.pn,
      };
    });
}

function normalizeName(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

// Primero el nombre de la agenda, luego cuentas personales (no de empresa), luego @c.us.
function compareForDisplay(a, b) {
  const score = (c) => (c.hasRealName && c.isMyContact ? 4 : 0) + (c.hasRealName ? 2 : 0)
    + (c.isBusiness ? 0 : 1) + (String(c.chatId).endsWith('@lid') ? 0 : 0.5);
  return score(b) - score(a);
}
