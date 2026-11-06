import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { SmartSpectraSDK, CameraSelection, ProcessingStatus, MetricType } from '@smartspectra/node-sdk';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

const root = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.SMARTSPECTRA_API_KEY || '';
const videoPath = process.env.QUIETCUE_VIDEO_PATH || '';
const clients = new Set();
let sdk = null, originUs = null, timeMs = 0;
let validation = { code: null, hint: 'Start a local camera or consented video to receive SDK validation.' };
let state = { status: 'ready', source: null, keyConfigured: Boolean(apiKey),
  videoConfigured: Boolean(videoPath && existsSync(videoPath)),
  hint: 'The SDK runs on this computer. Choose a local input after reading the camera and data notice.' };

function send(event, data) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function update(patch) { state = { ...state, ...patch }; send('state', state); }
function relativeTime(us) {
  const n = Number(us);
  if (originUs === null) originUs = n;
  timeMs = Math.max(0, (n - originUs) / 1000);
  return timeMs;
}
function numberOrNull(value) { return Number.isFinite(value) ? value : null; }
// Current development packets have gaps up to 4.015 s for rate and 0.245 s
// for talking. These source-time limits cover that replay; calibrate them
// against the first consented adult recording when it arrives.
const SIGNAL_TTL_MS = { rate: 10_000, upperTrace: 1_000, talking: 1_000 };
let latestSignal, latestSignalAtMs;
function resetSignal() {
  latestSignal = { rate: null, confidence: null, upperTrace: null, talking: null };
  latestSignalAtMs = { rate: null, upperTrace: null, talking: null };
}
resetSignal();
function validationStatus(code, us, hint) {
  const tMs = relativeTime(us);
  validation = { code, hint };
  if (code !== 0) resetSignal();
  send('validation', { ...validation, tMs });
}
function signal(buf, us) {
  const tMs = relativeTime(us);
  const m = decodeMetrics(buf);
  const rate = m.breathing?.rate?.at(-1);
  const chest = m.breathing?.upperTrace?.at(-1);
  const talking = m.face?.talking?.at(-1);
  // Retain sparse observations within their own age limit. Quality loss
  // clears the cache, including measurements received during that loss.
  if (validation.code !== 0) resetSignal();
  else {
    if (rate) {
      latestSignal.rate = numberOrNull(rate.value);
      latestSignal.confidence = numberOrNull(rate.confidence);
      latestSignalAtMs.rate = tMs;
    }
    if (chest) {
      latestSignal.upperTrace = numberOrNull(chest.value);
      latestSignalAtMs.upperTrace = tMs;
    }
    if (talking) {
      latestSignal.talking = typeof talking.detected === 'boolean' ? talking.detected : null;
      latestSignalAtMs.talking = tMs;
    }
    for (const field of ['rate', 'upperTrace', 'talking']) {
      if (latestSignalAtMs[field] !== null && tMs - latestSignalAtMs[field] > SIGNAL_TTL_MS[field]) {
        latestSignal[field] = null;
        latestSignalAtMs[field] = null;
        if (field === 'rate') latestSignal.confidence = null;
      }
    }
  }
  send('signal', { source: 'smartspectra', tMs, ...latestSignal, validation });
}
async function stop() {
  const old = sdk;
  if (!old) return;
  update({ status: 'stopping', hint: 'Finishing the native session.' });
  await old.destroy(); // The native runtime is process-global; release this instance before another.
  sdk = null;
  update({ status: 'idle', hint: 'Session finished. Run notes remain in this browser until reload or export.' });
}
async function start(mode, consent) {
  if (consent !== true) throw Object.assign(new Error('Read and accept the adult camera/data notice before starting.'), { status: 400 });
  if (!apiKey) throw Object.assign(new Error('Set SMARTSPECTRA_API_KEY in your terminal, then start the server again.'), { status: 422 });
  if (sdk) throw Object.assign(new Error('Finish the current session before starting another.'), { status: 409 });
  if (!['camera', 'file'].includes(mode)) throw Object.assign(new Error('Choose camera or file input.'), { status: 400 });
  if (mode === 'file' && !state.videoConfigured) throw Object.assign(new Error('Set QUIETCUE_VIDEO_PATH to your consented MP4 before starting the server.'), { status: 422 });
  originUs = null; timeMs = 0;
  resetSignal();
  validation = { code: null, hint: 'The SDK is checking framing, light and measurement readiness.' };
  sdk = new SmartSpectraSDK({ apiKey, enableTelemetry: false,
    requestedMetrics: [MetricType.CHEST_BREATHING, MetricType.BREATHING_RATE, MetricType.TALKING] });
  sdk.on('metrics', signal);
  sdk.on('validationStatus', validationStatus);
  sdk.on('processingStatus', status => {
    if (status === ProcessingStatus.kRunning) update({ status: 'running', hint: 'Native SmartSpectra signals are arriving from your input.' });
    else if (status === ProcessingStatus.kError) update({ status: 'error', hint: 'The native session stopped with an SDK error. Read the error below.' });
    else if (status === ProcessingStatus.kIdle && state.status === 'running') update({ status: 'idle', hint: 'Input playback finished. Stop this session before choosing another.' });
  });
  sdk.on('error', (code, message, retryable) => {
    const clean = String(message).replaceAll(apiKey, '[redacted]');
    update({ status: 'error', hint: clean }); send('error', { code, message: clean, retryable });
  });
  // Interactive replay of a 30-fps recording; for a different source fps, adjust
  // this SDK delay when that recording arrives. SDK timestamps remain the clock.
  if (mode === 'file') sdk.useFile(videoPath, { interframeDelayMs: 33 });
  else sdk.useCamera(CameraSelection.default);
  update({ status: 'starting', source: mode, hint: 'Starting your native input. The first quiet breathing window takes 30 seconds.' });
  try { sdk.start(); }
  catch (error) {
    await stop(); // A synchronous input failure still owns the native instance.
    throw error;
  }
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); clients.add(res);
      res.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(200, state);
    if (req.method === 'POST' && url.pathname === '/api/start') {
      let text = ''; for await (const b of req) text += b;
      const input = JSON.parse(text || '{}'); await start(input.mode, input.consent);
      return json(200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') { await stop(); return json(200, state); }
    if (req.method !== 'GET') return json(405, { error: 'Use the documented GET or POST route.' });
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // This is a loopback desktop server. Serve only the frontend tree; keep credentials outside it.
    if (!/^[\w./-]+$/.test(path) || path.split('/').includes('..')) return json(404, { error: 'Page not found.' });
    const data = await readFile(join(root, 'public', path));
    const extension = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': mime[extension] || 'application/octet-stream' }); res.end(data);
  } catch (error) { json(error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.message }); }
});
server.listen(Number(process.env.PORT || 3795), '127.0.0.1', () => console.log(`QuietCue ready at http://127.0.0.1:${process.env.PORT || 3795}`));
process.on('SIGINT', async () => { await stop(); server.close(); process.exit(0); });
process.on('SIGTERM', async () => { await stop(); server.close(); process.exit(0); });
