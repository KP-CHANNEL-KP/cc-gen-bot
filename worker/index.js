// worker/index.js

const TELEGRAM_SEND_URL = (token) => `https://api.telegram.org/bot${token}/sendMessage`;

// Utility: Luhn
function luhnValid(num) {
  const s = num.replace(/\D/g, '');
  if (!s) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = parseInt(s[i], 10);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function genFromFormat(fmt) {
  let out = '';
  for (const ch of fmt) {
    if ('xX#?'.includes(ch)) out += String(Math.floor(Math.random() * 10));
    else out += ch;
  }
  return out;
}

function simpleBinInfo(bin) {
  bin = bin.replace(/\D/g, '').slice(0, 8);
  if (bin.length < 6) return { error: 'BIN must be >= 6 digits' };
  const res = { bin };
  if (bin.startsWith('4')) res.scheme = 'visa';
  else {
    const first2 = parseInt(bin.slice(0,2),10);
    const first4 = parseInt(bin.slice(0,4),10);
    if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) res.scheme = 'mastercard';
    else res.scheme = 'unknown';
  }
  return res;
}

async function replyText(token, chat_id, text, parse_mode='Markdown') {
  const url = TELEGRAM_SEND_URL(token);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode })
  });
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  // For extra safety, expect webhook path like /telegram/<SECRET>
  // The secret is part of the Worker route; we still read it from path but validate optionally.
  if (request.method !== 'POST') return new Response('OK', { status: 200 });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('bad json', { status: 400 });
  }

  const TELEGRAM_TOKEN = TELEGRAM_TOKEN_ENV; // replaced by wrangler env var during deploy
  if (!TELEGRAM_TOKEN) return new Response('No token', { status: 500 });

  // Basic safety: ensure it's a Telegram update
  const update = body;
  const message = update.message || update.edited_message || update.callback_query && update.callback_query.message;
  if (!message || !message.text) return new Response('no message', { status: 200 });

  const text = message.text.trim();
  const chat_id = message.chat.id;
  const from_id = message.from && message.from.id;

  // commands
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  try {
    if (cmd === '/start' || cmd === '/help') {
      const help = `👋 *CC Gen & BIN Checker (Worker)*\n\nCommands:\n/gen <format>\n/gen10 <format>\n/luhn <number>\n/bininfo <bin>\n/check <number>\n\n_Testing only._`;
      await replyText(TELEGRAM_TOKEN, chat_id, help);
      return new Response('ok', { status: 200 });
    }

    if (cmd === '/gen' || cmd === '/gen10') {
      if (parts.length < 2) {
        await replyText(TELEGRAM_TOKEN, chat_id, "Usage: /gen 414720xxxxxxxxxx");
        return new Response('ok', { status: 200 });
      }
      const fmt = parts.slice(1).join(' ');
      const count = cmd === '/gen' ? 1 : 10;
      const out = [];
      for (let i=0;i<count;i++) {
        const card = genFromFormat(fmt);
        const ok = luhnValid(card) ? '✅ Luhn OK' : '❌ Luhn FAIL';
        out.push(`${card} — ${ok}`);
      }
      await replyText(TELEGRAM_TOKEN, chat_id, '```\n' + out.join('\n') + '\n```');
      return new Response('ok', { status: 200 });
    }

    if (cmd === '/luhn') {
      if (parts.length < 2) {
        await replyText(TELEGRAM_TOKEN, chat_id, "Usage: /luhn 4242424242424242");
        return new Response('ok', { status: 200 });
      }
      const num = parts[1].replace(/\D/g,'');
      const ok = luhnValid(num);
      await replyText(TELEGRAM_TOKEN, chat_id, `Luhn valid: ${ok ? 'Yes ✅' : 'No ❌'}`);
      return new Response('ok', { status: 200 });
    }

    if (cmd === '/bininfo') {
      if (parts.length < 2) {
        await replyText(TELEGRAM_TOKEN, chat_id, "Usage: /bininfo 414720");
        return new Response('ok', { status: 200 });
      }
      const info = simpleBinInfo(parts[1]);
      await replyText(TELEGRAM_TOKEN, chat_id, '```\n' + JSON.stringify(info, null, 2) + '\n```');
      return new Response('ok', { status: 200 });
    }

    if (cmd === '/check') {
      if (parts.length < 2) {
        await replyText(TELEGRAM_TOKEN, chat_id, "Usage: /check 4242424242424242");
        return new Response('ok', { status: 200 });
      }
      const num = parts[1].replace(/\D/g,'');
      const luhn_ok = luhnValid(num);
      await replyText(TELEGRAM_TOKEN, chat_id, `Length: ${num.length}\nLuhn: ${luhn_ok ? 'OK' : 'FAIL'}`);
      return new Response('ok', { status: 200 });
    }

    // fallback
    await replyText(TELEGRAM_TOKEN, chat_id, "Unknown command. Use /help");
    return new Response('ok', { status: 200 });
  } catch (err) {
    // Optionally log to console (visible in Cloudflare Worker logs)
    console.error(err);
    return new Response('error', { status: 500 });
  }
}
