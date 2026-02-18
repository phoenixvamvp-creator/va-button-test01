// api/realtime/offer.js — The Gemini Brain Swap
import fetch from 'node-fetch';

const MODEL = "gemini-1.5-flash"; 

export default async function handler(req, res) {
  // 1. Get your Google Key from Vercel's secret settings
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY; 
  if (!apiKey) {
    res.statusCode = 500;
    return res.end('Missing GOOGLE_GENERATIVE_AI_API_KEY in Vercel settings');
  }

  // 2. Only allow POST requests (standard for starting a call)
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  try {
    // 3. Read the voice "handshake" (SDP) from your browser
    const sdpOffer = await req.text();

    // 4. Send that handshake to Google's office instead of OpenAI's
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

    const text = await upstream.text();
    
    // 5. Send Google's response back to your app so the talking begins
    res.setHeader('Content-Type', 'application/sdp');
    res.end(text);

  } catch (e) {
    res.statusCode = 500;
    res.end(`Internal Server Error: ${String(e)}`);
  }
}
