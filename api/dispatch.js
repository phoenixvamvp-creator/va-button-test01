// /api/dispatch.js
const PROVIDERS_ENABLED = process.env.PROVIDERS_ENABLED === 'true'; // flip later

async function postJSON(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { intent, params = {}, context = {} } = req.body || {};

  try {
    let data = { mock: true, intent, params };
    // Map intents → local provider routes (which are also stubs for now)
    if (intent === 'searchWeb') {
      data = PROVIDERS_ENABLED ? await postJSON('/api/provider/searchWeb', { params, context }) : { mock: true, results: [] };
    } else if (intent === 'searchDrive') {
      data = PROVIDERS_ENABLED ? await postJSON('/api/provider/searchDrive', { params, context }) : { mock: true, files: [] };
    } else if (intent === 'searchSheets') {
      data = PROVIDERS_ENABLED ? await postJSON('/api/provider/searchSheets', { params, context }) : { mock: true, rows: [] };
    } else if (intent === 'adjustSheets') {
      data = PROVIDERS_ENABLED ? await postJSON('/api/provider/adjustSheets', { params, context }) : { mock: true, updated: 0 };
    } else if (intent === 'adjustCalendar') {
      data = PROVIDERS_ENABLED ? await postJSON('/api/provider/adjustCalendar', { params, context }) : { mock: true, status: 'queued' };
    }

    // Compose a short spoken summary (placeholder)
    const summary = summarize(intent, params, data);
    return res.status(200).json({ status: 'ok', data, summary });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

function summarize(intent, p, data) {
  switch (intent) {
    case 'searchDrive':
      return `I would search Drive in the ${p.folder} folder for "${p.query}".`;
    case 'searchSheets':
      return `I would read range ${p.range} from sheet ${p.sheetName} in ${p.fileName}${p.query ? ` where ${p.query}` : ''}.`;
    case 'adjustSheets':
      return p.op === 'append'
        ? `I would append rows to ${p.sheetName} in ${p.fileName}.`
        : `I would set ${p.range} in ${p.sheetName} of ${p.fileName}.`;
    case 'adjustCalendar':
      return p.action === 'create'
        ? `I would create a calendar event "${p.title}" ${p.when}.`
        : `I would move "${p.title}" to ${p.when}.`;
    case 'searchWeb':
      return `I would search the web for "${p.query}".`;
    default:
      return `I didn’t classify that request yet.`;
  }
}
