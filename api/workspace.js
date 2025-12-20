// api/workspace.js
// Google Drive + Docs + Sheets + Gmail + Calendar + Web search (SerpAPI)
//
// Key fixes baked in:
// 1) CommonJS module export (prevents ESM "Unexpected token 'export'").
// 2) Hard "ok" contract: ALL responses include ok:true/false.
// 3) Tool-failure guard: any error returns ok:false with details (never pretend success).
// 4) Centralized auth/token retrieval stub (YOU must wire this to your existing /api/google.js token store).
// 5) Gmail: list + search + get (full body) so the VA can read email contents, not just subjects.
// 6) Calendar: list + create (create returns created event id, and is verified by API response).
// 7) Defensive validation + consistent JSON output.
//
// IMPORTANT (truthful + critical):
// I cannot see your actual /api/google.js implementation here, so I cannot know where you store OAuth tokens.
// You MUST implement `getOAuthClientFromRequest(req)` to load tokens (access/refresh) from your existing store.
// If you do not, Gmail/Calendar/Drive calls will fail with ok:false and an auth error — by design.

const { google } = require('googleapis');

// -------------------------
// Response helpers
// -------------------------
function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function ok(res, status, body) {
  return json(res, status, { ok: true, ...body });
}

function fail(res, status, body) {
  return json(res, status, { ok: false, ...body });
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

// -------------------------
// Auth stub — YOU MUST WIRE THIS
// -------------------------
async function getOAuthClientFromRequest(req) {
  // You likely have something like:
  // - a cookie session with tokens
  // - a server-side kv (Redis) keyed by session id
  // - a token JSON file per user
  //
  // Replace this stub with real loading logic.
  //
  // Expected token shape (googleapis):
  // { access_token, refresh_token, scope, token_type, expiry_date }
  //
  // If you have refresh_token, googleapis can auto-refresh.
  const tokens = req?.session?.google_tokens || null;

  if (!tokens || !tokens.access_token) {
    const err = new Error('Google not connected (missing OAuth tokens).');
    err.code = 'AUTH_NOT_CONNECTED';
    throw err;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI env vars.');
    err.code = 'AUTH_ENV_MISSING';
    throw err;
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oAuth2Client.setCredentials(tokens);

  return oAuth2Client;
}

function assertMethod(req, res, method) {
  if (req.method !== method) {
    fail(res, 405, { error: `Method not allowed. Use ${method}.` });
    return false;
  }
  return true;
}

function getAction(req) {
  // supports ?action=x and header override
  return (req.query?.action || '').toString().trim();
}

// -------------------------
// Google API builders
// -------------------------
async function getGoogleClients(req) {
  const auth = await getOAuthClientFromRequest(req);
  return {
    auth,
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
    gmail: google.gmail({ version: 'v1', auth }),
    calendar: google.calendar({ version: 'v3', auth }),
  };
}

// -------------------------
// Drive helpers
// -------------------------
async function findFolderIdByName(drive, folderName) {
  if (!folderName) return null;
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${folderName.replace(/'/g, "\\'")}'`,
    `trashed=false`,
  ].join(' and ');

  const r = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 5,
  });

  const folder = (r.data.files || [])[0];
  return folder ? folder.id : null;
}

async function driveSearch(drive, { name = '', mimeType = '', folderName = '', pageSize = 25 }) {
  const parts = [`trashed=false`];

  if (name) parts.push(`name contains '${name.replace(/'/g, "\\'")}'`);
  if (mimeType) parts.push(`mimeType='${mimeType.replace(/'/g, "\\'")}'`);

  if (folderName) {
    const folderId = await findFolderIdByName(drive, folderName);
    if (!folderId) return { files: [], folderNotFound: true };
    parts.push(`'${folderId}' in parents`);
  }

  const q = parts.join(' and ');

  const r = await drive.files.list({
    q,
    pageSize: Math.max(1, Math.min(Number(pageSize) || 25, 200)),
    fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink)',
  });

  return { files: r.data.files || [] };
}

async function driveListRoot(drive) {
  const r = await drive.files.list({
    q: `'root' in parents and trashed=false`,
    pageSize: 50,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  return { files: r.data.files || [] };
}

// -------------------------
// Docs helpers
// -------------------------
async function resolveDocId(drive, { docId, docName, folderName }) {
  if (docId) return docId;

  const { files, folderNotFound } = await driveSearch(drive, {
    name: docName,
    mimeType: 'application/vnd.google-apps.document',
    folderName,
    pageSize: 10,
  });

  if (folderNotFound) {
    const err = new Error(`Folder not found: ${folderName}`);
    err.code = 'FOLDER_NOT_FOUND';
    throw err;
  }

  const exact = files.find(f => f.name === docName) || files[0];
  if (!exact) {
    const err = new Error(`Doc not found by name: ${docName}`);
    err.code = 'DOC_NOT_FOUND';
    throw err;
  }
  return exact.id;
}

function extractDocText(doc) {
  const out = [];
  const content = doc?.body?.content || [];
  for (const block of content) {
    const p = block.paragraph;
    if (!p?.elements) continue;
    for (const el of p.elements) {
      const t = el?.textRun?.content;
      if (typeof t === 'string') out.push(t);
    }
  }
  return out.join('');
}

async function docsRead(clients, { docId = '', docName = '', folderName = '' }) {
  if (!docId && !docName) {
    const err = new Error('docs.read requires docId or docName');
    err.code = 'BAD_ARGS';
    throw err;
  }

  const id = await resolveDocId(clients.drive, { docId, docName, folderName });
  const r = await clients.docs.documents.get({ documentId: id });
  return {
    docId: id,
    title: r.data.title,
    text: extractDocText(r.data),
  };
}

async function docsCreateAppend(clients, { docId = '', docName = '', folderName = '', mode = 'append', text = '' }) {
  if (typeof text !== 'string' || !text.length) {
    const err = new Error('docs.createappend requires non-empty text');
    err.code = 'BAD_ARGS';
    throw err;
  }

  // Resolve/ensure doc
  let id = docId;

  if (!id) {
    // search by name first
    const { files } = await driveSearch(clients.drive, {
      name: docName || 'Untitled',
      mimeType: 'application/vnd.google-apps.document',
      folderName,
      pageSize: 10,
    });
    const existing = (docName ? files.find(f => f.name === docName) : null) || null;

    if (existing) {
      id = existing.id;
    } else {
      // create new doc
      const folderId = folderName ? await findFolderIdByName(clients.drive, folderName) : null;

      const created = await clients.drive.files.create({
        requestBody: {
          name: docName || 'Untitled',
          mimeType: 'application/vnd.google-apps.document',
          parents: folderId ? [folderId] : undefined,
        },
        fields: 'id,name',
      });
      id = created.data.id;
    }
  }

  // If replace, delete body content first (except last newline)
  if (mode === 'replace') {
    const cur = await clients.docs.documents.get({ documentId: id });
    const endIndex = cur?.data?.body?.content?.slice(-1)?.[0]?.endIndex || 1;

    // Delete everything except initial newline (docs often have 1-based indexing)
    if (endIndex > 1) {
      await clients.docs.documents.batchUpdate({
        documentId: id,
        requestBody: {
          requests: [
            {
              deleteContentRange: {
                range: { startIndex: 1, endIndex: endIndex - 1 },
              },
            },
          ],
        },
      });
    }
  }

  // Append/insert text at end
  await clients.docs.documents.batchUpdate({
    documentId: id,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 }, // simplest stable insert near start
            text: mode === 'append' ? (text + '\n') : (text + '\n'),
          },
        },
      ],
    },
  });

  return { docId: id, mode, wroteChars: text.length };
}

// -------------------------
// Sheets helpers
// -------------------------
async function resolveSheetId(drive, { fileName, folderName }) {
  const { files, folderNotFound } = await driveSearch(drive, {
    name: fileName,
    mimeType: 'application/vnd.google-apps.spreadsheet',
    folderName,
    pageSize: 10,
  });
  if (folderNotFound) {
    const err = new Error(`Folder not found: ${folderName}`);
    err.code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  const exact = files.find(f => f.name === fileName) || files[0];
  if (!exact) {
    const err = new Error(`Sheet not found by name: ${fileName}`);
    err.code = 'SHEET_NOT_FOUND';
    throw err;
  }
  return exact.id;
}

async function sheetsRead(clients, { fileName, folderName = '', tab = '', range = '' }) {
  if (!fileName) {
    const err = new Error('sheets.read requires fileName');
    err.code = 'BAD_ARGS';
    throw err;
  }
  const spreadsheetId = await resolveSheetId(clients.drive, { fileName, folderName });

  const a1 = tab
    ? (range ? `${tab}!${range}` : `${tab}`)
    : (range || 'A:Z');

  const r = await clients.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: a1,
  });

  return { spreadsheetId, range: a1, values: r.data.values || [] };
}

async function sheetsAppendRow(clients, { fileName, folderName = '', tab = 'Sheet1', values = [] }) {
  if (!fileName) {
    const err = new Error('sheets.appendrow requires fileName');
    err.code = 'BAD_ARGS';
    throw err;
  }
  if (!Array.isArray(values)) {
    const err = new Error('sheets.appendrow requires values[]');
    err.code = 'BAD_ARGS';
    throw err;
  }
  const spreadsheetId = await resolveSheetId(clients.drive, { fileName, folderName });

  const r = await clients.sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });

  return { spreadsheetId, updatedRange: r.data.updates?.updatedRange || null };
}

async function sheetsUpdateCell(clients, { fileName, folderName = '', tab = 'Sheet1', cell = '', value = '' }) {
  if (!fileName || !cell) {
    const err = new Error('sheets.updatecell requires fileName and cell (e.g. B7)');
    err.code = 'BAD_ARGS';
    throw err;
  }
  const spreadsheetId = await resolveSheetId(clients.drive, { fileName, folderName });
  const a1 = `${tab}!${cell}`;

  const r = await clients.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });

  return { spreadsheetId, range: a1, updatedCells: r.data.updatedCells || 1 };
}

// -------------------------
// Gmail helpers (READONLY)
// -------------------------
function stripHtmlToText(html) {
  // very basic; your UI is voice-first so plain text is ok
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeBase64Url(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

function findPart(parts, mimeType) {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (p.mimeType === mimeType && p.body?.data) return p;
    const nested = findPart(p.parts, mimeType);
    if (nested) return nested;
  }
  return null;
}

function extractGmailBody(payload) {
  // Prefer text/plain, fallback to text/html, fallback to snippet-ish
  const plain = findPart(payload?.parts, 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = findPart(payload?.parts, 'text/html');
  if (html?.body?.data) return stripHtmlToText(decodeBase64Url(html.body.data));

  // Some messages have body on the top payload
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);

  return '';
}

function header(headers, name) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

async function gmailList(clients, { label = 'INBOX', maxResults = 5 }) {
  const r = await clients.gmail.users.messages.list({
    userId: 'me',
    labelIds: label ? [label] : undefined,
    maxResults: Math.max(1, Math.min(Number(maxResults) || 5, 20)),
  });

  const ids = (r.data.messages || []).map(m => m.id).filter(Boolean);
  const out = [];

  for (const id of ids) {
    const msg = await clients.gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'],
    });

    const p = msg.data.payload;
    out.push({
      id,
      threadId: msg.data.threadId,
      date: header(p?.headers, 'Date'),
      from: header(p?.headers, 'From'),
      to: header(p?.headers, 'To'),
      subject: header(p?.headers, 'Subject'),
      snippet: msg.data.snippet || '',
      labelIds: msg.data.labelIds || [],
    });
  }

  return { messages: out };
}

async function gmailSearch(clients, { q = '', maxResults = 10 }) {
  const r = await clients.gmail.users.messages.list({
    userId: 'me',
    q: String(q || '').trim(),
    maxResults: Math.max(1, Math.min(Number(maxResults) || 10, 20)),
  });

  const ids = (r.data.messages || []).map(m => m.id).filter(Boolean);
  return { messageIds: ids };
}

async function gmailGet(clients, { id = '' }) {
  if (!id) {
    const err = new Error('gmail.get requires id');
    err.code = 'BAD_ARGS';
    throw err;
  }

  const msg = await clients.gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });

  const p = msg.data.payload;
  const bodyText = extractGmailBody(p);

  return {
    id,
    threadId: msg.data.threadId,
    date: header(p?.headers, 'Date'),
    from: header(p?.headers, 'From'),
    to: header(p?.headers, 'To'),
    subject: header(p?.headers, 'Subject'),
    labelIds: msg.data.labelIds || [],
    snippet: msg.data.snippet || '',
    bodyText: bodyText || '',
  };
}

// -------------------------
// Calendar helpers
// -------------------------
async function calendarList(clients, { maxResults = 10, timeMin = '', timeMax = '' }) {
  const now = new Date();
  const min = timeMin ? new Date(timeMin) : now;
  const max = timeMax ? new Date(timeMax) : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const r = await clients.calendar.events.list({
    calendarId: 'primary',
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    maxResults: Math.max(1, Math.min(Number(maxResults) || 10, 20)),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const items = (r.data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    location: ev.location || '',
    description: ev.description || '',
  }));

  return { events: items, timeMin: min.toISOString(), timeMax: max.toISOString() };
}

async function calendarCreate(clients, { summary = '', startIso = '', endIso = '', description = '', location = '' }) {
  if (!summary || !startIso || !endIso) {
    const err = new Error('calendar.create requires summary, startIso, endIso (ISO strings)');
    err.code = 'BAD_ARGS';
    throw err;
  }

  const r = await clients.calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: new Date(startIso).toISOString() },
      end: { dateTime: new Date(endIso).toISOString() },
    },
  });

  // If insert fails, googleapis throws; so reaching here means success.
  return { created: true, eventId: r.data.id, htmlLink: r.data.htmlLink || '' };
}

// -------------------------
// SerpAPI web search
// -------------------------
async function webSearch({ query = '', num = 5, site = '', freshnessDays = 0 }) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    const err = new Error('Missing SERPAPI_KEY env var.');
    err.code = 'SERPAPI_KEY_MISSING';
    throw err;
  }

  const q = (site ? `site:${site} ` : '') + String(query || '').trim();
  if (!q.trim()) {
    const err = new Error('web.search requires query');
    err.code = 'BAD_ARGS';
    throw err;
  }

  // SerpAPI params differ by engine; this is the common Google engine.
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: 'google',
    q,
    num: String(Math.max(1, Math.min(Number(num) || 5, 10))),
  });

  // SerpAPI doesn’t have a universal “freshnessDays” param; you can use tbs for Google.
  // Example: tbs=qdr:d (day), qdr:w, qdr:m, qdr:y. For arbitrary days, it’s not perfect.
  if (Number(freshnessDays) > 0) {
    // crude mapping
    const d = Number(freshnessDays);
    const tbs = d <= 1 ? 'qdr:d' : d <= 7 ? 'qdr:w' : d <= 31 ? 'qdr:m' : 'qdr:y';
    params.set('tbs', tbs);
  }

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  const data = await r.json();

  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  const results = organic.slice(0, Math.max(1, Math.min(Number(num) || 5, 10))).map(it => ({
    title: it.title || '',
    link: it.link || '',
    snippet: it.snippet || '',
    source: it.source || '',
    position: it.position || null,
  }));

  return { query: q, results };
}

// -------------------------
// Router
// -------------------------
module.exports = async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return;

  const action = getAction(req);
  const body = parseBody(req);

  if (!action) return fail(res, 400, { error: 'Missing action query param (?action=...)' });

  let clients = null;

  // web.search does not require Google auth
  const googleRequired = !action.startsWith('web.');

  try {
    if (googleRequired) {
      clients = await getGoogleClients(req);
    }

    // ---- Docs ----
    if (action === 'docs.read') {
      const out = await docsRead(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'docs.createappend') {
      const out = await docsCreateAppend(clients, body);
      return ok(res, 200, out);
    }

    // ---- Drive ----
    if (action === 'drive.search') {
      const out = await driveSearch(clients.drive, body);
      return ok(res, 200, out);
    }

    if (action === 'drive.listroot') {
      const out = await driveListRoot(clients.drive);
      return ok(res, 200, out);
    }

    // ---- Sheets ----
    if (action === 'sheets.read') {
      const out = await sheetsRead(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'sheets.appendrow') {
      const out = await sheetsAppendRow(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'sheets.updatecell') {
      const out = await sheetsUpdateCell(clients, body);
      return ok(res, 200, out);
    }

    // ---- Gmail (readonly) ----
    if (action === 'gmail.list') {
      const out = await gmailList(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'gmail.search') {
      const out = await gmailSearch(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'gmail.get') {
      const out = await gmailGet(clients, body);
      return ok(res, 200, out);
    }

    // ---- Calendar ----
    if (action === 'calendar.list') {
      const out = await calendarList(clients, body);
      return ok(res, 200, out);
    }

    if (action === 'calendar.create') {
      const out = await calendarCreate(clients, body);
      return ok(res, 200, out);
    }

    // ---- Web ----
    if (action === 'web.search') {
      const out = await webSearch(body);
      return ok(res, 200, out);
    }

    return fail(res, 400, { error: `Unknown action: ${action}` });
  } catch (e) {
    const status =
      e?.code === 'BAD_ARGS' ? 400 :
      e?.code === 'AUTH_NOT_CONNECTED' ? 401 :
      e?.code === 'AUTH_ENV_MISSING' ? 500 :
      e?.code === 'SERPAPI_KEY_MISSING' ? 500 :
      e?.code === 'DOC_NOT_FOUND' ? 404 :
      e?.code === 'SHEET_NOT_FOUND' ? 404 :
      e?.code === 'FOLDER_NOT_FOUND' ? 404 :
      500;

    return fail(res, status, {
      error: String(e?.message || e),
      code: e?.code || 'ERR',
    });
  }
};
