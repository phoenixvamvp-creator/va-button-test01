export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

function error(res, code, msg) { res.status(code).json({ error: msg }); }
function notAllowed(res) { error(res, 405, 'Method not allowed'); }

async function openaiJSON(path, payload) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text().catch(()=>`${r.status} ${r.statusText}`));
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  const { message } = req.body || {};
  if (!message || !String(message).trim()) return error(res, 400, 'Missing message');

  try {
    const data = await openaiJSON('chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: String(message) }],
      temperature: 0.7,
    });
    res.status(200).json({ reply: data?.choices?.[0]?.message?.content || '(no reply)' });
  } catch (e) {
    error(res, 500, String(e));
  }
}
