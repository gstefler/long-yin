import { Hono } from 'hono';
import { cors } from 'hono/cors';

import healthRouter from './routes/health.routes';
import ttsRouter from './routes/tts.routes';
import voiceRouter from './routes/voice.routes';
import { PORT, NODE_ENV, CACHE_DIR, MAX_CACHE_SIZE_MB, TARGET_CACHE_SIZE_MB } from './config/constants';

console.log('=========================================');
console.log('🐉 龙吟 Lóng Yín | Chinese Neural TTS API');
console.log('=========================================');
console.log(`- Port:               ${PORT}`);
console.log(`- Environment:        ${NODE_ENV}`);
console.log(`- Cache Directory:    ${CACHE_DIR}`);
console.log(`- Max Cache Size:     ${MAX_CACHE_SIZE_MB} MB`);
console.log(`- Target Cache Size:  ${TARGET_CACHE_SIZE_MB} MB`);
console.log('=========================================');

const app = new Hono();

// Global Middlewares
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    exposeHeaders: [
      'X-Cache-Status',
      'X-Cache-Filename',
      'X-Response-Time-Ms',
      'Cache-Control',
    ],
    maxAge: 600,
  })
);

// Route Bindings
app.route('/health', healthRouter);
app.route('/api/voices', voiceRouter);
app.route('/api/tts', ttsRouter);
app.route('/api', ttsRouter); // Supports legacy /api/stream-audio

// Default Fallback Route
app.all('*', (c) => {
  return c.json(
    {
      error: 'Endpoint not found. Exposing /health, /api/voices, and /api/tts',
    },
    404
  );
});

export default app;
