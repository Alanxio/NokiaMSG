import { Router } from 'express';
import { renderComposePage, serveAudioDescriptor, showMessageDetail, showMessageReadReceipts, validateAndCreateChat, voteOnPoll } from '../controller/message.controller.js';

const router = Router();

// Muestra la vista del buscador en el Nokia (GET)
router.get('/componer', renderComposePage);

// Votar/cambiar voto en una encuesta (GET, reversible — antes del catch-all de abajo)
router.get('/:id/votar/:optionId', voteOnPoll);

// Ver quién leyó un mensaje saliente (antes del catch-all de abajo)
router.get('/:id/leidos', showMessageReadReceipts);

// Nota de voz / audio convertido a AMR para el Nokia (antes del catch-all de abajo)
router.get('/:id/escuchar.dd', serveAudioDescriptor);

// Detalle de un mensaje (GET)
router.get('/:id', showMessageDetail);

// Procesa la validación e inicio de chats con números externos (POST)
router.post('/validar-y-crear', validateAndCreateChat);

export default router;
