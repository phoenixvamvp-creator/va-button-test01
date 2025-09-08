// /api/va.js
// Single serverless function that handles /api/chat, /api/transcribe, /api/speak, /api/search, /api/dispatch
// Works on Vercel Hobby (one function). Use with vercel.json rewrites:
// { "version": 2, "rewrites": [{ "source": "/api/(.*)", "destination": "/api/va" }] }

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

/* ---------------------------- helpers ---------------------------- */

function error(res, code, msg) {
  res.status(code).json({ error: msg });
}
function notAllowed(res) {
  error(res, 405, 'Method not allowed');
}
function routeFromReq(req) {
  // Extract the first path segment after /api/
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segs = url.pathname.replace(/^\/+|\/+$/g, '').split('/'); // ["api","transcribe", ...]
  return segs[1] || '';
}
function parseDataUrl(dataUrl) {
  // data:[<mime>];base64,<content>
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  return { mime, buf };
}
async function openaiJSON(path, payload) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OpenAI ${path} ${r.status} ${r.statusText}: ${t}`);
  }
  return r.json();
}
async function openaiForm(path, form) {
  // IMPORTANT: no Content-Type header so fetch sets multipart boundary
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OpenAI ${path} ${r.status} ${r.statusText}: ${t}`);
  }
  return r.json();
}
async function openaiBinary(path, payload) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OpenAI ${path} ${r.status} ${r.statusText}: ${t}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/* ---------------------------- handlers --------------------------- */

async function handleChat(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  // accept either JSON body or x-www-form-urlencoded (defensive)
  const { message } = req.body || {};
  if (!message || !String(message).trim())
    return error(res, 400, 'Missing message');

  try {
    const data = await openaiJSON('chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: String(message) }],
      temperature: 0.7,
    });
    const reply = data?.choices?.[0]?.message?.content || '(no reply)';
    res.status(200).json({ reply });
  } catch (e) {
    error(res, 500, String(e));
  }
}

async function handleTranscribe(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  const { audio } = req.body || {};
  if (!audio) return error(res, 400, 'Missing "audio" (data URL)');

  try {
    const parsed = parseDataUrl(audio);
    if (!parsed) return error(res, 400, 'Invalid data URL');

    const { mime, buf } = parsed; // e.g. "audio/webm;codecs=opus"
    const lower = (mime || '').toLowerCase();

    // Choose an extension Whisper accepts; default to webm
    let ext = 'webm';
    if (lower.includes('ogg') || lower.includes('oga')) ext = 'ogg';
    else if (lower.includes('mp4')) ext = 'mp4';
    else if (lower.includes('mp3')) ext = 'mp3';
    else if (lower.includes('mpeg') || lower.includes('mpga')) ext = 'mp3';
    else if (lower.includes('wav')) ext = 'wav';
    else if (lower.includes('m4a')) ext = 'm4a';

    // Use Blob + filename (Node 18+ global Blob/FormData supported on Vercel)
    const form = new FormData();
    const blob = new Blob([buf], { type: `audio/${ext}` });
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-1');

    const data = await openaiForm('audio/transcriptions', form);
    res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    // Ensure we always return JSON (so the frontend never sees HTML)
    console.error('Transcribe error:', e);
    error(res, 500, String(e));
  }
}

async function handleSpeak(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  const { text, voice = 'alloy' } = req.body || {};
  if (!text || !String(text).trim()) return error(res, 400, 'Missing text');

  try {
    const buf = await openaiBinary('audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice,
      input: String(text),
      format: 'mp3',
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (e) {
    error(res, 500, String(e));
  }
}

async function handleSearch(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  const { q } = req.body || {};
  if (!q || !String(q).trim()) return error(res, 400, 'Missing q');

  // Placeholder: wire a real search provider when ready
  res.status(200).json({ results: [] });
}

function summarize(intent, p) {
  switch (intent) {
    case 'searchDrive':
      return `I would search Drive in the ${p.folder} folder for "${p.query}".`;
    case 'searchSheets':
      return `I would read range ${p.range} from sheet ${p.sheetName} in ${p.fileName}${
        p.query ? ` where ${p.query}` : ''
      }.`;
    case 'adjustSheets':
      return p.op === 'append'
        ? `I would append rows to ${p.sheetName} in ${p.fileName}.`
        : `I would set ${p.range} in ${p.sheetName} of ${p.fileName}.`;
    case 'adjustCalendar':
      return p.action === 'create'
        ? `I would create a calendar event "${p.title}" ${p.when}.`
        : `I would move "${p.title}" to ${p.when}.`;
    case 'searchWeb':
      return `I would search the web for "${p.query}".`;
    default:
      return `I didn’t classify that request yet.`;
  }
}
async function handleDispatch(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  const { intent, params = {}, context = {} } = req.body || {};
  const data = { mock: true, intent, params, context };
  const summary = summarize(intent, params);
  res.status(200).json({ status: 'ok', data, summary });
}

/* ------------------------------ router --------------------------- */

export default async function handler(req, res) {
  const route = routeFromReq(req); // "", "chat", "transcribe", "speak", "search", "dispatch", ...
  try {
    if (route === '' && req.method === 'GET') {
      return res
        .status(200)
        .json({ ok: true, routes: ['chat', 'transcribe', 'speak', 'search', 'dispatch'] });
    }
    if (route === 'chat') return handleChat(req, res);
    if (route === 'transcribe') return handleTranscribe(req, res);
    if (route === 'speak') return handleSpeak(req, res);
    if (route === 'search') return handleSearch(req, res);
    if (route === 'dispatch' || route === 'intent') return handleDispatch(req, res);

    return error(res, 404, `Unknown route: ${route}`);
  } catch (e) {
    return error(res, 500, String(e));
  }
}
