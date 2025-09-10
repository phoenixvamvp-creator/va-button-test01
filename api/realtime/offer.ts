import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const MAIN_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function isAllowedOrigin(origin: string) {
  if (!MAIN_ORIGIN) return true;
  if (!origin) return true;
  if (origin === MAIN_ORIGIN) return true;
  if (/^https:\/\/va-button-test01-.*\.vercel\.app$/.test(origin)) return true; // allow previews
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const origin = (req.headers.origin as string) || '';
  if (!isAllowedOrigin(origin)) return res.status(403).send('Forbidden (origin)');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  const ct = (req.headers['content-type'] as string) || '';
  if (!ct.includes('application/sdp')) return res.status(400).send('Expected application/sdp');

  // Read raw SDP offer as text
  let sdpOffer = '';
  if (typeof req.body === 'string') sdpOffer = req.body;
  else if (Buffer.isBuffer(req.body)) sdpOffer = req.body.toString('utf8');

  try {
    const oaRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',          // <- REQUIRED
        'Accept': 'application/sdp',           // nice-to-have
      },
      body: sdpOffer,
    });

    const text = await oaRes.text();
    if (!oaRes.ok) {
      // Surface the upstream error body to help debug
      return res.status(oaRes.status).send(`OpenAI Realtime error: ${text}`);
    }

    res.setHeader('Content-Type', 'application/sdp');
    return res.status(200).send(text);
  } catch (e: any) {
    return res.status(500).send(`Proxy error: ${e?.message || 'unknown error'}`);
  }
}
