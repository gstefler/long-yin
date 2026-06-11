import { Hono } from 'hono';
import { ttsController } from '../controllers/tts.controller';

const router = new Hono();

router.get('/', (c) => ttsController.handleTts(c));
router.get('/stream-audio', (c) => ttsController.handleTts(c)); // Backward compatibility

export default router;
