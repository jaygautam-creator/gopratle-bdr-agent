// Telegram Bot API helpers (plain HTTP; no n8n Telegram credential needed, the token comes from env).
async function getUpdates(ctx, offset) {
  const q = `offset=${offset || 0}&timeout=0&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
  const r = await ctx.http({ method: 'GET', url: `https://api.telegram.org/bot${ctx.env.TELEGRAM_BOT_TOKEN}/getUpdates?${q}`, timeoutMs: 15000 });
  if (r.status !== 200 || !r.json || !r.json.ok) throw new Error('Telegram getUpdates failed: ' + r.status + ' ' + ((r.json && r.json.description) || ''));
  return r.json.result || [];
}
const base = (ctx, method) => `https://api.telegram.org/bot${ctx.env.TELEGRAM_BOT_TOKEN}/${method}`;
const post = (ctx, method, body) => ctx.http({ method: 'POST', url: base(ctx, method), headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 15000 });
// `buttons` (optional) = rows of { text, callback_data } shown as inline buttons under the message.
async function sendMessage(ctx, chatId, text, buttons) {
  const body = { chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  const r = await post(ctx, 'sendMessage', body);
  return r.status === 200 && r.json && r.json.ok;
}
// Sends one reply item. If it answers a button press, also stops the button spinner and removes the buttons
// so a decision cannot be clicked twice. Button-handling failures never block the reply itself.
async function deliver(ctx, r) {
  if (r.callback_id) {
    await post(ctx, 'answerCallbackQuery', { callback_query_id: r.callback_id }).catch(() => {});
    if (r.message_id) await post(ctx, 'editMessageReplyMarkup', { chat_id: r.chat_id, message_id: r.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  return sendMessage(ctx, r.chat_id, r.text, r.buttons);
}
const allowedChats = (env) => String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const api = { getUpdates, sendMessage, deliver, allowedChats };
if (typeof module !== 'undefined') module.exports = api;
