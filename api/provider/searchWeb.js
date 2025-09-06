export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { params } = req.body || {};
  return res.status(200).json({
    provider: 'searchWeb',
    results: [
      { title: 'Placeholder Result 1', link: 'https://example.com/1', snippet: `Results for "${params.query}"` },
      { title: 'Placeholder Result 2', link: 'https://example.com/2', snippet: `More on "${params.query}"` }
    ]
  });
}
