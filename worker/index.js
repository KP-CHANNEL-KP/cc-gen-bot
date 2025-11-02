// worker.js
// Full deploy-ready Worker for Telegram CC Gen + BIN info via binlist.net (cached)
// Commands:
//   /start | /help
//   /gen <6-digit>   -> generate 10 cards (table) + BIN info below (binlist.net, cached 24h)
//   /gen1 <6-digit>  -> generate 1 card (single line)
//   /validate <num> <mm> <yyyy> <cvc> -> Stripe test tokenization (optional)
// Env vars (Cloudflare Worker): TELEGRAM_TOKEN_ENV (required), STRIPE_SECRET (optional for /validate)

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function countryCodeToEmoji(code) {
  if (!code) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(...code.toUpperCase().split("").map(c => A + c.charCodeAt(0) - 65));
}

// --------------------------
// BIN lookup (binlist.net) with caching
// --------------------------
async function getBinInfo(bin6) {
  bin6 = String(bin6 || "").replace(/\D/g, "").slice(0, 6);
  if (bin6.length < 6) return null;

  const cache = caches.default;
  const cacheKey = new Request(`https://workers.internal/binlist/${bin6}`);
  try {
    // try cache first
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        const cachedJson = await cached.json();
        return cachedJson;
      } catch (e) {
        // fallthrough to network
      }
    }

    // fetch from binlist
    const resp = await fetch(`https://lookup.binlist.net/${bin6}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "CF-Telegram-CCGen/1.0 (+https://example.com)"
      }
    });

    if (!resp.ok) {
      // don't throw — return null so caller shows Unknown
      return null;
    }

    const j = await resp.json();

    const info = {
      scheme: (j.scheme || j.brand || "unknown").toLowerCase(),
      type: (j.type || "unknown").toLowerCase(),
      bank: (j.bank && (j.bank.name || j.bank)) || "Unknown Bank",
      country: (j.country && (j.country.name || j.country)) || "Unknown",
      country_alpha2: (j.country && j.country.alpha2) || null,
      country_emoji: (j.country && j.country.alpha2) ? countryCodeToEmoji(j.country.alpha2) : ""
    };

    // cache normalized info for 24 hours
    const respToCache = new Response(JSON.stringify(info), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400"
      }
    });
    await cache.put(cacheKey, respToCache.clone());

    return info;
  } catch (e) {
    // network or other error
    return null;
  }
}

// --------------------------
// CC generation helpers
// --------------------------
function generateCCFromTemplate(template) {
  let cc = "";
  for (let c of template) {
    if (c === "x" || c === "X") {
      cc += Math.floor(Math.random() * 10);
    } else {
      cc += c;
    }
  }
  return cc;
}

function genExpiryYY() {
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = String(Math.floor(Math.random() * 5) + 25); // YY 25..29
  return { month, year }; // year like "25"
}

function genCVV() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function generateFullCardFromShort(short6) {
  const digits = String(short6 || "").replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
  const template = digits + "xxxxxxxxxx"; // 6 + 10 = 16 digits
  const ccNumber = generateCCFromTemplate(template);
  const { month, year } = genExpiryYY();
  const cvv = genCVV();
  return { ccNumber, expiry: `${month}/20${year}`, month, year: `20${year}`, cvv };
}

// --------------------------
// Messaging helpers (Telegram)
// --------------------------
async function sendMessageHTML(chatId, htmlText, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// --------------------------
// Stripe tokenization (test-only)
// --------------------------
async function stripeTokenize(cardNumber, exp_month, exp_year, cvc, STRIPE_SECRET) {
  const params = new URLSearchParams();
  params.append("card[number]", cardNumber);
  params.append("card[exp_month]", String(exp_month));
  params.append("card[exp_year]", String(exp_year));
  params.append("card[cvc]", String(cvc));
  const auth = "Basic " + btoa(STRIPE_SECRET + ":");
  const resp = await fetch("https://api.stripe.com/v1/tokens", {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

// --------------------------
// Worker entry
// --------------------------
export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";
    const STRIPE_SECRET = env.STRIPE_SECRET || "";

    if (!TELEGRAM_TOKEN) {
      return new Response("Error: TELEGRAM_TOKEN_ENV not set in Worker environment.", { status: 500 });
    }

    if (request.method !== "POST") {
      return new Response("✅ CC Gen Worker is running!", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) {
      return new Response("No message", { status: 200 });
    }

    const text = message.text.trim();
    const chatId = message.chat.id;

    // /start or /help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot (Test Only)",
        "",
        "Commands:",
        "/gen <6-digit>   — generate 10 cards (table) + BIN info from binlist.net (cached 24h)",
        "/gen1 <6-digit>  — generate 1 card (single line)",
        "/validate <num> <mm> <yyyy> <cvc> — validate via Stripe (TEST KEY ONLY)",
        "",
        "⚠️ Use only STRIPE_SECRET=test key (sk_test_...). Do NOT test real people's cards."
      ].join("\n");
      await sendMessageHTML(chatId, `<pre>${escapeHtml(help)}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen1 single line
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Format မှားနေပါတယ် — ဥပမာ: /gen1 525282</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const card = generateFullCardFromShort(digits);
      const line = `${card.ccNumber} | ${card.expiry} | ${card.cvv}`;
      await sendMessageHTML(chatId, `<pre>${escapeHtml(line)}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen (10 cards table + BIN info)
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Format မှားနေပါတယ် — ဥပမာ: /gen 525282</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // generate 10 cards
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const c = generateFullCardFromShort(digits);
        rows.push(c);
      }

      // build monospaced table
      const col1 = 19; // card num
      const col2 = 12; // expiry
      const col3 = 6;  // cvv
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2), "CVV".padEnd(col3)].join(" ");
      const sep = "-".repeat(col1 + col2 + col3 + 2);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.ccNumber.padEnd(col1) + " " + r.expiry.padEnd(col2) + " " + r.cvv.padEnd(col3));
      }
      const tableBlock = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;

      // lookup BIN info once (for the provided short)
      const bin6 = digits.slice(0, 6);
      let binInfo = await getBinInfo(bin6);

      // if binlist fails, show Unknown values
      let bank = "Unknown Bank";
      let country = "Unknown";
      let countryEmoji = "";
      let scheme = "unknown";
      let type = "unknown";
      if (binInfo) {
        bank = binInfo.bank || bank;
        country = binInfo.country || country;
        countryEmoji = binInfo.country_emoji || "";
        scheme = binInfo.scheme || scheme;
        type = binInfo.type || type;
      }

      const infoLines = [
        `<b>Bank:</b> ${escapeHtml(bank)}`,
        `<b>Country:</b> ${escapeHtml(country)} ${countryEmoji}`,
        `<b>BIN Info:</b> ${escapeHtml(`${scheme.toUpperCase()} - ${type.toUpperCase()}`)}`,
        `<b>BIN:</b> ${escapeHtml(bin6)}`
      ].join("\n");

      const finalHtml = tableBlock + "\n" + `<pre>${infoLines}</pre>`;

      await sendMessageHTML(chatId, finalHtml, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /validate (Stripe test tokenization)
    if (text.startsWith("/validate")) {
      const parts = text.split(/\s+/);
      if (parts.length < 5) {
        await sendMessageHTML(chatId, `<pre>Usage:\n/validate <number> <exp_month> <exp_year> <cvc>\nExample:\n/validate 4242424242424242 12 2026 123</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const cardNumber = parts[1].replace(/\D/g, "");
      const exp_month = parts[2];
      const exp_year = parts[3];
      const cvc = parts[4];

      if (!STRIPE_SECRET || !STRIPE_SECRET.startsWith("sk_test_")) {
        await sendMessageHTML(chatId, `<pre>⚠️ STRIPE_SECRET not set or not a test key. Set STRIPE_SECRET to a Stripe test key (sk_test_...)</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      try {
        const res = await stripeTokenize(cardNumber, exp_month, exp_year, cvc, STRIPE_SECRET);
        if (res.status === 200 && res.body && res.body.id) {
          const card = res.body.card || {};
          const out = [
            `✅ Test token created`,
            `Token: ${res.body.id}`,
            `Brand: ${card.brand || "unknown"}`,
            `Last4: ${card.last4 || "----"}`,
            `Funding: ${card.funding || "unknown"}`,
            `Country: ${card.country || "unknown"}`
          ].join("\n");
          await sendMessageHTML(chatId, `<pre>${escapeHtml(out)}</pre>`, TELEGRAM_TOKEN);
        } else {
          const errMsg = (res.body && res.body.error && res.body.error.message) ? res.body.error.message : JSON.stringify(res.body);
          await sendMessageHTML(chatId, `<pre>❌ Stripe error: ${escapeHtml(errMsg)}</pre>`, TELEGRAM_TOKEN);
        }
      } catch (e) {
        await sendMessageHTML(chatId, `<pre>⚠️ Request failed: ${escapeHtml(String(e))}</pre>`, TELEGRAM_TOKEN);
      }
      return new Response("OK", { status: 200 });
    }

    // fallback
    await sendMessageHTML(chatId, `<pre>Unknown command. Use /help</pre>`, TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  }
};
