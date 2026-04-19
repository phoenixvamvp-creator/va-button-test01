// Ensure MODEL is defined
const MODEL = "gemini-2.0-flash"; 

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY; 
  
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const sdpOffer = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (!sdpOffer) {
      return res.status(400).send('No SDP offer received');
    }

    // 1. Call Google's Realtime API
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/realtime?model=${MODEL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        'x-goog-api-key': apiKey,
      },
      body: sdpOffer
    });

    if (!upstream.ok) {
        const errorText = await upstream.text();
        console.error('Google API Error:', errorText);
        return res.status(upstream.status).send(`Google rejected the request: ${errorText}`);
    }

    // 2. THIS WAS MISSING: Get the SDP Answer from Google
    const sdpAnswer = await upstream.text();

    // 3. Return the Answer to your frontend
    // The frontend's 'fetch' in index.html is waiting for this exact string
    return res.status(200)
              .setHeader('Content-Type', 'application/sdp')
              .send(sdpAnswer);

  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).send('Internal Server Error: ' + e.message);
  }
}
