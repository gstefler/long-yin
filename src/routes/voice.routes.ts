import { Hono } from 'hono';
import { voiceController } from '../controllers/voice.controller';

const router = new Hono();

router.get('/', (c) => voiceController.getVoices(c));

export default router;
