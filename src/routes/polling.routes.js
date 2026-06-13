import { Router } from 'express';
import { checkAuthStatus, checkMessages } from '../controller/polling.controller.js';

const router = Router();

router.get('/check-auth-status', checkAuthStatus);
router.get('/check-messages', checkMessages);

export default router;