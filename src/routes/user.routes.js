import { Router } from 'express';
import {
  listUsers,
  showUserMessages,
  showUserDetails,
  showUserAvatar,
  toggleUserMute,
  confirmDeleteUser,
  deleteUser,
} from '../controller/user.controller.js';

const router = Router();

router.get('/', listUsers);
router.get('/:id/detalles', showUserDetails);
router.get('/:id/foto', showUserAvatar);
router.get('/:id/silenciar', toggleUserMute);
router.get('/:id/eliminar', confirmDeleteUser);
router.post('/:id/eliminar', deleteUser);
router.get('/:id', showUserMessages);


export default router;
