export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { params } = req.body || {};
  return res.status(200).json({
    provider: 'adjustSheets',
    op: params.op,
    fileName: params.fileName,
    sheetName: params.sheetName,
    range: params.range || null,
    values: params.values || null,
    updated: params.op === 'append' ? 1 : 3 // mock count
  });
}
