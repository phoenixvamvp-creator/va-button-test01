export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { params } = req.body || {};
  return res.status(200).json({
    provider: 'searchDrive',
    files: [
      { name: `Mock match for "${params.query}"`, id: 'file_123', mimeType: 'application/pdf', folder: params.folder }
    ]
  });
}
