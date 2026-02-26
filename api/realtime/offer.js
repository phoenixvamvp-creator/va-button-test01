// api/realtime/offer.js
const MODEL = "gemini-1.5-flash"; 

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY; 
  
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  try {
    // 1. Read the voice "handshake" (SDP) from the browser stream
    let sdpOffer = '';
    for await (const chunk of req) {
      sdpOffer += chunk;
    }

    // 2. Send the handshake to Google's Realtime API
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
        res.statusCode = upstream.status;
        return res.end(`Google API Error: ${errorText}`);
    }

    // 3. Send the response back to your browser
    const answerSdp = await upstream.text();
    res.setHeader('Content-Type', 'application/sdp');
    res.status(200).send(answerSdp);

  } catch (e) {
    console.error('Backend Error:', e);
    res.status(500).send(`Internal Error: ${e.message}`);
  }
}
