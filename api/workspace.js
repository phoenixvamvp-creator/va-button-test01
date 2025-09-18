// Unified Drive + Sheets + Docs behind actions on POST /api/workspace?action=...
function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
function getTokensFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)gTokens=([^;]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}
function setTokensCookie(res, req, tokens) {
  const enc = encodeURIComponent(JSON.stringify(tokens));
  const maxAge = 60 * 60 * 24 * 30;
  const base = `gTokens=${enc}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  const host = (req.headers.host || '').toLowerCase();
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  res.setHeader('Set-Cookie', isLocal ? base : `${base}; Secure`);
}
async function refreshAccessToken(tokens) {
  if (!tokens.refresh_token) throw new Error('No refresh_token available');
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Refresh failed: ${data.error || r.statusText}`);
  return {
    ...tokens,
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
    scope: data.scope ?? tokens.scope,
    expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : tokens.expiry_date,
  };
}
async function withRefresh(tokensIn, res, req, call) {
  let tokens = tokensIn;
  let out = await call(tokens.access_token);
  if (out.ok || out.status !== 401) return { tokens, ...out };
  tokens = await refreshAccessToken(tokens);
  setTokensCookie(res, req, tokens);
  out = await call(tokens.access_token);
  return { tokens, ...out };
}

// ---- Drive helpers
async function driveSearch(accessToken, q, fields, pageSize = 50) {
  const url = 'https://www.googleapis.com/drive/v3/files'
    + `?q=${encodeURIComponent(q)}`
    + `&spaces=drive&fields=${encodeURIComponent(fields)}`
    + `&pageSize=${pageSize}&includeItemsFromAllDrives=false&supportsAllDrives=false`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
async function resolveFolderId(tokens, req, res, folderName) {
  if (!folderName) return undefined;
  const qFolder = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name contains '${folderName.replace(/'/g, "\\'")}'`,
    "trashed = false",
  ].join(' and ');
  const r = await withRefresh(tokens, res, req, t => driveSearch(t, qFolder, "files(id,name,modifiedTime)"));
  if (!r.ok) throw { status: r.status, body: { error: 'Drive folder search failed', details: r.data } };
  const folders = r.data.files || [];
  if (!folders.length) return undefined;
  folders.sort((a,b) =>
    (a.name === folderName ? -1 : b.name === folderName ? 1 : 0) ||
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '')
  );
  return folders[0].id;
}
async function resolveFileByName(tokens, req, res, args) {
  const parent = args.folderId ? `'${args.folderId}' in parents and ` : '';
  const q = [
    parent + `mimeType = '${args.mimeType}'`,
    `name contains '${args.name.replace(/'/g, "\\'")}'`,
    "trashed = false",
  ].join(' and ');
  const r = await withRefresh(tokens, res, req, t => driveSearch(t, q, "files(id,name,modifiedTime,owners/displayName)"));
  if (!r.ok) throw { status: r.status, body: { error: 'Drive file search failed', details: r.data } };
  const files = r.data.files || [];
  if (!files.length) return null;
  files.sort((a,b) =>
    (a.name === args.name ? -1 : b.name === args.name ? 1 : 0) ||
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '')
  );
  return files[0];
}

// ---- Sheets helpers
async function sheetsRead(accessToken, spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
async function sheetsAppend(accessToken, spreadsheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
async function sheetsUpdateCell(accessToken, spreadsheetId, range, value) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values: [[value]] }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// ---- Docs helpers
async function docsBatchUpdate(accessToken, docId, requests) {
  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
async function driveCreateDoc(accessToken, name, parentFolderId) {
  const url = 'https://www.googleapis.com/drive/v3/files';
  const metadata = { name, mimeType: 'application/vnd.google-apps.document' };
  if (parentFolderId) metadata.parents = [parentFolderId];
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// ---- action handlers
async function actDriveSearch(req, res, tokens) {
  const b = parseBody(req);
  const name = (b.name || '').toString();
  const mimeType = (b.mimeType || '').toString();
  const folderName = (b.folderName || '').toString();
  const pageSize = Math.max(1, Math.min(Number(b.pageSize || 50), 200));

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const filters = ["trashed = false"];
  if (mimeType) filters.unshift(`mimeType = '${mimeType.replace(/'/g, "\\'")}'`);
  if (name) filters.push(`name contains '${name.replace(/'/g, "\\'")}'`);
  if (folderId) filters.unshift(`'${folderId}' in parents`);
  const q = filters.join(' and ');

  const out = await withRefresh(tokens, res, req, t =>
    driveSearch(t, q, "files(id,name,mimeType,modifiedTime,owners/displayName)", pageSize)
  );
  if (!out.ok) return json(res, out.status, { error: 'Drive search failed', details: out.data });
  return json(res, 200, { ok: true, query: q, files: out.data.files || [] });
}
async function actDocsCreateAppend(req, res, tokens) {
  const b = parseBody(req);
  const docName = (b.docName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const text = (b.text || '').toString();
  if (!docName) return json(res, 400, { error: 'docName is required' });
  if (!text) return json(res, 400, { error: 'text is required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  let file = await resolveFileByName(tokens, req, res, {
    name: docName, mimeType: 'application/vnd.google-apps.document', folderId
  });

  if (!file) {
    const created = await withRefresh(tokens, res, req, t => driveCreateDoc(t, docName, folderId));
    if (!created.ok) return json(res, created.status, { error: 'Doc create failed', details: created.data });
    file = { id: created.data.id, name: docName };
  }

  const append = await withRefresh(tokens, res, req, t =>
    docsBatchUpdate(t, file.id, [
      { insertText: { endOfSegmentLocation: {}, text: text.endsWith('\n') ? text : text + '\n' } }
    ])
  );
  if (!append.ok) return json(res, append.status, { error: 'Doc append failed', details: append.data });
  return json(res, 200, { ok: true, doc: file });
}
async function actSheetsRead(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || '').toString().trim();
  const rangeIn = (b.range || '').toString().trim();
  if (!fileName) return json(res, 400, { error: 'fileName is required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return json(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = rangeIn || `${tab || 'Sheet1'}!A:Z`;
  const r = await withRefresh(tokens, res, req, t => sheetsRead(t, file.id, range));
  if (!r.ok) return json(res, r.status, { error: 'Sheets read failed', details: r.data });
  return json(res, 200, { ok: true, file, range: r.data.range, values: r.data.values || [] });
}
async function actSheetsAppendRow(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || 'Sheet1').toString().trim();
  const values = Array.isArray(b.values) ? b.values : [];
  if (!fileName) return json(res, 400, { error: 'fileName is required' });
  if (!values.length) return json(res, 400, { error: 'values (array) required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return json(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = `${tab}!A:Z`;
  const r = await withRefresh(tokens, res, req, t => sheetsAppend(t, file.id, range, [values]));
  if (!r.ok) return json(res, r.status, { error: 'Sheets append failed', details: r.data });
  return json(res, 200, { ok: true, file, updatedRange: r.data.updates?.updatedRange });
}
async function actSheetsUpdateCell(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || 'Sheet1').toString().trim();
  const cell = (b.cell || '').toString().trim();
  const value = b.value;
  if (!fileName) return json(res, 400, { error: 'fileName is required' });
  if (!cell) return json(res, 400, { error: 'cell (A1 notation) is required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return json(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = `${tab}!${cell}`;
  const r = await withRefresh(tokens, res, req, t => sheetsUpdateCell(t, file.id, range, value));
  if (!r.ok) return json(res, r.status, { error: 'Sheets update failed', details: r.data });
  return json(res, 200, { ok: true, file, updatedRange: r.data.updatedRange || range });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST with JSON body.' });

  const tokens = getTokensFromCookie(req);
  if (!tokens?.access_token) {
    return json(res, 401, { error: 'Missing Google auth. Visit /api/google?op=start first.' });
  }

  const action = ((req.query.action || '') + '').toLowerCase();

  try {
    if (action === 'drive.search')      return await actDriveSearch(req, res, tokens);
    if (action === 'docs.createappend') return await actDocsCreateAppend(req, res, tokens);
    if (action === 'sheets.read')       return await actSheetsRead(req, res, tokens);
    if (action === 'sheets.appendrow')  return await actSheetsAppendRow(req, res, tokens);
    if (action === 'sheets.updatecell') return await actSheetsUpdateCell(req, res, tokens);

    return json(res, 400, {
      error: 'Unknown or missing action.',
      allowed: ['drive.search','docs.createAppend','sheets.read','sheets.appendRow','sheets.updateCell']
    });
  } catch (e) {
    if (e?.status && e?.body) return json(res, e.status, e.body);
    return json(res, 500, { error: 'Workspace handler error', details: String(e?.message || e) });
  }
}
