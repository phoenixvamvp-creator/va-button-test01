// api/transcribe.js
// Forwards multipart/form-data (audio blob + model) directly to OpenAI Whisper.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        // Pass through the original multipart boundary/content-type
        'Content-Type': contentType
      },
      body: req // stream pass-through
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error || 'Whisper error' });
    }

    // OpenAI returns { text: "..." }
    return res.status(200).json({ text: data.text || '' });
  } catch (e) {
    return res.status(500).json({ error: 'Transcription failed', detail: String(e) });
  }
}
