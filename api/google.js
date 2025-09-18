// api/google.js
const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
].join(' ');

function isLocalHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.includes('localhost') || h.includes('127.0.0.1');
}

export default async function handler(req, res) {
  const op = (req.query?.op || req.query?.action || '').toString();

  if (op === 'start') {
    const host = req.headers.host || '';
    const redirectUri = isLocalHost(host)
      ? process.env.GOOGLE_REDIRECT_URI_LOCAL
      : process.env.GOOGLE_REDIRECT_URI;

    if (!process.env.GOOGLE_CLIENT_ID || !redirectUri) {
      return res.status(500).send('Missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI(_LOCAL)');
    }

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return res.status(302).setHeader('Location', url).end();
  }

  if (op === 'callback') {
    const code = (req.query?.code || '').toString();
    if (!code) return res.status(400).send('Missing ?code');

    const host = req.headers.host || '';
    const redirectUri = isLocalHost(host)
      ? process.env.GOOGLE_REDIRECT_URI_LOCAL
      : process.env.GOOGLE_REDIRECT_URI;

    const body = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok) return res.status(400).json(tokens);

    const cookie = `gTokens=${encodeURIComponent(JSON.stringify(tokens))}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
    res.setHeader('Set-Cookie', cookie);
    return res.status(302).setHeader('Location', '/connected.html').end();
  }

  return res.status(400).send('Missing or unknown ?op=start|callback');
}
