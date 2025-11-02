// worker.js
// CC Gen + real BIN info via binlist.net + Stripe (test) validator
// - /gen <6-digit> -> 10 cards (table) + real BIN info fetched from binlist.net (cached 24h)
// - /gen1 <6-digit> -> single card
// - /validate <num> <mm> <yyyy> <cvc> -> Stripe test token (optional)
// Env vars: TELEGRAM_TOKEN_ENV, STRIPE_SECRET (optional)

// --------------------------
// Helpers: CC generation
// --------------------------
function generateCC(binFormat) {
  let cc = "";
  for (let c of binFormat) {
    if (c === "x" || c === "X") cc += Math.floor(Math.random() * 10);
    else cc += c;
  }
  return cc;
}

function generateExpiryParts() {
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = String(Math.floor(Math.random() * 5) + 25); // YY 25..29
  return { month, year };
}

function generateCVV() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function generateFullCCParts(shortBin) {
  const digits = (shortBin || "").replace(/\D/g, "").slice(0, 6);
  const short = digits.padEnd(6, "0");
  const template = short + "xxxxxxxxxx"; // 16 digits
  const ccNumber = generateCC(template);
  const { month, year } = generateExpiryParts();
  const cvv = generateCVV();
  return { ccNumber, month, year, cvv };
}

// --------------------------
// Fallback simple BIN info
// --------------------------
function simpleBinInfo(bin6) {
  const b = (bin6 || "").replace(/\D/g, "").slice(0, 6);
  if (b.length < 6) return { scheme: "unknown", type: "unknown", bank: "Unknown Bank", country: "Unknown", country_emoji: "" };
  let scheme = "UNKNOWN", type = "UNKNOWN";
  if (b.startsWith("4")) scheme = "VISA";
  const first2 = parseInt(b.slice(0,2), 10);
  const first4 = parseInt(b.slice(0,4), 10);
  if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) scheme = "MASTERCARD";
  type = "DEBIT";
  // small mapping examples
  let bank = "Unknown Bank", country = "Unknown", country_emoji = "";
  if (b.startsWith("525282") || b.startsWith("484783")) {
    bank = "AL RAJHI BANKING AND INVESTMENT CORP.";
    country = "SAUDI ARABIA";
    country_emoji = " 🇸🇦";
  } else if (b.startsWith("424242")) {
    bank = "Stripe Test Bank";
    country = "UNITED STATES";
    country_emoji = " 🇺🇸";
  }
  return { scheme, type, bank, country, country_emoji };
}

// --------------------------
// binlist lookup with caching (caches.default)
// - caches response JSON for 24 hours
// --------------------------
async function getBinInfo(bin6) {
  bin6 = (bin6 || "").replace(/\D/g, "").slice(0, 6);
  if (bin6.length < 6) return null;

  const cacheKey = `binlist:${bin6}`;
  try {
    // try cache first
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        const data = await cached.json();
        return data;
      } catch (e) {
        // fallthrough to network fetch
      }
    }

    // fetch from binlist
    const url = `https://lookup.binlist.net/${bin6}`;
    const resp = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "CF-Worker-BinLookup/1.0" } });
    if (!resp.ok) {
      // non-200 -> fallback
      return null;
    }
    const j = await resp.json();

    // Normalize fields we care about:
    const info = {
      scheme: j.scheme || j.brand || "unknown",
      type: j.type || "unknown",
      bank: (j.bank && (j.bank.name || j.bank)) || "Unknown Bank",
      country: (j.country && (j.country.name || j.country)) || (j.country && j.country.alpha2) || "Unknown",
      country_emoji: (j.country && j.country.alpha2) ? countryCodeToEmoji(j.country.alpha2) : ""
    };

    // cache JSON for 24h
    const respToCache = new Response(JSON.stringify(info), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
    // caches.default expects a Request object; we'll store under cacheKey by creating Request with cacheKey
    await cache.put(cacheKey, respToCache.clone());

    return info;
  } catch (e) {
    // network or other error -> return null to trigger fallback
    return null;
  }
}

// helper: convert country code (ISO 3166-1 alpha-2) to emoji
function countryCodeToEmoji(code) {
  if (!code) return "";
  const A = 0x1F1E6; // Regional Indicator Symbol Letter A
  const chars = code.toUpperCase().split('').map(c => A + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...chars);
}

// --------------------------
// Messaging helpers
// --------------------------
async function sendMessageHTML(chatId, htmlText, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: htmlText, parse_mode: "HTML", disable_web_page_preview: true };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// --------------------------
// Stripe tokenization (test only)
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
    headers: { "Authorization": auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

// small helper to escape HTML
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --------------------------
// Worker entry
// --------------------------
export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";
    const STRIPE_SECRET = env.STRIPE_SECRET || "";

    if (!TELEGRAM_TOKEN) return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });
    if (request.method !== "POST") return new Response("OK - Worker running", { status: 200 });

    let update;
    try { update = await request.json(); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) return new Response("No message", { status: 200 });

    const text = message.text.trim();
    const chatId = message.chat.id;

    // /start or /help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot (Test Only)",
        "",
        "Commands:",
        "/gen <6-digit>   — generate 10 cards (table) + BIN info below (real BIN via binlist.net)",
        "/gen1 <6-digit>  — generate 1 card (single line)",
        "/validate <num> <mm> <yyyy> <cvc> — validate via Stripe (TEST KEY ONLY)",
        "",
        "⚠️ Use only STRIPE_SECRET=test key (sk_test_...). Do NOT test real people's cards."
      ].join("\n");
      await sendMessageHTML(chatId, `<pre>${help}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen1 single line (easy copy)
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Format မမှန်ပါ၊ ဥပမာ: /gen1 525282</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const { ccNumber, month, year, cvv } = generateFullCCParts(digits);
      const line = `${ccNumber} | ${month}/20${year} | ${cvv}`;
      await sendMessageHTML(chatId, `<pre>${line}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen: table of 10 + BIN info from binlist (cached)
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Format မမှန်ပါ၊ ဥပမာ: /gen 525282</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // generate rows
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const { ccNumber, month, year, cvv } = generateFullCCParts(digits);
        const expiry = `${month}/20${year}`;
        rows.push({ ccNumber, expiry, cvv });
      }

      // build table (monospaced)
      const col1 = 19; const col2 = 10; const col3 = 6;
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2), "CVV".padEnd(col3)].join(" ");
      const sep = "-".repeat(col1 + col2 + col3 + 2);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.ccNumber.padEnd(col1) + " " + r.expiry.padEnd(col2) + " " + r.cvv.padEnd(col3));
      }
      const tableBlock = `<pre>${lines.join("\n")}</pre>`;

      // lookup BIN info from binlist.net (cached)
      const bin6 = digits.slice(0,6);
      let binInfo = await getBinInfo(bin6);
      if (!binInfo) {
        // fallback to simple heuristic if binlist failed
        const fb = simpleBinInfo(bin6);
        binInfo = { scheme: fb.scheme, type: fb.type, bank: fb.bank, country: fb.country, country_emoji: fb.country_emoji || "" };
      }

      const infoLines = [
        `<b>Bank:</b> ${escapeHtml(binInfo.bank)}`,
        `<b>Country:</b> ${escapeHtml(binInfo.country)}${binInfo.country_emoji || ""}`,
        `<b>BIN Info:</b> ${escapeHtml((binInfo.scheme || "unknown") + " - " + (binInfo.type || "unknown"))}`,
        `<b>BIN:</b> ${escapeHtml(bin6)}`
      ].join("\n");

      const finalHtml = tableBlock + "\n" + `<pre>${infoLines}</pre>`;

      await sendMessageHTML(chatId, finalHtml, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /validate: Stripe test tokenize
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
          await sendMessageHTML(chatId, `<pre>${out}</pre>`, TELEGRAM_TOKEN);
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
