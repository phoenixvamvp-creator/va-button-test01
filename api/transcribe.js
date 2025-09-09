// /api/transcribe.js
export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

function send(res, code, payload) {
  res.status(code).json(payload);
}
function err(res, code, msg) {
  send(res, code, { error: msg });
}

function parseDataUrl(dataUrl) {
  // Expect: data:audio/webm;codecs=opus;base64,AAAA...
  if (typeof dataUrl !== 'string') return null;
  if (!dataUrl.startsWith('data:')) return null;

  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;

  const header = dataUrl.slice(5, comma); // after "data:"
  const base64 = dataUrl.slice(comma + 1);

  // header example: "audio/webm;codecs=opus;base64"
  const parts = header.split(';').map(s => s.trim().toLowerCase());
  const mime = parts[0] || 'application/octet-stream';
  const isB64 = parts.includes('base64');
  if (!isB64) return null;

  try {
    const buf = Buffer.from(base64, 'base64');
    return { mime, buf };
  } catch {
    return null;
  }
}

function extFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('oga')) return 'ogg';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('m4a')) return 'm4a';
  if (m.includes('mp3') || m.includes('mpga') || m.includes('mpeg'))
    return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

async function callOpenAITranscribe(file, model = 'whisper-1') {
  const form = new FormData();
  form.append('file', file);          // File object with name + type
  form.append('model', model);

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, // boundary auto-set
    body: form,
  });

  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();

  if (!r.ok) {
    const message =
      typeof body === 'string'
        ? body
        : body?.error?.message || `${r.status} ${r.statusText}`;
    throw new Error(message);
  }
  return body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');
  if (!OPENAI_API_KEY) return err(res, 500, 'Missing OPENAI_API_KEY');

  // Front-end sends { audio: "data:audio/...;base64,..." }
  const { audio } = req.body || {};
  if (!audio) return err(res, 400, 'Missing "audio" (data URL)');

  try {
    const parsed = parseDataUrl(audio);
    if (!parsed) return err(res, 400, 'Invalid data URL');

    const { mime, buf } = parsed;
    if (!buf || !buf.length) return err(res, 400, 'Empty audio payload');

    const ext = extFromMime(mime);                    // keep a sane filename
    const simpleMime = mime.split(';')[0] || mime;    // e.g., "audio/webm"
    // Use File, not Blob — ensures the multipart part has both a filename and a type.
    const file = new File([buf], `audio.${ext}`, { type: simpleMime });

    const data = await callOpenAITranscribe(file, 'whisper-1');
    return send(res, 200, { text: data?.text || '' });
  } catch (e) {
    console.error('[transcribe] error:', e);
    return err(res, 500, String(e?.message || e));
  }
}
