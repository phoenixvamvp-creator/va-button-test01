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
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
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

  folders.sort((a, b) =>
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

  files.sort((a, b) =>
    (a.name === args.name ? -1 : b.name === args.name ? 1 : 0) ||
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '')
  );

  return files[0];
}

// ---- Gmail helpers
async function gmailList(accessToken, { label, maxResults }) {
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const listUrl = new URL(`${base}/messages`);
  if (label) listUrl.searchParams.set('labelIds', label);
  listUrl.searchParams.set('maxResults', String(maxResults || 10));

  const listResp = await fetch(listUrl.href, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData = await listResp.json();

  if (!listResp.ok) return { ok: false, status: listResp.status, data: listData };

  const messages = listData.messages || [];
  const results = [];

  for (const m of messages) {
    const getUrl = new URL(`${base}/messages/${encodeURIComponent(m.id)}`);
    getUrl.searchParams.set('format', 'metadata');
    getUrl.searchParams.set('metadataHeaders', 'From');
    getUrl.searchParams.append('metadataHeaders', 'Subject');
    getUrl.searchParams.append('metadataHeaders', 'Date');

    const msgResp = await fetch(getUrl.href, { headers: { Authorization: `Bearer ${accessToken}` } });
    const msgData = await msgResp.json();
    if (!msgResp.ok) continue;

    const headers = {};
    for (const h of msgData.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;

    results.push({
      id: msgData.id,
      threadId: msgData.threadId,
      from: headers['from'] || '',
      subject: headers['subject'] || '',
      date: headers['date'] || '',
      snippet: msgData.snippet || '',
    });
  }

  return { ok: true, status: 200, data: { messages: results } };
}

// ---- Calendar helpers
async function calendarList(accessToken, { maxResults, timeMin, timeMax }) {
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

async function actCalendarCreate(req, res, tokens) {
  const b = parseBody(req);
  const summary = (b.summary || '').toString().trim();
  const start = (b.start || '').toString().trim();

  if (!summary) return fail(res, 400, { error: 'summary is required' });
  if (!start) return fail(res, 400, { error: 'start is required (ISO or parseable date string)' });

  const out = await withRefresh(tokens, res, req, t =>
    calendarCreate(t, {
      summary,
      description: b.description,
      location: b.location,
      start: b.start,
      end: b.end,
      durationMinutes: b.durationMinutes,
      colorId: b.color || b.colorId, // allow "color":"tangerine"
    })
  );
  if (!out.ok) return fail(res, out.status, { error: 'Calendar create failed', details: out.data });

  return json(res, 200, {
    ok: true,
    event: {
      id: out.data.id,
      summary: out.data.summary || '',
      start: out.data.start?.dateTime || out.data.start?.date || null,
      end: out.data.end?.dateTime || out.data.end?.date || null,
      location: out.data.location || '',
      colorId: out.data.colorId || null,
      htmlLink: out.data.htmlLink || '',
    }
  });
}

async function actCalendarUpdate(req, res, tokens) {
  const b = parseBody(req);
  const eventId = (b.eventId || '').toString().trim();
  if (!eventId) return fail(res, 400, { error: 'eventId is required' });

  const out = await withRefresh(tokens, res, req, t =>
    calendarUpdate(t, {
      eventId,
      summary: b.summary,
      description: b.description,
      location: b.location,
      start: b.start,
      end: b.end,
      durationMinutes: b.durationMinutes,
      colorId: b.color || b.colorId,
    })
  );
  if (!out.ok) return fail(res, out.status, { error: 'Calendar update failed', details: out.data });

  return json(res, 200, {
    ok: true,
    event: {
      id: out.data.id,
      summary: out.data.summary || '',
      start: out.data.start?.dateTime || out.data.start?.date || null,
      end: out.data.end?.dateTime || out.data.end?.date || null,
      location: out.data.location || '',
      colorId: out.data.colorId || null,
      htmlLink: out.data.htmlLink || '',
    }
  });
}

async function actCalendarDelete(req, res, tokens) {
  const b = parseBody(req);
  const eventId = (b.eventId || '').toString().trim();
  if (!eventId) return fail(res, 400, { error: 'eventId is required' });

  const out = await withRefresh(tokens, res, req, t => calendarDelete(t, { eventId }));
  if (!out.ok) return fail(res, out.status, { error: 'Calendar delete failed', details: out.data });

  return json(res, 200, { ok: true, deleted: true, eventId });
}


// ---- Calendar write helpers
const CAL_EVENT_COLOR_NAME_TO_ID = {
  // Google UI names
  'lavender': '1',
  'sage': '2',
  'grape': '3',
  'flamingo': '4',
  'banana': '5',
  'tangerine': '6', // Tangerine is colorId "6" :contentReference[oaicite:2]{index=2}
  'peacock': '7',
  'graphite': '8',
  'blueberry': '9',
  'basil': '10',
  'tomato': '11',
  // Allow plain words
  'orange': '6',
  'yellow': '5',
  'red': '11',
  'green': '10',
  'blue': '9',
  'gray': '8',
  'grey': '8',
};

function toIsoOrNull(s) {
  const t = (s || '').toString().trim();
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeColorId(colorNameOrId) {
  if (colorNameOrId == null) return undefined;
  const v = String(colorNameOrId).trim();
  if (!v) return undefined;
  // If user passes an id "1".."11"
  if (/^(1|2|3|4|5|6|7|8|9|10|11)$/.test(v)) return v;
  const key = v.toLowerCase();
  return CAL_EVENT_COLOR_NAME_TO_ID[key];
}

async function calendarCreate(accessToken, { summary, description, location, start, end, durationMinutes, colorId }) {
  const startIso = toIsoOrNull(start);
  if (!startIso) return { ok: false, status: 400, data: { error: 'Invalid or missing start (must be ISO or parseable date string)' } };

  let endIso = toIsoOrNull(end);
  if (!endIso) {
    const mins = Number(durationMinutes || 60);
    const dur = (!isFinite(mins) || mins <= 0) ? 60 : mins;
    endIso = new Date(new Date(startIso).getTime() + dur * 60000).toISOString();
  }

  const body = {
    summary: (summary || '').toString(),
    description: (description || '').toString(),
    location: (location || '').toString(),
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
  const cId = normalizeColorId(colorId);
  if (cId) body.colorId = cId;

  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function calendarUpdate(accessToken, { eventId, summary, description, location, start, end, durationMinutes, colorId }) {
  if (!eventId) return { ok: false, status: 400, data: { error: 'eventId is required' } };

  const patch = {};
  if (summary != null) patch.summary = String(summary);
  if (description != null) patch.description = String(description);
  if (location != null) patch.location = String(location);

  const startIso = toIsoOrNull(start);
  let endIso = toIsoOrNull(end);

  if (startIso) patch.start = { dateTime: startIso };
  if (!endIso && startIso && durationMinutes != null) {
    const mins = Number(durationMinutes);
    if (isFinite(mins) && mins > 0) {
      endIso = new Date(new Date(startIso).getTime() + mins * 60000).toISOString();
    }
  }
  if (endIso) patch.end = { dateTime: endIso };

  const cId = normalizeColorId(colorId);
  if (cId) patch.colorId = cId;

  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function calendarDelete(accessToken, { eventId }) {
  if (!eventId) return { ok: false, status: 400, data: { error: 'eventId is required' } };

  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Delete often returns empty body
  const ok = r.ok;
  return { ok, status: r.status, data: ok ? { deleted: true } : { error: 'Delete failed' } };
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
async function docsGet(accessToken, docId) {
  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

function extractPlainTextFromDoc(doc) {
  try {
    const body = doc.body?.content || [];
    const parts = [];
    for (const el of body) {
      const p = el.paragraph?.elements || [];
      const text = p.map(e => e.textRun?.content || '').join('');
      if (text) parts.push(text);
    }
    return parts.join('\n');
  } catch {}
  return JSON.stringify(doc);
}

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

// ---- actions
async function actDriveSearch(req, res, tokens) {
  const b = parseBody(req);
  const name = (b.name || '').toString();
  const mimeType = (b.mimeType || '').toString();
  const folderName = (b.folderName || '').toString();
  const pageSize = Math.max(1, Math.min(Number(b.pageSize || 50), 200));

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);

  const filters = ["trashed = false"];
  if (mimeType) filters.unshift(`mimeType = '${mimeType.replace(/'/g, "\\'")}'`);
  else if (!name && !folderName) filters.unshift(`mimeType = 'application/vnd.google-apps.folder'`);

  if (name) filters.push(`name contains '${name.replace(/'/g, "\\'")}'`);
  filters.unshift(folderId ? `'${folderId}' in parents` : `'root' in parents`);

  const q = filters.join(' and ');

  const out = await withRefresh(tokens, res, req, t =>
    driveSearch(t, q, "files(id,name,mimeType,modifiedTime,owners/displayName)", pageSize)
  );
  if (!out.ok) return fail(res, out.status, { error: 'Drive search failed', details: out.data });

  return json(res, 200, { ok: true, query: q, files: out.data.files || [] });
}

async function actDriveListRoot(req, res, tokens) {
  const out = await withRefresh(tokens, res, req, t =>
    driveSearch(t, "'root' in parents and trashed = false", "files(id,name,mimeType,modifiedTime)", 200)
  );
  if (!out.ok) return fail(res, out.status, { error: 'Drive root list failed', details: out.data });
  return json(res, 200, { ok: true, files: out.data.files || [] });
}

async function actDocsRead(req, res, tokens) {
  const b = parseBody(req);
  const docId = (b.docId || '').toString().trim();
  const docName = (b.docName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  if (!docId && !docName) return fail(res, 400, { error: 'docId or docName is required' });

  let file = null;
  let targetId = docId;

  if (!targetId) {
    const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
    const f = await resolveFileByName(tokens, req, res, {
      name: docName, mimeType: 'application/vnd.google-apps.document', folderId
    });
    if (!f) return fail(res, 404, { error: `No document found for '${docName}'.` });
    file = f;
    targetId = f.id;
  } else {
    file = { id: targetId, name: docName || undefined };
  }

  const r = await withRefresh(tokens, res, req, t => docsGet(t, targetId));
  if (!r.ok) return fail(res, r.status, { error: 'Docs read failed', details: r.data });

  const text = extractPlainTextFromDoc(r.data);
  return json(res, 200, { ok: true, file, text, wordCount: text.length });
}

async function actDocsCreateAppend(req, res, tokens) {
  const b = parseBody(req);
  const docId = (b.docId || '').toString().trim();
  const docName = (b.docName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const mode = ((b.mode || 'append') + '').toLowerCase();
  const text = (b.text || '').toString();

  if (!docId && !docName) return fail(res, 400, { error: 'docId or docName is required' });
  if (!text) return fail(res, 400, { error: 'text is required' });
  if (mode !== 'append' && mode !== 'replace') return fail(res, 400, { error: 'invalid mode; use append or replace' });

  let file;

  if (docId) {
    file = { id: docId, name: docName || undefined };
  } else {
    const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
    file = await resolveFileByName(tokens, req, res, {
      name: docName, mimeType: 'application/vnd.google-apps.document', folderId
    });

    if (!file) {
      const created = await withRefresh(tokens, res, req, t => driveCreateDoc(t, docName, folderId));
      if (!created.ok) return fail(res, created.status, { error: 'Doc create failed', details: created.data });
      file = { id: created.data.id, name: docName };
    }
  }

  const requests = (mode === 'replace')
    ? [
        { deleteContentRange: { range: { segmentId: null, startIndex: 1, endIndex: -1 } } },
        { insertText: { location: { index: 1 }, text } }
      ]
    : [
        { insertText: { endOfSegmentLocation: {}, text: text.endsWith('\n') ? text : text + '\n' } }
      ];

  const writeResp = await withRefresh(tokens, res, req, t => docsBatchUpdate(t, file.id, requests));
  if (!writeResp.ok) return fail(res, writeResp.status, { error: 'Doc write failed', details: writeResp.data });

  return json(res, 200, { ok: true, doc: file, mode });
}

async function actSheetsRead(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || '').toString().trim();
  const rangeIn = (b.range || '').toString().trim();
  if (!fileName) return fail(res, 400, { error: 'fileName is required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return fail(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = rangeIn || `${tab || 'Sheet1'}!A:Z`;
  const r = await withRefresh(tokens, res, req, t => sheetsRead(t, file.id, range));
  if (!r.ok) return fail(res, r.status, { error: 'Sheets read failed', details: r.data });

  return json(res, 200, { ok: true, file, range: r.data.range, values: r.data.values || [] });
}

async function actSheetsAppendRow(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || 'Sheet1').toString().trim();
  const values = Array.isArray(b.values) ? b.values : [];
  if (!fileName) return fail(res, 400, { error: 'fileName is required' });
  if (!values.length) return fail(res, 400, { error: 'values (array) required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return fail(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = `${tab}!A:Z`;
  const r = await withRefresh(tokens, res, req, t => sheetsAppend(t, file.id, range, [values]));
  if (!r.ok) return fail(res, r.status, { error: 'Sheets append failed', details: r.data });

  return json(res, 200, { ok: true, file, updatedRange: r.data.updates?.updatedRange });
}

async function actSheetsUpdateCell(req, res, tokens) {
  const b = parseBody(req);
  const fileName = (b.fileName || '').toString().trim();
  const folderName = (b.folderName || '').toString().trim();
  const tab = (b.tab || 'Sheet1').toString().trim();
  const cell = (b.cell || '').toString().trim();
  const value = b.value;
  if (!fileName) return fail(res, 400, { error: 'fileName is required' });
  if (!cell) return fail(res, 400, { error: 'cell (A1 notation) is required' });

  const folderId = await resolveFolderId(tokens, req, res, folderName || undefined);
  const file = await resolveFileByName(tokens, req, res, {
    name: fileName, mimeType: 'application/vnd.google-apps.spreadsheet', folderId
  });
  if (!file) return fail(res, 404, { error: `No spreadsheet found for '${fileName}'.` });

  const range = `${tab}!${cell}`;
  const r = await withRefresh(tokens, res, req, t => sheetsUpdateCell(t, file.id, range, value));
  if (!r.ok) return fail(res, r.status, { error: 'Sheets update failed', details: r.data });

  return json(res, 200, { ok: true, file, updatedRange: r.data.updatedRange || range });
}

async function actGmailList(req, res, tokens) {
  const b = parseBody(req);
  const label = (b.label || '').toString().trim();
  const maxResults = Number(b.maxResults || 5);

  const out = await withRefresh(tokens, res, req, t =>
    gmailList(t, { label: label || undefined, maxResults })
  );
  if (!out.ok) return fail(res, out.status, { error: 'Gmail list failed', details: out.data });

  const messages = out.data.messages || [];
  return json(res, 200, { ok: true, label: label || 'INBOX', count: messages.length, messages });
}

async function actCalendarList(req, res, tokens) {
  const b = parseBody(req);
  const maxResults = Number(b.maxResults || 10);
  const timeMin = (b.timeMin || '').toString().trim();
  const timeMax = (b.timeMax || '').toString().trim();

  const out = await withRefresh(tokens, res, req, t =>
    calendarList(t, { maxResults, timeMin: timeMin || undefined, timeMax: timeMax || undefined })
  );
  if (!out.ok) return fail(res, out.status, { error: 'Calendar list failed', details: out.data });

  const events = out.data.events || [];
  return json(res, 200, { ok: true, count: events.length, events });
}

// --- Web Search using SerpAPI ---
async function actWebSearch(req, res /*, tokens */) {
  const b = parseBody(req);
  const query = (b.query || '').toString().trim();
  const num = Math.max(1, Math.min(Number(b.num || 5), 10));
  const site = (b.site || '').toString().trim();
  const freshnessDays = Math.max(0, Math.min(Number(b.freshnessDays || 0), 365));
  if (!query) return fail(res, 400, { error: 'query is required' });

  if (!process.env.SERPAPI_KEY) return fail(res, 500, { error: 'Missing SERPAPI_KEY in environment' });

  const searchUrl = new URL('https://serpapi.com/search.json');
  searchUrl.searchParams.set('engine', 'google');
  searchUrl.searchParams.set('q', site ? `${query} site:${site}` : query);
  searchUrl.searchParams.set('api_key', process.env.SERPAPI_KEY);
  searchUrl.searchParams.set('num', num.toString());
  if (freshnessDays > 0) {
    const dateRestrict = `d${Math.min(365, freshnessDays)}`;
    searchUrl.searchParams.set('tbs', `qdr:${dateRestrict}`);
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

  const raw = ((req.query.action || req.query.op || '') + '').toLowerCase();
  const alias = {
    'read_by_search': 'sheets.read',
    'append': 'sheets.appendrow',
    'doc_append': 'docs.createappend'
  };
  const action = alias[raw] || raw;

  try {
    if (googleRequired) {
      clients = await getGoogleClients(req);
    }

    return fail(res, 400, {
      error: 'Unknown or missing action.',
      allowed: [
        'drive.search','drive.listroot',
        'docs.read','docs.createappend',
        'sheets.read','sheets.appendrow','sheets.updatecell',
        'gmail.list','calendar.list',
        'web.search'
      ]
    });
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
