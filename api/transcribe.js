// api/transcribe.js
// Accepts EITHER raw audio (audio/webm, audio/mpeg, etc.) OR multipart/form-data.
// Builds a proper FormData for Whisper when needed, proxies errors back for easy debugging.

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();

    let whisperBody;
    let whisperHeaders = { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` };

    if (ct.includes('multipart/form-data')) {
      // Case A: Browser sent FormData (file + model) — pass through unchanged
      whisperHeaders['Content-Type'] = ct; // keep the boundary GitHub/Vercel set
      whisperBody = req; // stream through
    } else {
      // Case B: Browser sent RAW audio (Blob)
      const buffer = await readRawBody(req);
      if (!buffer?.length) {
        return res.status(400).json({ error: 'Empty audio body', detail: 'buffer length = 0' });
      }
      // Node 18+ has FormData/Blob globally
      const form = new FormData();
      const assumedType =
        ct && ct.startsWith('audio/') ? ct : 'audio/webm;codecs=opus';
      const blob = new Blob([buffer], { type: assumedType });
      form.append('file', blob, assumedType.includes('mpeg') ? 'audio.mp3' : 'audio.webm');
      form.append('model', 'whisper-1');
      whisperBody = form; // DO NOT set Content-Type manually; fetch sets boundary
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

    return res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: 'Transcription failed', detail: String(e) });
  }
}
