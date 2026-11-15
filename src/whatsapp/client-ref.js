// Referencia viva al cliente de whatsapp-web.js en uso (null si no hay ninguno).
//
// Vive en su propio módulo para que cualquier parte de src/whatsapp/ pueda leerla sin
// importar el ciclo de vida (que a su vez registra los manejadores de eventos): así las
// dependencias van en un solo sentido y no hay imports circulares.
//
// `client` es un enlace vivo de ES modules: quien lo importa ve siempre el valor actual,
// pero solo este módulo puede reasignarlo, a través de setClient(). Lo hace únicamente el
// ciclo de vida del cliente (whatsapp.service.js).
export let client = null;

export function setClient(value) {
  client = value;
}
