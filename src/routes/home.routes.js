import { Router } from 'express';
import { showHome, markAllAsRead } from '../controller/home.controller.js';

const router = Router();

router.get('/', showHome);
router.get('/leer-todo', markAllAsRead);

export default router;
