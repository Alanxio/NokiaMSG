import { Router } from 'express';
import { requireMobileAuth } from '../middlewares/auth.middleware.js';
import {
  mobileLogin,
  mobileLogout,
  mobileStatus,
  mobileInbox,
  mobileDirectoryUsers,
  mobileDirectoryGroups,
  mobileUserMessages,
  mobileGroupMessages,
  mobileSendMessage,
  mobileUpdates,
} from '../controller/mobile.controller.js';

const router = Router();

// Público — el resto de rutas requiere X-Nokia-Token.
router.post('/login', mobileLogin);

router.post('/logout', requireMobileAuth, mobileLogout);
router.get('/status', requireMobileAuth, mobileStatus);
router.get('/inbox', requireMobileAuth, mobileInbox);
router.get('/directory/users', requireMobileAuth, mobileDirectoryUsers);
router.get('/directory/groups', requireMobileAuth, mobileDirectoryGroups);
router.get('/users/:chatId/messages', requireMobileAuth, mobileUserMessages);
router.get('/groups/:groupId/messages', requireMobileAuth, mobileGroupMessages);
router.post('/messages', requireMobileAuth, mobileSendMessage);
router.get('/updates', requireMobileAuth, mobileUpdates);

// Catch-all propio: cualquier ruta /mobile/* no reconocida devuelve JSON, no la
// pagina XHTML 404 global (notFound en page.controller.js).
router.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no existe' } });
});

export default router;
