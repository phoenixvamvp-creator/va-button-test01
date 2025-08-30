// api/transcribe.js
// Receive raw audio (e.g., audio/webm) and build a proper FormData for Whisper.

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('audio/')) {
      return res.status(400).json({ error: 'Expected raw audio in request body' });
    }

    // 1) Read raw audio bytes from the request
    const buffer = await readRawBody(req);

    // 2) Build a FormData payload for OpenAI
    // Node 18+ on Vercel exposes Blob + FormData globally
    const form = new FormData();
    const blob = new Blob([buffer], { type: contentType || 'audio/webm' });
    form.append('file', blob, 'audio.webm'); // give it a filename with extension
    form.append('model', 'whisper-1');

    // 3) Send to OpenAI Whisper
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form, // do NOT set Content-Type manually; fetch sets boundary
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error || 'Whisper error' });
    }

    return res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    return res.status(500).json({ error: 'Transcription failed', detail: String(e) });
  }
}

