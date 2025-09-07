// api/env-check.js
// TEMP: verify the serverless function can see OPENAI_API_KEY in Production.

export default async function handler(req, res) {
  const key = process.env.OPENAI_API_KEY;
  const hasKey = Boolean(key && key.trim().length > 0);

  res.status(200).json({
    ok: true,
    hasKey,
    // length only (so we never leak the secret). Should be > 20 if present.
    keyLength: hasKey ? key.length : 0,
    env: process.env.VERCEL_ENV || "unknown", // "production", "preview", or "development"
  });
}
