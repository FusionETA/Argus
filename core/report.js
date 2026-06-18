export async function sendReport(text) {
  const apiKey = process.env.WAZZUP_API_KEY;
  const channelId = process.env.WAZZUP_CHANNEL_ID;
  const recipients = (process.env.REPORT_RECIPIENTS || '').split(',').map(r => r.trim()).filter(Boolean);

  for (const chatId of recipients) {
    const payload = JSON.stringify({
      channelId,
      chatId,
      chatType: 'whatsapp',
      text,
    });

    try {
      const res = await fetch('https://api.wazzup24.com/v3/message', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      if (res.ok) {
        console.log(`[report] sent to ${chatId}`);
      } else {
        const body = await res.text();
        console.error(`[report] failed for ${chatId}: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`[report] error sending to ${chatId}: ${err.message}`);
    }
  }
}
