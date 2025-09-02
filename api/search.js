// api/search.js
// Web search via SerpAPI (Google). Returns top 5 results: title, link, snippet.

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const { q } = await readJson(req);
    if (!q || typeof q !== "string" || !q.trim()) {
      res.status(400).json({ error: "Missing query q" });
      return;
    }

    const key = process.env.SERPAPI_KEY;
    if (!key) {
      res.status(500).json({ error: "Server missing SERPAPI_KEY" });
      return;
    }

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", q);
    url.searchParams.set("api_key", key);
    url.searchParams.set("num", "10"); // ask for more; we'll trim below
    url.searchParams.set("hl", "en");

    const r = await fetch(url.toString(), { method: "GET" });

    if (!r.ok) {
      const detail = await r.text().catch(() => "(no body)");
      res.status(r.status).json({ error: "Search failed", detail: detail.slice(0, 600) });
      return;
    }

    const data = await r.json();
    const organic = Array.isArray(data.organic_results) ? data.organic_results : [];

    const results = organic.slice(0, 5).map(item => ({
      title: item.title || "",
      link: item.link || "",
      snippet: item.snippet || item.snippet_highlighted_words?.join(" ") || ""
    }));

    res.status(200).json({
      query: q,
      results
    });
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
