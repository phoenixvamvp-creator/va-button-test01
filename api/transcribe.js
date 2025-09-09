// /api/transcribe.js
export const config = { api: { bodyParser: { sizeLimit: '30mb' } } };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_BETA;

function send(res, code, payload) {
  res.status(code).json(payload);
}
function bad(res, code, msg) {
  return send(res, code, { error: msg });
}

// Parse a data URL like: data:audio/webm;base64,AAAA...
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma); // after "data:"
  const b64 = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(header)) return null;

  // header can be: "audio/webm;codecs=opus" or "audio/webm" etc.
  const mime = (header.split(";")[0] || "").toLowerCase() || "audio/webm";

  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  return { mime, buf };
}

// Normalize browser mimes to a clean pair OpenAI accepts
function normalizeAudioMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return { mime: "audio/webm", ext: "webm" };
  if (m.includes("ogg") || m.includes("oga")) return { mime: "audio/ogg", ext: "ogg" };
  if (m.includes("mp4")) return { mime: "audio/mp4", ext: "mp4" };
  if (m.includes("m4a")) return { mime: "audio/m4a", ext: "m4a" };
  if (m.includes("mp3") || m.includes("mpeg") || m.includes("mpga"))
    return { mime: "audio/mpeg", ext: "mp3" };
  if (m.includes("wav")) return { mime: "audio/wav", ext: "wav" };
  // Fall back to webm (most Androids)
  return { mime: "audio/webm", ext: "webm" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");
  if (!OPENAI_API_KEY) return bad(res, 500, "Missing OPENAI_API_KEY");

  const { audio } = req.body || {};
  if (!audio) return bad(res, 400, 'Missing "audio" (data URL)');

  const parsed = parseDataUrl(audio);
  if (!parsed) return bad(res, 400, "Invalid data URL");

  try {
    const norm = normalizeAudioMime(parsed.mime);
    // IMPORTANT: use a real File so FormData sends filename+type correctly
    const file = new File([parsed.buf], `audio.${norm.ext}`, { type: norm.mime });

    const form = new FormData();
    form.append("file", file);                 // <- filename & type preserved
    form.append("model", "whisper-1");         // OpenAI transcription model

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, // let fetch set boundary
      body: form,
    });

    // Show full upstream error to the client for debugging if it occurs
    if (!r.ok) {
      const text = await r.text().catch(() => `${r.status} ${r.statusText}`);
      return bad(res, 502, text);
    }

    const data = await r.json().catch(() => null);
    return send(res, 200, { text: (data && data.text) || "" });
  } catch (e) {
    return bad(res, 500, String(e));
  }
}
