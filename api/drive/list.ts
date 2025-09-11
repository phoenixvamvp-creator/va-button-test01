import type { VercelRequest, VercelResponse } from '@vercel/node';

function readTokens(req: VercelRequest) {
  const m = (req.headers.cookie || '').match(/gTokens=([^;]+)/);
  if (!m) throw new Error('No tokens cookie');
  return JSON.parse(decodeURIComponent(m[1]));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { access_token } = readTokens(req);
    const q = encodeURIComponent("mimeType!='application/vnd.google-apps.folder'");
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=10&fields=files(id,name,mimeType)`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await r.json();
    res.status(r.ok ? 200 : 400).json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
