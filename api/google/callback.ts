import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = (req.query.code as string) || '';
  if (!code) { res.status(400).send('Missing code'); return; }

  const host = req.headers.host ?? '';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const redirectUri = isLocal
    ? process.env.GOOGLE_REDIRECT_URI_LOCAL!
    : process.env.GOOGLE_REDIRECT_URI!;

  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokens = await r.json();
  if (!r.ok) { res.status(400).json(tokens); return; }

  // For smoke tests only: store in HTTP-only cookie (move to DB later)
  const cookie = `gTokens=${encodeURIComponent(JSON.stringify(tokens))}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=${60*60*24*30}`;
  res.setHeader('Set-Cookie', cookie);

  // Redirect to a static success page
  res.status(302).setHeader('Location', '/connected.html').end();
}
