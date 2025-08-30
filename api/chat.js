export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    const { message } = (req.headers['content-type'] || '').includes('application/json')
      ? req.body
      : JSON.parse(req.body || '{}');

    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are PhoenixVA, a concise, hands-busy voice assistant. Keep replies short.' },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content ?? '(no reply)';
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e) });
  }
}
