const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const MAIN_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function isAllowedOrigin(origin) {
  if (!MAIN_ORIGIN) return true;
  if (!origin) return true;
  if (origin === MAIN_ORIGIN) return true;
  if (/^https:\/\/va-button-test01-.*\.vercel\.app$/.test(origin)) return true; // previews
  return false;
}

// Minimal CORS/preflight to avoid odd 404s if you ever test cross-origin
function handleOptions(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.statusCode = 204;
  res.end();
}

async function readRawText(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return await new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) {
    res.statusCode = 403;
    return res.end('Forbidden (origin)');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    return res.end('Missing OPENAI_API_KEY');
  }

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/sdp')) {
    res.statusCode = 400;
    return res.end('Expected application/sdp');
  }

  try {
    let sdpOffer = await readRawText(req);
    sdpOffer = sdpOffer.replace(/\r?\n/g, '\r\n'); // normalize CRLF for SDP

    const upstream = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
        'Accept': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: sdpOffer // <-- typo fixed: was sdpOfferO in broken version
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      res.statusCode = upstream.status;
      return res.end(`OpenAI Realtime error: ${text}`);
    }

    res.setHeader('Content-Type', 'application/sdp');
    res.statusCode = 200;
    return res.end(text);
  } catch (e) {
    res.statusCode = 500;
    return res.end(`Proxy error: ${e?.message || 'unknown error'}`);
  }
}
