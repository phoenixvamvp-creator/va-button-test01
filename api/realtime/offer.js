const MODEL = "gemini-1.5-flash";

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    // 1. Properly collect the SDP offer from the frontend
    let sdpOffer = '';
    for await (const chunk of req) {
      sdpOffer += chunk;
    }

    // 2. One single call to Google
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/realtime?model=${MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: sdpOffer
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      console.error('Google API Error:', errorText);
      res.status(upstream.status).send(errorText);
      return;
    }

    const answerSdp = await upstream.text();
    
    // 3. Return the Answer SDP as plain text
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(answerSdp);

  } catch (e) {
    console.error('Backend Crash:', e);
    res.status(500).send(`Internal Error: ${e.message}`);
  }
}
