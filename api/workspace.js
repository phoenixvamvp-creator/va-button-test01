@ -1,312 +1,234 @@
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
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
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
// ---- Calendar helpers (read)
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
  lavender: '1',
  sage: '2',
  grape: '3',
  flamingo: '4',
  banana: '5',
  tangerine: '6', // Tangerine colorId is "6"
  peacock: '7',
  graphite: '8',
  blueberry: '9',
  basil: '10',
  tomato: '11',
  // Allow plain words
  'orange': '6',
  'yellow': '5',
  'red': '11',
  'green': '10',
  'blue': '9',
  'gray': '8',
  'grey': '8',
  orange: '6',
  yellow: '5',
  red: '11',
  green: '10',
  blue: '9',
  gray: '8',
  grey: '8',
};

function toIsoOrNull(s) {
@ -320,7 +242,6 @@ function normalizeColorId(colorNameOrId) {
  if (colorNameOrId == null) return undefined;
  const v = String(colorNameOrId).trim();
  if (!v) return undefined;
  // If user passes an id "1".."11"
  if (/^(1|2|3|4|5|6|7|8|9|10|11)$/.test(v)) return v;
  const key = v.toLowerCase();
  return CAL_EVENT_COLOR_NAME_TO_ID[key];
@ -328,7 +249,9 @@ function normalizeColorId(colorNameOrId) {

async function calendarCreate(accessToken, { summary, description, location, start, end, durationMinutes, colorId }) {
  const startIso = toIsoOrNull(start);
  if (!startIso) return { ok: false, status: 400, data: { error: 'Invalid or missing start (must be ISO or parseable date string)' } };
  if (!startIso) {
    return { ok: false, status: 400, data: { error: 'Invalid or missing start (must be ISO or parseable date string)' } };
  }

  let endIso = toIsoOrNull(end);
  if (!endIso) {
@ -339,11 +262,12 @@ async function calendarCreate(accessToken, { summary, description, location, sta

  const body = {
    summary: (summary || '').toString(),
    description: (description || '').toString(),
    location: (location || '').toString(),
    description: description != null ? String(description) : '',
    location: location != null ? String(location) : '',
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };

  const cId = normalizeColorId(colorId);
  if (cId) body.colorId = cId;

@ -352,6 +276,7 @@ async function calendarCreate(accessToken, { summary, description, location, sta
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
@ -379,11 +304,15 @@ async function calendarUpdate(accessToken, { eventId, summary, description, loca
  const cId = normalizeColorId(colorId);
  if (cId) patch.colorId = cId;

  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }
  );

  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}
@ -391,27 +320,31 @@ async function calendarUpdate(accessToken, { eventId, summary, description, loca
async function calendarDelete(accessToken, { eventId }) {
  if (!eventId) return { ok: false, status: 400, data: { error: 'eventId is required' } };

  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  // Delete often returns empty body
  const ok = r.ok;
  return { ok, status: r.status, data: ok ? { deleted: true } : { error: 'Delete failed' } };
}


// ---- Sheets helpers
async function sheetsRead(accessToken, spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

async function sheetsAppend(accessToken, spreadsheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
@ -422,7 +355,8 @@ async function sheetsAppend(accessToken, spreadsheetId, range, values) {
}

async function sheetsUpdateCell(accessToken, spreadsheetId, range, value) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
@ -682,6 +616,85 @@ async function actCalendarList(req, res, tokens) {
  return json(res, 200, { ok: true, count: events.length, events });
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

// --- Web Search using SerpAPI ---
async function actWebSearch(req, res /*, tokens */) {
  const b = parseBody(req);
@ -733,9 +746,9 @@ module.exports = async function handler(req, res) {

  const raw = ((req.query.action || req.query.op || '') + '').toLowerCase();
  const alias = {
    'read_by_search': 'sheets.read',
    'append': 'sheets.appendrow',
    'doc_append': 'docs.createappend'
    read_by_search: 'sheets.read',
    append: 'sheets.appendrow',
    doc_append: 'docs.createappend'
  };
  const action = alias[raw] || raw;

@ -754,13 +767,15 @@ module.exports = async function handler(req, res) {
    if (action === 'calendar.delete')   return await actCalendarDelete(req, res, tokens);
    if (action === 'web.search')        return await actWebSearch(req, res, tokens);

    // FIX: include the new calendar actions here so the error message matches reality.
    return fail(res, 400, {
      error: 'Unknown or missing action.',
      allowed: [
        'drive.search','drive.listroot',
        'docs.read','docs.createappend',
        'sheets.read','sheets.appendrow','sheets.updatecell',
        'gmail.list','calendar.list',
        'drive.search', 'drive.listroot',
        'docs.read', 'docs.createappend',
        'sheets.read', 'sheets.appendrow', 'sheets.updatecell',
        'gmail.list',
        'calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete',
        'web.search'
      ]
    });
