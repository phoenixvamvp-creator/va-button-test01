// api/transcribe.js
// Serverless endpoint for "Hold to Talk" – sends a short webm/opus clip to OpenAI Whisper
export const config = { runtime: "nodejs18.x" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const { audio } = await readJson(req);
    if (!audio || typeof audio !== "string" || !audio.includes("base64,")) {
      res.status(400).json({ error: "Missing audio data URL" });
      return;
    }

    const base64 = audio.split("base64,").pop();
    const buf = Buffer.from(base64, "base64");

    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "audio/webm" }), "clip.webm");
    // You can switch to "gpt-4o-mini-transcribe" if your account has it enabled.
    fd.append("model", "whisper-1");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "(no body)");
      res
        .status(r.status)
        .json({ error: "OpenAI transcription failed", detail: body.slice(0, 400) });
      return;
    }

    const data = await r.json(); // { text: "..." }
    res.status(200).json({ text: data.text || "" });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

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
