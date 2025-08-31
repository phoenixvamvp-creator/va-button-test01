// api/transcribe.js
// Serverless endpoint for Hold-to-Talk: accepts a webm/opus data URL and returns transcript text.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    // Read JSON body
    const { audio } = await readJson(req);
    if (!audio || typeof audio !== "string" || !audio.includes("base64,")) {
      res.status(400).json({ error: "Missing audio data URL" });
      return;
    }

    // Decode base64 -> Uint8Array -> Blob (Node 18+ has Blob/FormData/fetch)
    const base64 = audio.split("base64,").pop();
    const buf = Buffer.from(base64, "base64");
    const fileBlob = new Blob([buf], { type: "audio/webm" });

    const fd = new FormData();
    fd.append("file", fileBlob, "clip.webm");
    // If your account has it, you can try: "gpt-4o-mini-transcribe"
    fd.append("model", "whisper-1");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "(no body)");
      res.status(r.status).json({
        error: "OpenAI transcription failed",
        detail: body.slice(0, 400),
      });
      return;
    }

    const data = await r.json(); // { text: "..." }
    res.status(200).json({ text: data.text || "" });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

// ---- helper ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
