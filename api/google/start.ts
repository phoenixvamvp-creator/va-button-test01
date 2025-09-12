// api/google/start.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Google OAuth "start" endpoint
 * - Redirects the user to Google's consent screen with the scopes Nyx needs.
 * - Works for both local dev and production (based on host).
 *
 * Required env vars (Vercel Project → Settings → Environment Variables):
 *   GOOGLE_CLIENT_ID=...apps.googleusercontent.com                 (All Environments)
 *   GOOGLE_REDIRECT_URI=https://<your-domain>/api/google/callback  (Production)
 *   GOOGLE_REDIRECT_URI_LOCAL=http://localhost:3000/api/google/callback  (Development)  ← optional but recommended
 *
 * Scopes below cover Drive/Sheets/Docs now; add Calendar/Gmail later when you’re ready.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  // profile basics so you can identify the user later (id/email) if you want
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
].join(' ');

function isLocalHost(host: string | undefined) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.includes('localhost') || h.includes('127.0.0.1');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const host = req.headers.host ?? '';
  const redirectUri = isLocalHost(host)
    ? process.env.GOOGLE_REDIRECT_URI_LOCAL
    : process.env.GOOGLE_REDIRECT_URI;

  if (!process.env.GOOGLE_CLIENT_ID || !redirectUri) {
    res
      .status(500)
      .send('Missing GOOGLE_CLIENT_ID and/or GOOGLE_REDIRECT_URI(_LOCAL) env vars.');
    return;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',   // get refresh_token on first consent
    prompt: 'consent',        // force consent for reliable refresh_token on first run
    scope: SCOPES,
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.status(302).setHeader('Location', url).end();
}
