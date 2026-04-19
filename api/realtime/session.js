// api/realtime/session.js
export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: 'API Key not configured on server' });
  }

  // We are just handing the key to your frontend so it can connect to Google
  return res.status(200).json({ apiKey });
}
