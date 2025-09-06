export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { params } = req.body || {};
  return res.status(200).json({
    provider: 'searchSheets',
    fileName: params.fileName,
    sheetName: params.sheetName,
    range: params.range,
    rows: [
      ['Task', 'Owner', 'Overdue'],
      ['Replace lock - Unit 3', 'Ben', '1']
    ]
  });
}
