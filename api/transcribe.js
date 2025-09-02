// api/transcribe.js
// Accepts EITHER:
//  (A) multipart/form-data: { file: <audio blob>, model? }  ← matches your front-end
//  (B) JSON: { audio: "data:<mime>;base64,..." }            ← fallback
// Forwards to OpenAI Whisper and returns { text }.

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      res.status(500).json({ error: "Server missing OPENAI_API_KEY" });
      return;
    }

    const ct = String(req.headers["content-type"] || "");
    const toOpenAI = {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    };

    if (ct.includes("multipart/form-data")) {
      // Pass raw body + boundary straight through to OpenAI
      const raw = await readRaw(req);
      toOpenAI.headers["Content-Type"] = ct; // keep boundary
      toOpenAI.body = raw;
    } else {
      // JSON fallback: { audio: "data:<mime>;base64,..." }
      const { audio, model } = await readJson(req);
      if (!audio || typeof audio !== "string" || !audio.includes("base64,")) {
        res.status(400).json({ error: "Missing audio data URL" });
        return;
      }
      const base64 = audio.split("base64,").pop();
      const buf = Buffer.from(base64, "base64");
      const mime = (audio.match(/^data:(.*?);base64,/) || [,"audio/webm"])[1];

      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mime }), "clip.webm");
      fd.append("model", model || "whisper-1");
      toOpenAI.body = fd; // fetch sets correct Content-Type with boundary
    }

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", toOpenAI);

    // Bubble up useful diagnostics (no secrets)
    if (!r.ok) {
      const detail = await r.text().catch(() => "(no body)");
      res.status(r.status).json({
        error: "OpenAI transcription failed",
        detail: detail.slice(0, 800),
      });
      return;
    }

    const data = await r.json(); // { text: "..." }
    res.status(200).json({ text: data.text || "" });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// helpers
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
