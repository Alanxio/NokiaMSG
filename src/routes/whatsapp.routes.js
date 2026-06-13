import { Router } from 'express';
import { showQrPage, getQrApi, getStatusApi, logoutWhatsappPage } from '../controller/whatsapp.controller.js';

const router = Router();

router.get('/qr', showQrPage);
router.get('/qr/json', getQrApi);
router.get('/status', getStatusApi);
router.get('/logout', logoutWhatsappPage);

export default router;
