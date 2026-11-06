// Always log the report locally (stdout -> logs/<action>.log). Only push it to the
// Bitrix24 chat when the run FAILED (result.error is set). Successful runs stay quiet.
export async function sendReportOnFailure(result, text) {
  console.log('\n----- REPORT -----\n' + text + '\n------------------');
  if (result && result.error) {
    await sendReport(text);
  } else {
    console.log('[report] all checks passed — logged only, no Bitrix notification sent');
  }
}

// Posts the smoke-test report into the "AltomateHR Notif" Bitrix24 chat — the same
// chat (and webhook) the HR app uses for its sign-in notifications.
// Call: POST {BITRIX_WEBHOOK_URL}/im.message.add.json  with DIALOG_ID + MESSAGE.
export async function sendReport(text) {
  const webhook = (process.env.BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
  const dialogId = (process.env.BITRIX_DIALOG_ID || '').trim();

  if (!webhook || !dialogId) {
    console.error('[report] BITRIX_WEBHOOK_URL / BITRIX_DIALOG_ID not set — skipping report');
    return;
  }

  const body = new URLSearchParams({ DIALOG_ID: dialogId, MESSAGE: text });

  try {
    const res = await fetch(`${webhook}/im.message.add.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error) {
      console.log(`[report] sent to Bitrix ${dialogId} (message id ${json.result ?? '?'})`);
    } else {
      console.error(`[report] failed for ${dialogId}: ${res.status} ${JSON.stringify(json)}`);
    }
  } catch (err) {
    console.error(`[report] error sending to ${dialogId}: ${err.message}`);
  }
}
