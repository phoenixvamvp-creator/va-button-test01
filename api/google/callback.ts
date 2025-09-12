// api/google/callback.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing ?code in callback URL");
    return;
  }

  const host = req.headers.host ?? '';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const redirectUri = isLocal
    ? process.env.GOOGLE_REDIRECT_URI_LOCAL
    : process.env.GOOGLE_REDIRECT_URI;

  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri!,
    grant_type: 'authorization_code',
  });

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const tokens = await tokenResp.json();

  if (!tokenResp.ok) {
    res.status(400).json(tokens);
    return;
  }

  // Save tokens in cookie (temporary for MVP — later, store securely in DB)
  const cookie = `gTokens=${encodeURIComponent(JSON.stringify(tokens))}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=${60*60*24*30}`;
  res.setHeader("Set-Cookie", cookie);

  // Redirect back to your front-end (connected.html or webrtc.html)
  res.status(302).setHeader("Location", "/connected.html").end();
}
