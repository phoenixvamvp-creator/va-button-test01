// api/workspace.js — Drive + Sheets + Docs + Gmail + Calendar + Web search
// Fixes included:
// 1) CommonJS export (prevents "Unexpected token 'export'" / ESM load failure)
// 2) Hard "ok" contract: ALL responses include ok:true/false
// 3) Tool-failure guard: if something fails, response is ok:false with details
//    (Your frontend MUST gate on ok===true before letting Nyx summarize.)

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

// Always return ok:false on failure so the client can hard-gate.
function fail(res, status, body) {
  const payload = { ok: false, ...body };
  return json(res, status, payload);
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
  const defaultTimeMin = now.toISOString();
  const defaultTimeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(maxResults || 10));
  url.searchParams.set('timeMin', timeMin || defaultTimeMin);
  url.searchParams.set('timeMax', timeMax || defaultTimeMax);

  const r = await fetch(url.href, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  if (!r.ok) return { ok: false, status: r.status, data };

  const events = (data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    location: ev.location || '',
    status: ev.status || '',
  }));

  return { ok: true, status: 200, data: { events } };
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

  const r = await fetch(searchUrl.href);
  if (!r.ok) return fail(res, r.status, { error: `SerpAPI ${r.status}` });
  const j = await r.json();

  const results = (j.organic_results || []).slice(0, num).map(it => ({
    title: it.title,
    url: it.link,
    snippet: it.snippet || ''
  }));

  return json(res, 200, { ok: true, results });
}

// CommonJS export so Node can load this file without ESM config
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return fail(res, 405, { error: 'Use POST with JSON body.' });

  const tokens = getTokensFromCookie(req);
  if (!tokens?.access_token) {
    return fail(res, 401, { error: 'Missing Google auth. Visit /api/google.js?op=start first.' });
  }

  const raw = ((req.query.action || req.query.op || '') + '').toLowerCase();
  const alias = {
    'read_by_search': 'sheets.read',
    'append': 'sheets.appendrow',
    'doc_append': 'docs.createappend'
  };
  const action = alias[raw] || raw;

  try {
    if (action === 'drive.search')      return await actDriveSearch(req, res, tokens);
    if (action === 'drive.listroot')    return await actDriveListRoot(req, res, tokens);
    if (action === 'docs.read')         return await actDocsRead(req, res, tokens);
    if (action === 'docs.createappend') return await actDocsCreateAppend(req, res, tokens);
    if (action === 'sheets.read')       return await actSheetsRead(req, res, tokens);
    if (action === 'sheets.appendrow')  return await actSheetsAppendRow(req, res, tokens);
    if (action === 'sheets.updatecell') return await actSheetsUpdateCell(req, res, tokens);
    if (action === 'gmail.list')        return await actGmailList(req, res, tokens);
    if (action === 'calendar.list')     return await actCalendarList(req, res, tokens);
    if (action === 'calendar.create')   return await actCalendarCreate(req, res, tokens);
    if (action === 'calendar.update')   return await actCalendarUpdate(req, res, tokens);
    if (action === 'calendar.delete')   return await actCalendarDelete(req, res, tokens);
    if (action === 'web.search')        return await actWebSearch(req, res, tokens);

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
    if (e?.status && e?.body) return fail(res, e.status, e.body);
    return fail(res, 500, { error: 'Workspace handler error', details: String(e?.message || e) });
  }
};
