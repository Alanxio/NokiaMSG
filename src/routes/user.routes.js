import { Router } from 'express';
import { listUsers, showUserMessages } from '../controller/user.controller.js';

const router = Router();

router.get('/', listUsers);
router.get('/:id', showUserMessages);


export default router;
