import { Router } from 'express';
import { listGroups, showGroupMessages } from '../controller/group.controller.js';

const router = Router();

router.get('/', listGroups);
router.get('/:id', showGroupMessages);


export default router;
