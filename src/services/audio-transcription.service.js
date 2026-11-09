import { stmts } from '../../db/db.js';
import { transcribirAudio } from '../utils/transcribir.js';

const transcriptionsInProgress = new Map();

export function queueAudioTranscription(messageId, audioPath) {
  if (transcriptionsInProgress.has(messageId)) {
    return transcriptionsInProgress.get(messageId);
  }

  const transcription = Promise.resolve()
    .then(() => transcribirAudio(audioPath))
    .then((result) => {
      if (!result.texto) {
        console.warn(`[transcripcion] No se detectó voz en el audio del mensaje ${messageId}.`);
        return null;
      }

      stmts.saveMessageTranscription.run(result.texto, messageId);
      console.log(`[transcripcion] Audio del mensaje ${messageId} transcrito.`);
      return result.texto;
    })
    .catch((error) => {
      console.error(`[transcripcion] No se pudo transcribir el mensaje ${messageId}:`, error);
      return null;
    })
    .finally(() => {
      transcriptionsInProgress.delete(messageId);
    });

  transcriptionsInProgress.set(messageId, transcription);
  return transcription;
}
