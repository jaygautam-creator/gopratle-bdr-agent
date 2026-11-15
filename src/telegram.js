// Telegram Bot API helpers (plain HTTP; no n8n Telegram credential needed, the token comes from env).
async function getUpdates(ctx, offset) {
  const q = `offset=${offset || 0}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`;
  const r = await ctx.http({ method: 'GET', url: `https://api.telegram.org/bot${ctx.env.TELEGRAM_BOT_TOKEN}/getUpdates?${q}`, timeoutMs: 15000 });
  if (r.status !== 200 || !r.json || !r.json.ok) throw new Error('Telegram getUpdates failed: ' + r.status + ' ' + ((r.json && r.json.description) || ''));
  return r.json.result || [];
}
async function sendMessage(ctx, chatId, text) {
  const r = await ctx.http({ method: 'POST', url: `https://api.telegram.org/bot${ctx.env.TELEGRAM_BOT_TOKEN}/sendMessage`, headers: { 'Content-Type': 'application/json' },
    body: { chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true }, timeoutMs: 15000 });
  return r.status === 200 && r.json && r.json.ok;
}
const allowedChats = (env) => String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const api = { getUpdates, sendMessage, allowedChats };
if (typeof module !== 'undefined') module.exports = api;
