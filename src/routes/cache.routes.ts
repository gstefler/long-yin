import { Hono } from 'hono';
import { cacheController } from '../controllers/cache.controller';

const router = new Hono();

router.get('/status', (c) => cacheController.getStatus(c));

export default router;
