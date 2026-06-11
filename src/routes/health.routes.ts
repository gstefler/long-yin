import { Hono } from 'hono';
import { healthController } from '../controllers/health.controller';

const router = new Hono();

router.get('/', (c) => healthController.getHealth(c));

export default router;
