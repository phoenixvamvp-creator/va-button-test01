async function handleTranscribe(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  if (!OPENAI_API_KEY) return error(res, 500, 'Missing OPENAI_API_KEY');

  const { audio } = req.body || {};
  if (!audio) return error(res, 400, 'Missing "audio" (data URL)');

  try {
    const parsed = parseDataUrl(audio);
    if (!parsed) return error(res, 400, 'Invalid data URL');

    const { mime, buf } = parsed;
    const lower = (mime || '').toLowerCase();

    // Choose extension
    let ext = 'webm';
    if (lower.includes('ogg')) ext = 'ogg';
    else if (lower.includes('mp4')) ext = 'mp4';
    else if (lower.includes('mpeg') || lower.includes('mpga')) ext = 'mp3';
    else if (lower.includes('wav')) ext = 'wav';
    else if (lower.includes('m4a')) ext = 'm4a';

    // Use File instead of Blob
    const file = new File([buf], `audio.${ext}`, { type: `audio/${ext}` });

    const form = new FormData();
    form.append('file', file);
    form.append('model', 'whisper-1');

    const data = await openaiForm('audio/transcriptions', form);
    res.status(200).json({ text: data?.text || '' });
  } catch (e) {
    error(res, 500, String(e));
  }
}
