import { Router } from 'express';
import { renderComposePage, validateAndCreateChat } from '../controller/message.controller.js';

const router = Router();

// Muestra la vista del buscador en el Nokia (GET)
router.get('/componer', renderComposePage);

// Procesa la validación e inicio de chats con números externos (POST)
router.post('/validar-y-crear', validateAndCreateChat);

export default router;
