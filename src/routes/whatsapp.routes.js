import { Router } from 'express';
import { showQrPage, waitQrChange, serveQrImage, requestPairingCodePage, getQrApi, getStatusApi, logoutWhatsappPage } from '../controller/whatsapp.controller.js';

const router = Router();

router.get('/qr', showQrPage);
router.get('/qr/wait', waitQrChange);
router.get('/qr/img/:file', serveQrImage);
router.get('/qr/codigo', requestPairingCodePage);
router.get('/qr/json', getQrApi);
router.get('/status', getStatusApi);
router.get('/logout', logoutWhatsappPage);

export default router;
