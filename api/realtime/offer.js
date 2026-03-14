const MODEL = "gemini-1.5-flash"; 

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY; 
  
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 1. Get the SDP from the frontend. 
    // We use req.body directly because Vercel handles the stream for us.
    const sdpOffer = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (!sdpOffer) {
      return res.status(400).send('No SDP offer received from frontend');
    }

    // 2. Talk to Google
    // Note: We use the x-goog-api-key header which is more reliable for Gemini
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

    const answerSdp = await upstream.text();
    
    // 3. Send the response back to the browser
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(answerSdp);

  } catch (e) {
    console.error('Backend Crash:', e);
    return res.status(500).send(`Server Error: ${e.message}`);
  }
}
