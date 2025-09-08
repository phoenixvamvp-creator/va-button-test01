<script>
  // ...existing top-level consts...
  let chatOn = false;
  let chatChunks = [];            // accumulate raw MediaRecorder chunks
  const CHAT_BATCH_MS = 1200;     // send ~1.2s segments
  let chatTimer = null;

  // When CHAT is toggled ON:
  function startChatMode() {
    chatOn = true;
    chatChunks = [];
    if (!chatTimer) {
      chatTimer = setInterval(async () => {
        if (!chatOn || chatChunks.length === 0) return;

        // Build a proper WebM segment from accumulated chunks
        const seg = new Blob(chatChunks, { type: supported }); // 'audio/webm;codecs=opus'
        chatChunks = []; // reset buffer

        // Convert to data URL and send to /api/transcribe
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(seg);
        });

        try {
          const tr = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: dataUrl })
          });

          const ct = tr.headers.get('content-type') || '';
          const body = ct.includes('application/json') ? await tr.json() : { error: await tr.text() };

          if (!tr.ok || body.error) {
            diag.textContent += `\n[CHAT] transcribe server error: ${body.error || tr.statusText}`;
            return;
          }

          const text = body.text || '';
          if (text) {
            // do something with partial transcript (append to output)
            output.textContent = `You (live): ${text}`;
          }
        } catch (e) {
          diag.textContent += `\n[CHAT] transcribe network error: ${String(e)}`;
        }
      }, CHAT_BATCH_MS);
    }
  }

  function stopChatMode() {
    chatOn = false;
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  }

  // Hook MediaRecorder to accumulate chunks while recording
  async function startRecording() {
    // ... your existing getUserMedia + MediaRecorder setup ...
    // ensure this is present:
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) {
        audioChunks.push(e.data);     // your existing array for hold-to-talk
        if (chatOn) chatChunks.push(e.data); // also buffer for realtime
      }
    };
    // ...
  }
</script>
