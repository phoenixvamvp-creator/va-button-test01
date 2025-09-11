import type { VercelRequest, VercelResponse } from '@vercel/node';

const scopes = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
].join(' ');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const host = req.headers.host ?? '';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const redirectUri = isLocal
    ? process.env.GOOGLE_REDIRECT_URI_LOCAL!
    : process.env.GOOGLE_REDIRECT_URI!;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  res.status(302).setHeader('Location',
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  ).end();
}
