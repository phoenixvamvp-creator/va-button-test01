export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

function error(res, code, msg) { res.status(code).json({ error: msg }); }
function notAllowed(res) { error(res, 405, 'Method not allowed'); }

async function openaiBinary(path, payload) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text().catch(()=>`${r.status} ${r.statusText}`));
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

export default async function handler(req, res) {
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
