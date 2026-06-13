import { Router } from 'express';
import { showHome } from '../controller/home.controller.js';

const router = Router();

router.get('/', showHome);

export default router;
