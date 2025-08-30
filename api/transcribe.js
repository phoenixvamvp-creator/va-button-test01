// api/transcribe.js
// Accepts EITHER raw audio (audio/webm, audio/mp4, audio/ogg, audio/mpeg, etc.)
// OR multipart/form-data with fields { file, model }. It then calls OpenAI Whisper
// and returns JSON: { text } on success, or { error, detail } on failure.

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function filenameForMime(ct) {
  const m = (ct || '').toLowerCase();
  if (m.includes('mp4')) return 'audio.mp4';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('mpeg')) return 'audio.mp3';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('x-wav')) return 'audio.wav';
  if (m.includes('x-m4a') || m.includes('m4a')) return 'audio.m4a';
  return 'audio.webm'; // default
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const ct = String(req.headers['content-type'] || '').toLowerCase();

    let whisperBody;
    const whisperHeaders = { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` };

    if (ct.includes('multipart/form-data')) {
      // Case A: Browser sent FormData (file + model). Pass-through, preserving boundary.
      whisperHeaders['Content-Type'] = ct;
      whisperBody = req;
    } else {
      // Case B: Browser sent RAW audio bytes with a Content-Type like audio/webm or audio/mp4.
      const buffer = await readRawBody(req);
      if (!buffer?.length) {
        return res.status(400).json({ error: 'Empty audio body', detail: 'buffer length = 0' });
      }

      // Build a proper multipart body here (Node 18+ on Vercel exposes FormData/Blob).
      const form = new FormData();
      const assumedType = ct.startsWith('audio/') ? ct : 'audio/webm;codecs=opus';
      const blob = new Blob([buffer], { type: assumedType });
      form.append('file', blob, filenameForMime(assumedType));
      form.append('model', 'whisper-1');

      whisperBody = form; // DO NOT set Content-Type manually; fetch will set boundary.
    }

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: whisperHeaders,
      body: whisperBody
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      return res.status(r.status).json({
        error: 'Whisper error',
        detail: data?.error?.message || data?.raw || `HTTP ${r.status}`
      });
    }

    // OpenAI returns { text: "..." }
    return res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: 'Transcription failed', detail: String(e) });
  }
}
