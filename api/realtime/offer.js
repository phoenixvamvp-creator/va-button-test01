const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const MAIN_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function isAllowedOrigin(origin) {
  if (!MAIN_ORIGIN) return true;
  if (!origin) return true;
  if (origin === MAIN_ORIGIN) return true;
  if (/^https:\/\/va-button-test01-.*\.vercel\.app$/.test(origin)) return true; // previews
  return false;
}

async function readRawText(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return await new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) return res.status(403).send('Forbidden (origin)');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/sdp')) return res.status(400).send('Expected application/sdp');

  try {
    let sdpOffer = await readRawText(req);
    sdpOffer = sdpOffer.replace(/\r?\n/g, '\r\n');

    const oaRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
        Accept: 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: sdpOffer,
    });

    const text = await oaRes.text();
    if (!oaRes.ok) return res.status(oaRes.status).send(`OpenAI Realtime error: ${text}`);

    res.setHeader('Content-Type', 'application/sdp');
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).send(`Proxy error: ${e?.message || 'unknown error'}`);
  }
}
