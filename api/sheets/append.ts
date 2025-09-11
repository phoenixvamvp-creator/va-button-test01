import type { VercelRequest, VercelResponse } from '@vercel/node';

function readTokens(req: VercelRequest) {
  const m = (req.headers.cookie || '').match(/gTokens=([^;]+)/);
  if (!m) throw new Error('No tokens cookie');
  return JSON.parse(decodeURIComponent(m[1]));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { access_token } = readTokens(req);
    const sheetId = process.env.TEST_SHEET_ID!;
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [[new Date().toISOString(), 'Nyx', 'Hello']] }),
      }
    );
    const data = await r.json();
    res.status(r.ok ? 200 : 400).json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
