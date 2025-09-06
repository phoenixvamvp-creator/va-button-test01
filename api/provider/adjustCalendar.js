export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { params } = req.body || {};
  return res.status(200).json({
    provider: 'adjustCalendar',
    action: params.action,
    title: params.title,
    when: params.when,
    status: 'mocked'
  });
}
