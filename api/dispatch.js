// /api/dispatch.js
const PROVIDERS_ENABLED = process.env.PROVIDERS_ENABLED === 'true'; // flip later

async function postJSON(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { intent, params = {}, context = {} } = req.body || {};

  try {
    let data = { mock: true, intent, params };

    // Map intents → local provider routes (stubs for now)
    if (intent === 'searchWeb') {
      data = PROVIDERS_ENABLED
        ? await postJSON('/api/provider/searchWeb', { params, context })
        : { mock: true, results: [] };
    } else if (intent === 'searchDrive') {
      data = PROVIDERS_ENABLED
        ? await postJSON('/api/provider/searchDrive', { params, context })
        : { mock: true, files: [] };
    } else if (intent === 'searchSheets') {
      data = PROVIDERS_ENABLED
        ? await postJSON('/api/provider/searchSheets', { params, context })
        : { mock: true, rows: [] };
    } else if (intent === 'adjustSheets') {
      data = PROVIDERS_ENABLED
        ? await postJSON('/api/provider/adjustSheets', { params, context })
        : { mock: true, updated: 0 };
    } else if (intent === 'adjustCalendar') {
      data = PROVIDERS_ENABLED
        ? await postJSON('/api/provider/adjustCalendar', { params, context })
        : { mock: true, status: 'queued' };
    }

    // Short, human acknowledgement instead of repeating the instruction
    const summary = acknowledge(intent);

    return res.status(200).json({ status: 'ok', data, summary });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

/**
 * Returns a brief acknowledgement phrase (spoken via TTS on the client).
 * Different tone for search vs. adjust actions; falls back to a neutral ack.
 */
function acknowledge(intent) {
  const ACK_DEFAULT = [
    "One moment please.",
    "Got it, let me check.",
    "Working on that now.",
    "Hold on, I’ll pull that up.",
    "Okay, give me a second."
  ];

  const ACK_SEARCH = [
    "One moment please.",
    "Searching now.",
    "Let me look that up.",
    "Checking that for you.",
    "On it—just a second."
  ];

  const ACK_ADJUST = [
    "Got it—preparing that.",
    "Okay, setting that up.",
    "One moment while I arrange that.",
    "Understood—working on it.",
    "Sure—let me handle that."
  ];

  if (intent === 'searchWeb' || intent === 'searchDrive' || intent === 'searchSheets') {
    return pick(ACK_SEARCH);
  }
  if (intent === 'adjustSheets' || intent === 'adjustCalendar') {
    return pick(ACK_ADJUST);
  }
  return pick(ACK_DEFAULT);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
