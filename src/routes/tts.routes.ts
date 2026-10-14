import { Hono } from 'hono';
import { ttsController } from '../controllers/tts.controller';
import { precacheController } from '../controllers/precache.controller';

const router = new Hono();

router.get('/', (c) => ttsController.handleTts(c));
router.get('/stream-audio', (c) => ttsController.handleTts(c)); // Backward compatibility
router.post('/precache', (c) => precacheController.handlePrecache(c));

export default router;
