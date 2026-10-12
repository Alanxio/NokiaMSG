import { Router } from 'express';
import { renderComposePage, showMessageDetail, validateAndCreateChat, voteOnPoll } from '../controller/message.controller.js';

const router = Router();

// Muestra la vista del buscador en el Nokia (GET)
router.get('/componer', renderComposePage);

// Votar/cambiar voto en una encuesta (GET, reversible — antes del catch-all de abajo)
router.get('/:id/votar/:optionId', voteOnPoll);

// Detalle de un mensaje (GET)
router.get('/:id', showMessageDetail);

// Procesa la validación e inicio de chats con números externos (POST)
router.post('/validar-y-crear', validateAndCreateChat);

export default router;
