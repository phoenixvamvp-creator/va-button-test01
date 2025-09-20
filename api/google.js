// api/google.js
// Single endpoint: /api/google.js?op=start | op=callback | op=status | op=me | op=logout

const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
].join(' ');

// ---------- helpers ----------
function isLocalHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.includes('localhost') || h.includes('127.0.0.1');
}

function parseCookie(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(p => p.trim().split('=').map(decodeURIComponent)).filter(kv => kv[0])
  );
}

function readTokens(req) {
  try {
    const cookies = parseCookie(req);
    if (!cookies.gTokens) return null;
    return JSON.parse(cookies.gTokens);
  } catch {
    return null;
  }
}

function writeTokens(res, tokens) {
  const merged = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,        // may be undefined if Google didn’t send it this time
    scope: tokens.scope,
    token_type: tokens.token_type || 'Bearer',
    expiry_date: tokens.expires_in ? (Date.now() + tokens.expires_in * 1000) : tokens.expiry_date,
    id_token: tokens.id_token,
  };
  const cookie = [
    `gTokens=${encodeURIComponent(JSON.stringify(merged))}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${60 * 60 * 24 * 30}`, // 30 days
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  return merged;
}

async function refreshIfNeeded(req, res) {
  const cur = readTokens(req);
  if (!cur) return null;
  // Refresh if no access_token or expiring within 60s
  const needsRefresh = !cur.access_token || (cur.expiry_date && cur.expiry_date - Date.now() < 60_000);

  if (!needsRefresh) return cur;

  if (!cur.refresh_token) return cur; // can't refresh, caller will see 401 later

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    refresh_token: cur.refresh_token,
    grant_type: 'refresh_token',
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await r.json();
  if (!r.ok) {
    // don’t overwrite cookie on refresh failure; surface the error to caller
    return { ...cur, _refresh_error: data };
  }
  // Google typically does NOT return refresh_token on refresh grant — keep the old one
  data.refresh_token = data.refresh_token || cur.refresh_token;
  return writeTokens(res, data);
}

// ---------- handler ----------
export default async function handler(req, res) {
  const op = (req.query?.op || '').toString();

  // --- START: redirect to Google ---
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
      access_type: 'offline',               // get refresh_token on first consent
      include_granted_scopes: 'true',
      prompt: 'consent',                    // ensure refresh_token first time
      scope: SCOPES,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return res.status(302).setHeader('Location', url).end();
  }

  // --- CALLBACK: exchange code -> tokens ---
  if (op === 'callback') {
    const code = (req.query?.code || '').toString();
    if (!code) return res.status(400).send('Missing ?code');

    const host = req.headers.host || '';
    const redirectUri = isLocalHost(host)
      ? process.env.GOOGLE_REDIRECT_URI_LOCAL
      : process.env.GOOGLE_REDIRECT_URI;

    const body = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri || '',
      grant_type: 'authorization_code',
    });

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok) return res.status(400).json(tokens);

    writeTokens(res, tokens);

    const backTo = isLocalHost(host) ? '/' : (process.env.POST_OAUTH_RETURN_PATH || '/index.html');
    return res.status(302).setHeader('Location', backTo).end();
  }

  // --- STATUS: are we connected? (and silently refresh) ---
  if (op === 'status') {
    const t = await refreshIfNeeded(req, res);
    if (!t || !t.access_token) {
      return res.status(200).json({ connected: false });
    }
    return res.status(200).json({
      connected: true,
      scope: t.scope,
      expires_in_ms: t.expiry_date ? Math.max(0, t.expiry_date - Date.now()) : null,
      has_refresh_token: !!t.refresh_token,
      refresh_problem: t._refresh_error || null,
    });
  }

  // --- ME: quick profile probe to verify tokens actually work ---
  if (op === 'me') {
    const t = await refreshIfNeeded(req, res);
    if (!t?.access_token) return res.status(401).json({ error: 'not_connected' });
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : 400).json(data);
  }

  // --- LOGOUT: clear cookie ---
  if (op === 'logout') {
    res.setHeader('Set-Cookie', 'gTokens=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  return res.status(400).send('Unknown op. Use ?op=start | op=callback | op=status | op=me | op=logout');
}
