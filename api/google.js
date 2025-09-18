// Single endpoint: /api/google?op=start | op=callback
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
  const op = (req.query?.op || '').toString();

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
      include_granted_scopes: 'true',
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

    const cookie = `gTokens=${encodeURIComponent(JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      token_type: tokens.token_type || 'Bearer',
      expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      id_token: tokens.id_token,
    }))}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 30}`;

    res.setHeader('Set-Cookie', cookie);
    const backTo = isLocalHost(host) ? '/' : (process.env.POST_OAUTH_RETURN_PATH || '/index.html');
    return res.status(302).setHeader('Location', backTo).end();
  }

  return res.status(400).send('Unknown op. Use ?op=start or ?op=callback.');
}
