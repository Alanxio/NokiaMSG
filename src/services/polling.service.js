export const pollingState = {
  huboNovedad: false,
  ultimoMensaje: null,
  timestampUltimaNovedad: null,
};

export function marcarNovedad(msg) {
  pollingState.huboNovedad = true;
  pollingState.ultimoMensaje = msg;
  pollingState.timestampUltimaNovedad = Date.now();
}

export function limpiarNovedad() {
  pollingState.huboNovedad = false;
}

export function getPollingState() {
  return pollingState;
}