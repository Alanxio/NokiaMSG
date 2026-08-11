import { Router } from 'express';
import {
  listGroups,
  showGroupMessages,
  toggleGroupMute,
  confirmDeleteGroup,
  deleteGroup,
} from '../controller/group.controller.js';

const router = Router();

router.get('/', listGroups);
router.get('/:id/silenciar', toggleGroupMute);
router.get('/:id/eliminar', confirmDeleteGroup);
router.post('/:id/eliminar', deleteGroup);
router.get('/:id', showGroupMessages);


export default router;
