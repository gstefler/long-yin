import { Hono } from 'hono';
import { cors } from 'hono/cors';

import healthRouter from './routes/health.routes';
import ttsRouter from './routes/tts.routes';
import voiceRouter from './routes/voice.routes';

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
