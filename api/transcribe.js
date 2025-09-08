export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

function error(res, code, msg) { res.status(code).json({ error: msg }); }
function notAllowed(res) { error(res, 405, 'Method not allowed'); }

// data:audio/webm;codecs=opus;base64,AAAA...
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) return null;
  const header = dataUrl.slice(5, comma);
  const b64 = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(header)) return null;

  const semi = header.indexOf(';');
  const mime = (semi === -1 ? header : header.slice(0, semi)).trim() || 'application/octet-stream';
  try { Buffer.from(b64, 'base64'); } catch { return null; }
  return { mime, buf: Buffer.from(b64, 'base64') };
}

async function openaiForm(path, form) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, // let fetch set the boundary
    body: form,
  });
  if (!r.ok) throw new Error(await r.text().catch(()=>`${r.status} ${r.statusText}`));
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  const { audio } = req.body || {};
  if (!audio) return error(res, 400, 'Missing "audio" (data URL)');

  try {
    const parsed = parseDataUrl(audio);
    if (!parsed) return error(res, 400, 'Invalid data URL');
    const { mime, buf } = parsed;
    const lower = (mime || '').toLowerCase();

    let ext = 'webm';
    if (lower.includes('ogg') || lower.includes('oga')) ext = 'ogg';
    else if (lower.includes('mp4')) ext = 'mp4';
    else if (lower.includes('mp3') || lower.includes('mpga') || lower.includes('mpeg')) ext = 'mp3';
    else if (lower.includes('wav')) ext = 'wav';
    else if (lower.includes('m4a')) ext = 'm4a';

    const form = new FormData();
    const blob = new Blob([buf], { type: `audio/${ext}` });
    form.append('file', blob, `audio.${ext}`); // filename is important
    form.append('model', 'whisper-1');

    const data = await openaiForm('audio/transcriptions', form);
    res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    console.error('Transcribe error:', e);
    error(res, 500, String(e));
  }
}
