// api/speak.js
// Text → speech via OpenAI TTS (returns audio/mpeg)

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

    const { text, voice = "alloy", format = "mp3" } = await readJson(req);
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing text" });
      return;
    }

    // tts-1 supports several voices ("alloy", "verse", "aria", etc.)
    const ttsReq = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: text,
        format // "mp3" or "wav" or "opus"
      })
    });

    if (!ttsReq.ok) {
      const detail = await ttsReq.text().catch(() => "(no body)");
      res.status(ttsReq.status).json({ error: "TTS failed", detail: detail.slice(0, 800) });
      return;
    }

    // Stream the audio back to the browser
    const arrayBuf = await ttsReq.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(arrayBuf));
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
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
