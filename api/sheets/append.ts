// api/Sheets/append.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type GTokens = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
};

function getAccessTokenFromCookie(req: VercelRequest): string | null {
  const raw = req.headers?.cookie || '';
  const m = raw.match(/(?:^|;\s*)gTokens=([^;]+)/);
  if (!m) return null;
  try {
    const tokens = JSON.parse(decodeURIComponent(m[1])) as GTokens;
    return tokens.access_token || null;
  } catch {
    return null;
  }
}

function sendJSON(res: VercelResponse, status: number, body: any) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (optional, safe for same-origin use; keep simple)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Use POST with JSON body.' });
  }

  // --- 1) Access token from cookie ---
  const accessToken = getAccessTokenFromCookie(req);
  if (!accessToken) {
    return sendJSON(res, 401, { error: 'Missing Google auth. Please Connect Google first.' });
  }

  // --- 2) Inputs ---
  // Body can be JSON already (Vercel parses) or a string
  const body = typeof req.body === 'string' ? safeJSON(req.body) : (req.body || {});
  const providedSheetId = body.sheetId as string | undefined;     // optional override
  const sheetId = providedSheetId || process.env.TEST_SHEET_ID;   // default from env
  const range = (body.range as string) || 'Sheet1!A1';            // tab and anchor
  let values = body.values as any[][] | undefined;                 // 2D values
  const row = body.row as any[] | undefined;                       // single row helper

  if (!sheetId) {
    return sendJSON(res, 400, { error: 'Missing sheetId (body.sheetId) and TEST_SHEET_ID env var.' });
  }

  // If caller passed a single row, wrap it to 2D. If nothing provided, append a default test row.
  if (!values) {
    if (row) values = [row];
    else values = [[new Date().toISOString(), 'Nyx', 'Hello from VA']];
  }

  // --- 3) Call Google Sheets REST API ---
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    sheetId
  )}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    });

    const data = await r.text();
    if (!r.ok) {
      return sendJSON(res, r.status, {
        error: 'Sheets append failed',
        status: r.status,
        details: safeJSON(data) ?? data,
      });
    }

    // Success
    return sendJSON(res, 200, { ok: true, result: safeJSON(data) ?? data });
  } catch (err: any) {
    return sendJSON(res, 500, { error: 'Network or server error', details: String(err?.message || err) });
  }
}

function safeJSON(s: string | undefined) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
