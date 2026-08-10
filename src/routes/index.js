import { Router } from 'express';
import homeRoutes from './home.routes.js';
import userRoutes from './user.routes.js';
import groupRoutes from './group.routes.js';
import messageRoutes from './message.routes.js';
import whatsappRoutes from './whatsapp.routes.js';
import pollingRoutes from './polling.routes.js';

import authRoutes from './auth.routes.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { showSettings, saveSettings } from '../controller/settings.controller.js';

const router = Router();

// Rutas sin protección
router.use('/', authRoutes);

// Rutas protegidas
router.use('/whatsapp', requireAuth, whatsappRoutes);
router.use('/', requireAuth, homeRoutes);
router.use('/', requireAuth, pollingRoutes);
router.use('/usuario', requireAuth, userRoutes);
router.use('/grupo', requireAuth, groupRoutes);
router.use('/mensaje', requireAuth, messageRoutes);

router.get('/ajustes', requireAuth, showSettings);
router.post('/ajustes', requireAuth, saveSettings);

export default router;
