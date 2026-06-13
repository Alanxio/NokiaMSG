import { Router } from 'express';
import { showLogin, processLogin, processLogout } from '../controller/auth.controller.js';

const router = Router();

router.get('/login', showLogin);
router.post('/login', processLogin);
router.get('/logout', processLogout);
router.post('/logout', processLogout);

export default router;
