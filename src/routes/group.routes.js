import { Router } from 'express';
import {
  listGroups,
  showGroupMessages,
  showGroupDetails,
  toggleGroupMute,
  confirmDeleteGroup,
  deleteGroup,
} from '../controller/group.controller.js';

const router = Router();

router.get('/', listGroups);
router.get('/:id/detalles', showGroupDetails);
router.get('/:id/silenciar', toggleGroupMute);
router.get('/:id/eliminar', confirmDeleteGroup);
router.post('/:id/eliminar', deleteGroup);
router.get('/:id', showGroupMessages);


export default router;
