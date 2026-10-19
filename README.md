# 🐉 龙吟 Lóng Yín | Neural Chinese TTS API

A lightweight, high-performance Chinese Text-to-Speech (TTS) microservice built with **Bun** and **Hono**. It generates natural-sounding Mandarin speech with Microsoft's neural voices — through the official **Azure AI Speech** API when a key is configured, otherwise through Microsoft Edge's free read-aloud endpoint — featuring robust dual-layer caching for ultra-low latency.

Designed to run as a backend microservice (e.g., inside an internal network behind a proxy) or direct integration in client-side applications (Vue, React, Svelte, etc.).

---

## ✨ Features

- ⚡ **Powered by Bun + Hono**: Blazing fast runtime performance, compiles down to a single standalone binary.
- 🎙️ **Standard Chinese Voices**: Pre-configured with active Mainland Chinese (`zh-CN`) voices, including standard profiles and regional accents (Liaoning, Shaanxi).
- 💾 **Dual-Layer Caching**:
  - **Server-Side**: Saves synthesized audio locally in a hashed file cache to avoid redundant platform API calls.
  - **Client-Side (Browser)**: Appends strict `Cache-Control: public, max-age=31536000, immutable` headers so browsers cache audio files locally for 0ms repeat playback latency.
- 🌐 **CORS Ready**: Configured with wildcards and exposed cache headers (`X-Cache-Status`, `X-Response-Time-Ms`) for simple frontend fetches.
- 🩺 **Self-Monitoring**: `/health` check route reporting cache sizes, file counts, and uptime, plus `/api/cache/status` for a fuller picture of the cache (by voice, by last use, hit rate).
- 🐳 **Dockerized**: Multi-stage Docker builds compiled into a minimal standalone Alpine image (~95MB).

---

## 🚀 Getting Started

### Prerequisites
- [Bun](https://bun.sh/) (v1.3+ recommended) or [Docker](https://www.docker.com/)

### Running Locally with Bun
1. Install dependencies:
   ```bash
   bun install
   ```
2. Start the development server (with hot-reloading):
   ```bash
   bun run dev
   ```
3. The server starts on `http://localhost:3000`.

### Running with Docker Compose
To run the service in the background with a persistent cache volume:
```bash
docker compose up -d --build
```

---

## 📡 API Endpoints

Refer to [openapi.yaml](openapi.yaml) for full specification types.

### 1. Health Status (`GET /health`)
Check system status and cache directory metrics.
```bash
curl http://localhost:3000/health
```
**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-06-11T15:04:23.321Z",
  "uptime": 120.4,
  "cache": {
    "directory": "/app/audio-cache",
    "fileCount": 18,
    "sizeBytes": 464256,
    "sizeKB": 453
  }
}
```

### 2. List Voices (`GET /api/voices`)
Lists active Mandarin voices with their genders, regional accents, and pre-configured A1-level demo sentences.
```bash
curl http://localhost:3000/api/voices
```
**Response:**
```json
[
  {
    "id": "zh-CN-XiaoxiaoNeural",
    "name": "Xiaoxiao",
    "displayName": "Xiaoxiao (Standard Female)",
    "gender": "Female",
    "region": "Mainland China",
    "demoText": "你好，我是晓晓。今天天气很好，你想去公园吗？",
    "demoUrl": "/api/tts?text=%E4%BD%A0%E5%A5%BD%EF%BC%8C%E6%88%91%E6%98%AF%E6%99%AF%E5%A5%87%E3%80%82...&voice=zh-CN-XiaoxiaoNeural"
  }
]
```

### 3. Synthesize Speech (`GET /api/tts`)
Generates speech audio from Chinese text.

**Parameters:**
- `text` (String, Required): Chinese characters/sentences to synthesize (max 500 chars, trimmed).
- `voice` (String, Optional): Voice ID (default: `zh-CN-XiaoxiaoNeural`).
- `rate` (String, Optional): Speed variation (e.g. `+10%`, `-15%`).
- `pitch` (String, Optional): Pitch variation (e.g. `+5Hz`, `-10Hz`).

```bash
curl -i "http://localhost:3000/api/tts?text=%E9%BA%A6%E5%BD%93%E5%8A%B3"
```
**Response Headers:**
```http
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Cache-Control: public, max-age=31536000, immutable
X-Cache-Status: HIT
X-Cache-Filename: %E9%BA%A6%E5%BD%93%E5%8A%B3_c48cda3051f8.mp3
```

---

### 4. Precache a Batch (`POST /api/tts/precache`)
Makes sure a list of texts is in the audio cache, synthesizing only what is missing — on Edge over **one reused connection to Microsoft**, so a whole dialogue costs a single handshake instead of one per line; on Azure one request per line, paced by the rate limiter. Items take the same parameters as `GET /api/tts` and produce the same cache keys, so later playback is a `HIT`.
```bash
curl -X POST http://localhost:3000/api/tts/precache -H 'content-type: application/json' \
  -d '{"items":[{"text":"你好，我叫高博。"},{"text":"你好，我是王老师。","voice":"zh-CN-YunjianNeural"}]}'
# → {"total":2,"cached":0,"synthesized":2,"failed":0}
```
Sending the same batch again is free: every item comes back as `cached`, with no connection opened, nothing synthesized and nothing taken from the rate limit. That holds even while the first batch is still running — a line it has taken on but not reached yet is skipped by the second batch rather than synthesized twice.

### 5. Cache Status (`GET /api/cache/status`)
How full the audio cache is, what is in it and how playback has fared — the data behind 中文通's admin cache panel. Aggregates only: no texts or filenames are returned.
```bash
curl http://localhost:3000/api/cache/status
```
- `disk` — files, bytes, and the eviction limits (`maxBytes`, `targetBytes`).
- `lastUsed` — files and bytes played or written within 1, 7 and 30 days, and older.
- `voices` — files and bytes per voice, biggest first. Voices are recorded in `audio-cache/.index.json` as files are saved; files cached before that are listed last with `voice: null`.
- `activity` — since the process started: `hits`, `misses` (synthesized for playback), `precached` and `failed`, in total and for each of the last 24 hours. In memory, so a restart starts counting again.
- `inFlight`, `evictions` (since start) and, on Azure, `rateLimit` (requests used in the current window, and queued).

---

## 🔑 Speech Provider: Azure AI Speech or Edge

Set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` and every cache miss is synthesized by **Azure AI Speech**, the keyed and documented API behind the same `zh-CN-*Neural` voices. Voice ids, `rate`/`pitch`/`volume` and the MP3 format are unchanged, so cache keys stay the same and an existing cache keeps serving. Leave them unset and the service uses the Edge read-aloud endpoint as before (see the next section). `GET /health` reports which one is active as `provider`.

**Setting it up:** in the Azure portal create a **Speech** resource (Azure AI services), pick a region (e.g. `westeurope`) and the **Free F0** tier, then copy **KEY 1** and the **Location/Region** from *Keys and Endpoint*.

**Free tier limits** (October 2026): 0.5 million billable characters a month, and **20 syntheses per 60 seconds**. Azure bills each hanzi as **two** characters, plus any SSML markup other than `<speak>`/`<voice>` — so a neutral `<prosody>` is left out of the request. Over the monthly allowance F0 answers 429 until the month resets; S0 costs about $15 per million characters and allows 30 syntheses per second (set `AZURE_SPEECH_RPM` to match).

**Rate limiting:** syntheses go through an in-process sliding-window limiter sized by `AZURE_SPEECH_RPM`. Precache items queue behind playback and never take the last quarter of the window, so a play tap isn't stuck behind a dialogue's batch; on the free tier a 60-line dialogue precaches in about four minutes. Throttling (429) and server errors are retried, honouring `Retry-After`; a bad key or an unknown voice fails at once.

---

## 🛡️ Reliability: Microsoft's Handshake Refusals (Edge only)

Microsoft's Edge read-aloud endpoint intermittently refuses the websocket handshake with an HTTP 403 — about a third of connections at a trickle and over half after a burst (October 2026). Once a socket is open, synthesis succeeds. The service copes in three ways:

- **Patched library** (`patches/`, applied by `bun install`): unpatched, `edge-tts-universal` waited forever for a refused socket to open, so the request hung until something timed it out.
- **Retries** with exponential backoff (up to 6 attempts) for single syntheses, plus connect and per-attempt timeouts.
- **Connection reuse** in the precache route, which pays for one handshake per batch.

Requests that may wait on retries are covered by a 60 s server idle timeout (Bun's default is 10 s).

---

## ⚙️ Configuration & Cache Eviction

The service maintains a self-cleaning local cache directory. Eviction runs **asynchronously in the background** when a new file is saved, ensuring zero request latency overhead.

### Environment Variables

You can configure the service using the following environment variables (which can be mapped in `docker-compose.yml` or passed directly to Bun):

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | The network port the server listens on. | `3000` |
| `NODE_ENV` | Environment mode (`development` or `production`). In `development` mode, requests to `/api/tts` print beautified telemetry JSON logs to the console. | `development` |
| `MAX_CACHE_SIZE_MB` | The absolute maximum size limit for the local cache directory before triggering eviction. | `500` |
| `TARGET_CACHE_SIZE_MB` | The target size the cache folder is shrunk to during eviction. | `350` |
| `AZURE_SPEECH_KEY` | Azure AI Speech resource key. With the region set, switches synthesis from Edge to Azure. | *(unset)* |
| `AZURE_SPEECH_REGION` | The Speech resource's region, e.g. `westeurope`. | *(unset)* |
| `AZURE_SPEECH_RPM` | Syntheses allowed per 60 s. F0's fixed limit is 20. | `20` |

### Cache Eviction Mechanism (LRU)
1. When a cache `MISS` occurs and a new MP3 is saved, the service checks the folder size.
2. If the folder size exceeds `MAX_CACHE_SIZE_MB`, files are sorted by their modification time (`mtime`), oldest first. Every `HIT` touches its file's `mtime`, so this is the least recently *played* order, not the order files were written in.
3. Files are deleted one by one until the total cache directory size falls below `TARGET_CACHE_SIZE_MB`.

