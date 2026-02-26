// api/realtime/offer.js
const MODEL = "gemini-1.5-flash"; 

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY; 
  
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  try {
    // Collect the stream chunks
    let sdpOffer = '';
    for await (const chunk of req) {
      sdpOffer += chunk;
    }

    // Use the BUILT-IN fetch (no import needed)
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/realtime?model=${MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: sdpOffer
    });

    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/sdp');
    res.status(upstream.status).send(text);

  } catch (e) {
    console.error(e);
    res.status(500).send(`Internal Error: ${e.message}`);
  }
}
