// api/google_sheets_docs.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Unified Google workspace actions for POC:
 *   POST /api/google_sheets_docs?action=read_by_search
 *     body: { fileName: string, folderName?: string, tab?: string, range?: string }
 *
 *   POST /api/google_sheets_docs?action=append
 *     body: { fileName: string, folderName?: string, tab?: string, row?: any[] }
 *
 *   POST /api/google_sheets_docs?action=doc_append
 *     body: { docName: string, folderName?: string, text: string }
 *
 * Requires OAuth cookie "gTokens" set by /api/google (OAuth flow).
 * Scopes needed (consented by the user):
 *   - drive.metadata.readonly  (search)
 *   - spreadsheets             (read/write)
 *   - documents                (append to Docs)
 *   - drive.file               (optional but recommended for app-created files)
 */

type GTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number; // ms epoch
};

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
  const raw = req.headers.cookie || '';
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

// ---- Google helpers ----

async function refreshAccessToken(tokens: GTokens): Promise<GTokens> {
  if (!tokens.refresh_token) throw new Error('No refresh_token available');
  const client_id = process.env.GOOGLE_CLIENT_ID!;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET!;
  const form = new URLSearchParams({
    client_id, client_secret, refresh_token: tokens.refresh_token!, grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(`Refresh failed: ${data.error || r.statusText}`);
  }
  return {
    ...tokens,
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
    scope: data.scope ?? tokens.scope,
    expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : tokens.expiry_date,
  };
}

async function driveSearch(accessToken: string, q: string, fields: string) {
  const url =
    'https://www.googleapis.com/drive/v3/files'
    + `?q=${encodeURIComponent(q)}`
    + `&spaces=drive&fields=${encodeURIComponent(fields)}`
    + `&pageSize=50&includeItemsFromAllDrives=false&supportsAllDrives=false`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function sheetsRead(accessToken: string, spreadsheetId: string, range: string) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function sheetsAppend(accessToken: string, spreadsheetId: string, range: string, values: any[][]) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function docsBatchUpdate(accessToken: string, docId: string, requests: any[]) {
  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests })
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function driveCreateDoc(accessToken: string, name: string, parentFolderId?: string) {
  // Create a Google Doc file via Drive API (files.create)
  const url = 'https://www.googleapis.com/drive/v3/files';
  const metadata: any = {
    name,
    mimeType: 'application/vnd.google-apps.document'
  };
  if (parentFolderId) metadata.parents = [parentFolderId];

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// Utility: run a Google call; if 401, refresh token and retry once
async function withRefresh<T>(
  tokensIn: GTokens,
  res: VercelResponse,
  req: VercelRequest,
  call: (accessToken: string) => Promise<{ ok: boolean; status: number; data: any }>
) {
  let tokens = tokensIn;
  let out = await call(tokens.access_token);
  if (out.ok || out.status !== 401) return { tokens, ...out };

  // refresh then retry once
  tokens = await refreshAccessToken(tokens);
  setTokensCookie(res, req, tokens);
  out = await call(tokens.access_token);
  return { tokens, ...out };
}

// ----- Handlers -----

async function handleReadBySearch(req: VercelRequest, res: VercelResponse, tokens0: GTokens) {
  const b = parseBody(req);
  const fileName   = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab        = (b.tab || '').toString().trim();
  const rangeIn    = (b.range || '').toString().trim();

  if (!fileName) return json(res, 400, { error: 'fileName is required' });

  // 1) Optional: resolve folder
  let parentFilter = '';
  if (folderName) {
    const qFolder = [
      "mimeType = 'application/vnd.google-apps.folder'",
      `name contains '${folderName.replace(/'/g, "\\'")}'`,
      "trashed = false"
    ].join(' and ');
    const r1 = await withRefresh(tokens0, res, req, t => driveSearch(t, qFolder, "files(id,name,modifiedTime)"));
    if (!r1.ok) return json(res, r1.status, { error: 'Drive folder search failed', details: r1.data });
    const folders: any[] = r1.data.files || [];
    if (folders.length) {
      // prioritize exact name, else latest modified
      folders.sort((a,b) => (a.name === folderName ? -1 : b.name === folderName ? 1 : 0)
        || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      parentFilter = `'${folders[0].id}' in parents and `;
    }
  }

  // 2) Find spreadsheet
  const qFile = [
    parentFilter + "mimeType = 'application/vnd.google-apps.spreadsheet'",
    `name contains '${fileName.replace(/'/g, "\\'")}'`,
    "trashed = false"
  ].join(' and ');

  const r2 = await withRefresh(tokens0, res, req, t => driveSearch(t, qFile, "files(id,name,modifiedTime,owners/displayName)"));
  if (!r2.ok) return json(res, r2.status, { error: 'Drive file search failed', details: r2.data });
  const files: any[] = r2.data.files || [];
  if (!files.length) {
    return json(res, 404, { error: `No spreadsheet found for '${fileName}'${folderName ? ` in folder '${folderName}'` : ''}.` });
  }
  files.sort((a,b) => (a.name === fileName ? -1 : b.name === fileName ? 1 : 0)
    || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));

  const spreadsheetId = files[0].id;
  const finalRange = rangeIn || `${tab || 'Sheet1'}!A:Z`;

  // 3) Read values
  const r3 = await withRefresh(tokens0, res, req, t => sheetsRead(t, spreadsheetId, finalRange));
  if (!r3.ok) return json(res, r3.status, { error: 'Sheets read failed', details: r3.data });

  return json(res, 200, { ok: true, file: { id: spreadsheetId, name: files[0].name }, range: r3.data.range, values: r3.data.values || [] });
}

async function handleAppend(req: VercelRequest, res: VercelResponse, tokens0: GTokens) {
  const b = parseBody(req);
  const fileName   = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab        = (b.tab || 'Sheet1').toString().trim();
  const row        = Array.isArray(b.row) ? b.row : [];

  if (!fileName) return json(res, 400, { error: 'fileName is required' });
  if (!row.length) return json(res, 400, { error: 'row (array) required' });

  // Resolve target spreadsheet (same search as above)
  let parentFilter = '';
  if (folderName) {
    const qFolder = [
      "mimeType = 'application/vnd.google-apps.folder'",
      `name contains '${folderName.replace(/'/g, "\\'")}'`,
      "trashed = false"
    ].join(' and ');
    const rf = await withRefresh(tokens0, res, req, t => driveSearch(t, qFolder, "files(id,name,modifiedTime)"));
    if (!rf.ok) return json(res, rf.status, { error: 'Drive folder search failed', details: rf.data });
    const folders: any[] = rf.data.files || [];
    if (folders.length) {
      folders.sort((a,b) => (a.name === folderName ? -1 : b.name === folderName ? 1 : 0)
        || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      parentFilter = `'${folders[0].id}' in parents and `;
    }
  }

  const qFile = [
    parentFilter + "mimeType = 'application/vnd.google-apps.spreadsheet'",
    `name contains '${fileName.replace(/'/g, "\\'")}'`,
    "trashed = false"
  ].join(' and ');
  const rf2 = await withRefresh(tokens0, res, req, t => driveSearch(t, qFile, "files(id,name,modifiedTime)"));
  if (!rf2.ok) return json(res, rf2.status, { error: 'Drive file search failed', details: rf2.data });
  const files: any[] = rf2.data.files || [];
  if (!files.length) return json(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const spreadsheetId = files[0].id;
  const range = `${tab}!A:Z`;
  const ra = await withRefresh(tokens0, res, req, t => sheetsAppend(t, spreadsheetId, range, [row]));
  if (!ra.ok) return json(res, ra.status, { error: 'Sheets append failed', details: ra.data });

  return json(res, 200, { ok: true, file: { id: spreadsheetId, name: files[0].name }, updatedRange: ra.data.updates?.updatedRange });
}

async function handleDocAppend(req: VercelRequest, res: VercelResponse, tokens0: GTokens) {
  const b = parseBody(req);
  const docName    = (b.docName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const text       = (b.text || '').toString();

  if (!docName) return json(res, 400, { error: 'docName is required' });
  if (!text) return json(res, 400, { error: 'text is required' });

  // Resolve parent folder (optional)
  let parentFolderId: string | undefined;
  if (folderName) {
    const qFolder = [
      "mimeType = 'application/vnd.google-apps.folder'",
      `name contains '${folderName.replace(/'/g, "\\'")}'`,
      "trashed = false"
    ].join(' and ');
    const rf = await withRefresh(tokens0, res, req, t => driveSearch(t, qFolder, "files(id,name,modifiedTime)"));
    if (!rf.ok) return json(res, rf.status, { error: 'Drive folder search failed', details: rf.data });
    const folders: any[] = rf.data.files || [];
    if (folders.length) {
      folders.sort((a,b) => (a.name === folderName ? -1 : b.name === folderName ? 1 : 0)
        || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      parentFolderId = folders[0].id;
    }
  }

  // Find existing doc by name, else create one
  const qDoc = [
    (parentFolderId ? `'${parentFolderId}' in parents and ` : '') + "mimeType = 'application/vnd.google-apps.document'",
    `name contains '${docName.replace(/'/g, "\\'")}'`,
    "trashed = false"
  ].join(' and ');
  const r1 = await withRefresh(tokens0, res, req, t => driveSearch(t, qDoc, "files(id,name,modifiedTime)"));
  if (!r1.ok) return json(res, r1.status, { error: 'Drive doc search failed', details: r1.data });
  const found: any[] = r1.data.files || [];

  let docId: string;
  if (found.length) {
    found.sort((a,b) => (a.name === docName ? -1 : b.name === docName ? 1 : 0)
      || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    docId = found[0].id;
  } else {
    const rCreate = await withRefresh(tokens0, res, req, t => driveCreateDoc(t, docName, parentFolderId));
    if (!rCreate.ok) return json(res, rCreate.status, { error: 'Doc create failed', details: rCreate.data });
    docId = rCreate.data.id;
  }

  // Append text at end
  const r2 = await withRefresh(tokens0, res, req, t =>
    docsBatchUpdate(t, docId, [
      { insertText: { endOfSegmentLocation: {}, text: text.endsWith('\n') ? text : text + '\n' } }
    ])
  );
  if (!r2.ok) return json(res, r2.status, { error: 'Doc append failed', details: r2.data });

  return json(res, 200, { ok: true, doc: { id: docId, name: docName } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (simple)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST with JSON body.' });

  const tokens = getTokensFromCookie(req);
  if (!tokens?.access_token) return json(res, 401, { error: 'Missing Google auth. Visit /api/google?op=start first.' });

  const action = ((req.query.action as string) || '').toLowerCase();
  if (action === 'read_by_search') return handleReadBySearch(req, res, tokens);
  if (action === 'append')         return handleAppend(req, res, tokens);
  if (action === 'doc_append')     return handleDocAppend(req, res, tokens);

  return json(res, 400, { error: 'Unknown or missing action. Use action=read_by_search | append | doc_append' });
}
