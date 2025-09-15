// api/google.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Single entrypoint for Google OAuth:
 *  - GET /api/google?op=start      → redirect to Google consent
 *  - GET /api/google?op=callback   → exchange code, set cookie, redirect back
 *
 * Sets HttpOnly cookie "gTokens" containing { access_token, refresh_token, scope, token_type, expiry_date, id_token }
 */

const SCOPES = [
  // Drive/Sheets/Docs POC
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  // Let app fully manage files it creates (optional but recommended)
  'https://www.googleapis.com/auth/drive.file',
  // Gmail send (keep send-only for POC)
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

function json(res: VercelResponse, status: number, body: any) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function isLocalHost(host?: string) {
  const h = (host || '').toLowerCase();
  return h.includes('localhost') || h.includes('127.0.0.1');
}

function redirect(res: VercelResponse, url: string) {
  res.status(302).setHeader('Location', url);
  res.end();
}

function setTokensCookie(res: VercelResponse, req: VercelRequest, tokens: any) {
  const enc = encodeURIComponent(JSON.stringify(tokens));
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  const base = `gTokens=${enc}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  const cookie = isLocalHost(req.headers.host) ? base : `${base}; Secure`;
  res.setHeader('Set-Cookie', cookie);
}

function getRedirectUri(req: VercelRequest) {
  // Prefer env override, else derive from host
  const host = req.headers.host!;
  const base = isLocalHost(host)
    ? (process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:3000/api/google?op=callback`)
    : (process.env.GOOGLE_REDIRECT_URI || `https://${host}/api/google?op=callback`);
  return base;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const op = (req.query.op as string) || (req.method === 'GET' ? 'start' : '');
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return json(res, 500, { error: 'Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars' });
    }

    if (op === 'start') {
      // Build consent URL
      const client_id = process.env.GOOGLE_CLIENT_ID!;
      const redirect_uri = getRedirectUri(req);
      const params = new URLSearchParams({
        client_id,
        redirect_uri,
        response_type: 'code',
        access_type: 'offline',           // get refresh_token
        include_granted_scopes: 'true',
        scope: SCOPES,
        prompt: 'consent',                // always show consent to guarantee refresh_token
      });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      return redirect(res, authUrl);
    }

    if (op === 'callback') {
      const code = (req.query.code as string) || '';
      if (!code) return json(res, 400, { error: 'Missing code' });

      const client_id = process.env.GOOGLE_CLIENT_ID!;
      const client_secret = process.env.GOOGLE_CLIENT_SECRET!;
      const redirect_uri = getRedirectUri(req);

      // Exchange code for tokens
      const form = new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri,
        grant_type: 'authorization_code',
      });

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const tokenData = await tokenResp.json();

      if (!tokenResp.ok || !tokenData.access_token) {
        return json(res, 400, { error: 'Token exchange failed', details: tokenData });
      }

      // Normalize token payload
      const expiresIn = tokenData.expires_in ? Number(tokenData.expires_in) : 0;
      const expiry_date = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

      const tokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token, // might be undefined if Google didn’t return it (prompt=consent helps)
        scope: tokenData.scope,
        token_type: tokenData.token_type || 'Bearer',
        expiry_date,
        id_token: tokenData.id_token,          // optional, not used here
      };

      // Store in HttpOnly cookie
      setTokensCookie(res, req, tokens);

      // Send user back to your app UI (index or webrtc—your choice)
      const ui = isLocalHost(req.headers.host) ? '/' : '/index.html';
      return redirect(res, ui);
    }

    return json(res, 400, { error: 'Unknown op. Use ?op=start or ?op=callback' });
  } catch (err: any) {
    return json(res, 500, { error: 'OAuth handler error', details: String(err?.message || err) });
  }
}
