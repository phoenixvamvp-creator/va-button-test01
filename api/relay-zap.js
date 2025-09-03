// api/relay-zap.js
// Secure server-side relay → forwards { message } to your Zapier Catch Hook.
// Keeps your Zapier URL secret (in Vercel env var ZAPIER_HOOK_URL).

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const ZAP_URL = process.env.ZAPIER_HOOK_URL;
    if (!ZAP_URL) {
      return res.status(500).json({ error: "Server missing ZAPIER_HOOK_URL" });
    }

    // Minimal, predictable payload so Zapier's "child key" choice is trivial.
    const { message } = await readJson(req);
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' (string)" });
    }

    // Add a bit of helpful context Zapier can use if you want (optional).
    const payload = {
      message,
      source: "phoenixva",
      ts_iso: new Date().toISOString(),
      user_agent: req.headers["user-agent"] || ""
    };

    const r = await fetch(ZAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "(no body)");
      return res.status(r.status).json({
        error: "Zapier hook failed",
        detail: detail.slice(0, 600)
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
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
