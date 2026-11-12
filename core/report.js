// Always log the report locally (stdout -> logs/<action>.log). Only push it to
// Bitrix24 when the run FAILED (result.error is set). Successful runs stay quiet.
//
// Where it goes: `notify` (optional) picks the destination for this check —
//   dialogId: one or more Bitrix DIALOG_IDs, comma-separated: "chat1234" for a group
//             chat, a bare user ID like "57" for a direct message to that person.
//   webhook:  a different Bitrix inbound webhook (another portal or posting user).
// Each falls back to BITRIX_DIALOG_ID / BITRIX_WEBHOOK_URL, the default "AltomateHR
// Notif" chat. New checks pass their own <APP>_BITRIX_DIALOG_ID / _WEBHOOK_URL here.
//
// ARGUS_NO_NOTIFY=1 suppresses every Bitrix post (use it for test runs).
export async function sendReportOnFailure(result, text, notify = {}) {
  console.log('\n----- REPORT -----\n' + text + '\n------------------');
  if (result && result.error) {
    await sendReport(text, notify);
  } else {
    console.log('[report] all checks passed — logged only, no Bitrix notification sent');
  }
}

// Call: POST {webhook}/im.message.add.json with DIALOG_ID + MESSAGE, once per
// destination. The webhook's user must be a member of each group chat it posts to.
export async function sendReport(text, { dialogId, webhook } = {}) {
  if (/^(1|true|yes)$/i.test(process.env.ARGUS_NO_NOTIFY || '')) {
    console.log('[report] ARGUS_NO_NOTIFY set — Bitrix notification suppressed');
    return;
  }
  const hook = (webhook || process.env.BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
  const ids = (dialogId || process.env.BITRIX_DIALOG_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!hook || !ids.length) {
    console.error('[report] no Bitrix webhook / dialog ID configured — skipping report');
    return;
  }

  for (const id of ids) {
    const body = new URLSearchParams({ DIALOG_ID: id, MESSAGE: text });
    try {
      const res = await fetch(`${hook}/im.message.add.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && !json.error) {
        console.log(`[report] sent to Bitrix ${id} (message id ${json.result ?? '?'})`);
      } else {
        console.error(`[report] failed for ${id}: ${res.status} ${JSON.stringify(json)}`);
      }
    } catch (err) {
      console.error(`[report] error sending to ${id}: ${err.message}`);
    }
  }
}
