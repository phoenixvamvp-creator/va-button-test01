const MODEL = "gemini-2.0-flash";

export const config = {
  api: {
    bodyParser: false, // Essential: prevents Next.js from trying to parse the SDP as JSON
  },
};

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // 1. Read the raw request stream
  let sdpOffer = '';
  try {
    for await (const chunk of req) {
      sdpOffer += chunk;
    }
  } catch (err) {
    console.error('Error reading request stream:', err);
    return res.status(400).send('Error reading SDP offer');
  }

  if (!sdpOffer || sdpOffer.trim() === "") {
    return res.status(400).send('No SDP offer received');
  }

  try {
    // 2. Relay the SDP to the Gemini Realtime API
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
      return res.status(upstream.status).send(`Google API error: ${errorText}`);
    }

    // 3. Send the Gemini Answer back to the frontend
    const sdpAnswer = await upstream.text();
    
    return res.status(200)
              .setHeader('Content-Type', 'application/sdp')
              .send(sdpAnswer);

  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).send('Internal Server Error: ' + e.message);
  }
}
