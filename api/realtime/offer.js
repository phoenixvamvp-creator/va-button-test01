import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const MAIN_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function isAllowedOrigin(origin: string) {
  if (!MAIN_ORIGIN) return true;
  if (!origin) return true;
  if (origin === MAIN_ORIGIN) return true;
  if (/^https:\/\/va-button-test01-.*\.vercel\.app$/.test(origin)) return true; // previews
  return false;
}

// Read the raw text body regardless of how Vercel parsed it
async function readRawText(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // Fallback: re-read the stream
  return await new Promise<string>((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const origin = (req.headers.origin as string) || '';
  if (!isAllowedOrigin(origin)) return res.status(403).send('Forbidden (origin)');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).send('Missing OPENAI_API_KEY');

  const ct = (req.headers['content-type'] as string) || '';
  if (!ct.includes('application/sdp')) return res.status(400).send('Expected application/sdp');

  try {
    let sdpOffer = await readRawText(req);

    // Normalize to CRLF line endings (SDP strict parsers expect \r\n)
    sdpOffer = sdpOffer.replace(/\r?\n/g, '\r\n');

    const oaRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
        'Accept': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',     // REQUIRED
      },
      body: sdpOffer,
    });

    const text = await oaRes.text();

    if (!oaRes.ok) {
      // Bubble up the upstream body so we see exactly what OpenAI says
      return res.status(oaRes.status).send(`OpenAI Realtime error: ${text}`);
    }

    res.setHeader('Content-Type', 'application/sdp');
    return res.status(200).send(text);
  } catch (e: any) {
    return res.status(500).send(`Proxy error: ${e?.message || 'unknown error'}`);
  }
}
