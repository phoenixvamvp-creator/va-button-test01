// api/sheets/read_by_search.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type GTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;         // ms epoch (optional)
  id_token?: string;
};

// ---------- small utils ----------

function json(res: VercelResponse, status: number, body: any) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function parseBody(req: VercelRequest): any {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function getTokensFromCookie(req: VercelRequest): GTokens | null {
  const raw = req.headers?.cookie || '';
  const m = raw.match(/(?:^|;\s*)gTokens=([^;]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])) as GTokens; }
  catch { return null; }
}

function setTokensCookie(res: VercelResponse, req: VercelRequest, tokens: GTokens) {
  const enc = encodeURIComponent(JSON.stringify(tokens));
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  const base = `gTokens=${enc}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  const host = (req.headers.host || '').toLowerCase();
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const cookie = isLocal ? base : `${base}; Secure`;
  res.setHeader('Set-Cookie', cookie);
}

// ---------- google helpers ----------

async function refreshAccessToken(tokens: GTokens): Promise<GTokens> {
  if (!tokens.refresh_token) throw new Error('No refresh_token available');
  const client_id = process.env.GOOGLE_CLIENT_ID!;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET!;
  const params = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token: tokens.refresh_token!,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(`Refresh failed: ${data.error || r.statusText}`);
  }
  const updated: GTokens = {
    ...tokens,
    access_token: data.access_token,
    scope: data.scope ?? tokens.scope,
    token_type: data.token_type ?? 'Bearer',
    expiry_date: data.expires_in ? Date.now() + (data.expires_in * 1000) : tokens.expiry_date,
  };
  return updated;
}

async function driveList(accessToken: string, q: string, fields: string) {
  const url =
    'https://www.googleapis.com/drive/v3/files'
    + `?q=${encodeURIComponent(q)}`
    + `&spaces=drive&fields=${encodeURIComponent(fields)}&pageSize=50`
    + `&supportsAllDrives=false&includeItemsFromAllDrives=false`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function sheetsGet(accessToken: string, spreadsheetId: string, range: string) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
    + `?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// Try a Google call; if 401, refresh and retry once.
async function withAutoRefresh<T>(
  tokens: GTokens,
  call: (accessToken: string) => Promise<{ ok: boolean; status: number; data: any }>
): Promise<{ tokens: GTokens; ok: boolean; status: number; data: any; refreshed: boolean }> {
  // 1st try
  let res = await call(tokens.access_token);
  if (res.ok || res.status !== 401) {
    return { tokens, ok: res.ok, status: res.status, data: res.data, refreshed: false };
  }
  // Refresh + retry once
  const newTokens = await refreshAccessToken(tokens);
  res = await call(newTokens.access_token);
  return { tokens: newTokens, ok: res.ok, status: res.status, data: res.data, refreshed: true };
}

// ---------- handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (simple)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST with JSON body.' });

  const tokens0 = getTokensFromCookie(req);
  if (!tokens0?.access_token) return json(res, 401, { error: 'Missing Google auth. Connect Google first.' });

  const body = parseBody(req);
  const fileName   = (body.fileName || '').toString().trim();   // e.g., "Master dataset"
  const folderName = (body.folderName || '').toString().trim(); // e.g., "Redbird"
  const tab        = (body.tab || '').toString().trim();        // e.g., "Tansy"
  const rangeIn    = (body.range || '').toString().trim();      // optional e.g., "Tansy!A:Z"

  if (!fileName) return json(res, 400, { error: 'Provide fileName (spreadsheet name to search for).' });

  try {
    let tokens = tokens0;

    // a) If folderName provided, look up folder
    let parentFilter = '';
    if (folderName) {
      const qFolder = [
        "mimeType = 'application/vnd.google-apps.folder'",
        `name contains '${folderName.replace(/'/g, "\\'")}'`,
        "trashed = false"
      ].join(' and ');

      const f1 = await withAutoRefresh(tokens, t => driveList(t, qFolder, "files(id,name,modifiedTime)"));
      if (f1.refreshed) setTokensCookie(res, req, f1.tokens);
      tokens = f1.tokens;

      if (!f1.ok) return json(res, f1.status, { error: 'Drive list (folder) failed', details: f1.data });
      const folders: any[] = f1.data.files || [];
      if (folders.length) {
        folders.sort((a,b) => (a.name === folderName ? -1 : b.name === folderName ? 1 : 0)
          || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
        const folderId = folders[0].id;
        parentFilter = `'${folderId}' in parents and `;
      }
    }

    // b) Find spreadsheet by name
    const qFile = [
      parentFilter + "mimeType = 'application/vnd.google-apps.spreadsheet'",
      `name contains '${fileName.replace(/'/g, "\\'")}'`,
      "trashed = false"
    ].join(' and ');

    const f2 = await withAutoRefresh(tokens, t => driveList(t, qFile, "files(id,name,modifiedTime,owners/displayName)"));
    if (f2.refreshed) setTokensCookie(res, req, f2.tokens);
    tokens = f2.tokens;

    if (!f2.ok) return json(res, f2.status, { error: 'Drive list (files) failed', details: f2.data });
    const files: any[] = f2.data.files || [];
    if (!files.length) {
      return json(res, 404, { error: `No spreadsheet found for '${fileName}'${folderName ? ` in folder '${folderName}'` : ''}.` });
    }
    files.sort((a,b) => (a.name === fileName ? -1 : b.name === fileName ? 1 : 0)
      || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));

    const picked = files[0];
    const spreadsheetId = picked.id;

    // c) Read the tab/range
    const finalRange = rangeIn || `${tab || 'Sheet1'}!A:Z`;
    const f3 = await withAutoRefresh(tokens, t => sheetsGet(t, spreadsheetId, finalRange));
    if (f3.refreshed) setTokensCookie(res, req, f3.tokens);

    if (!f3.ok) return json(res, f3.status, { error: 'Sheets read failed', details: f3.data });

    return json(res, 200, {
      ok: true,
      file: { id: spreadsheetId, name: picked.name },
      range: f3.data.range,
      values: f3.data.values || []
    });

  } catch (err: any) {
    return json(res, 500, { error: 'Unhandled server error', details: String(err?.message || err) });
  }
}
