// api/sheets/read_by_search.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type GTokens = { access_token: string };

function getAccessToken(req: VercelRequest): string | null {
  const raw = req.headers?.cookie || '';
  const m = raw.match(/(?:^|;\s*)gTokens=([^;]+)/);
  if (!m) return null;
  try { return (JSON.parse(decodeURIComponent(m[1])) as GTokens).access_token || null; }
  catch { return null; }
}

function send(res: VercelResponse, status: number, body: any) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

async function driveList(accessToken: string, q: string, fields: string) {
  const url =
    'https://www.googleapis.com/drive/v3/files'
    + `?q=${encodeURIComponent(q)}`
    + `&spaces=drive`
    + `&fields=${encodeURIComponent(fields)}`
    + `&pageSize=50&supportsAllDrives=false&includeItemsFromAllDrives=false`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error('Drive list failed'), { data, status: r.status });
  return data;
}

async function sheetsGet(accessToken: string, spreadsheetId: string, range: string) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
    + `?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error('Sheets get failed'), { data, status: r.status });
  return data; // { range, majorDimension, values }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (simple)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST with JSON body.' });

  const accessToken = getAccessToken(req);
  if (!accessToken) return send(res, 401, { error: 'Missing Google auth. Connect Google first.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const fileName = (body.fileName || '').toString().trim();     // e.g., "Master dataset"
  const folderName = (body.folderName || '').toString().trim(); // e.g., "Redbird"
  const tab = (body.tab || '').toString().trim();                // e.g., "Tansy"
  const range = (body.range || '').toString().trim();            // optional exact range like "Tansy!A:Z"

  if (!fileName) return send(res, 400, { error: 'Provide fileName (spreadsheet name to search for).' });

  try {
    // 1) If folderName given, find candidate folders first.
    let parentFilter = '';
    if (folderName) {
      const folderQ = [
        "mimeType = 'application/vnd.google-apps.folder'",
        `name contains '${folderName.replace(/'/g, "\\'")}'`,
        "trashed = false",
      ].join(' and ');
      const fRes = await driveList(accessToken, folderQ, "files(id,name,modifiedTime)");
      const folders: any[] = fRes.files || [];
      if (folders.length) {
        // prefer exact name match, else most recently modified
        folders.sort((a,b) => (a.name === folderName ? -1 : b.name === folderName ? 1 : 0)
          || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
        const folderId = folders[0].id;
        parentFilter = `'${folderId}' in parents and `;
      } else {
        // No folder found; fall back to whole Drive
        parentFilter = '';
      }
    }

    // 2) Find spreadsheet file by name (in folder if provided)
    const fileQ = [
      parentFilter + "mimeType = 'application/vnd.google-apps.spreadsheet'",
      `name contains '${fileName.replace(/'/g, "\\'")}'`,
      "trashed = false",
    ].join(' and ');

    const fRes = await driveList(accessToken, fileQ, "files(id,name,modifiedTime,owners/displayName)");
    let files: any[] = fRes.files || [];
    if (!files.length) return send(res, 404, { error: `No spreadsheet found for '${fileName}'${folderName ? ` in folder '${folderName}'` : ''}.` });

    // Prefer exact match, else most recently modified
    files.sort((a,b) => (a.name === fileName ? -1 : b.name === fileName ? 1 : 0)
      || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));

    const picked = files[0];
    const spreadsheetId = picked.id;

    // 3) Read tab/range
    const finalRange = range || `${tab || 'Sheet1'}!A:Z`;
    const valuesResp = await sheetsGet(accessToken, spreadsheetId, finalRange);

    return send(res, 200, {
      ok: true,
      file: { id: spreadsheetId, name: picked.name },
      range: valuesResp.range,
      values: valuesResp.values || []
    });
  } catch (err: any) {
    const status = err?.status || 500;
    return send(res, status, { error: err?.message || 'Unhandled error', details: err?.data || null });
  }
}
