// worker.js
// /gen <6-digit> -> generate 10 cards (neatly formatted table in one message)
//                -> below table: Bank, Country, BIN Info
// /gen1 <6-digit> -> single card line
// /validate <num> <mm> <yyyy> <cvc> -> Stripe test tokenize (optional)
// Env vars required: TELEGRAM_TOKEN_ENV, STRIPE_SECRET (optional for /validate)

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

// Simple BIN info heuristic (lightweight). For exact info, call a BIN API (binlist).
function simpleBinInfo(bin) {
  const b = (bin || "").replace(/\D/g, "").slice(0, 6);
  if (b.length < 6) return { bin: b, scheme: "unknown", type: "unknown", bank: "Unknown Bank", country: "Unknown", country_emoji: "" };

  let scheme = "UNKNOWN", type = "UNKNOWN";
  if (b.startsWith("4")) scheme = "VISA";
  const first2 = parseInt(b.slice(0,2), 10);
  const first4 = parseInt(b.slice(0,4), 10);
  if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) scheme = "MASTERCARD";

  // heuristic type (very rough)
  type = "DEBIT";

  // small mapping examples (extend as needed)
  let bank = "Unknown Bank";
  let country = "Unknown";
  let country_emoji = "";
  // example mappings
  if (b.startsWith("525282")) { // example bin you gave
    bank = "AL RAJHI BANKING AND INVESTMENT CORP."; // replace with accurate if you have
    country = "SAUDI ARABIA";
    country_emoji = " 🇸🇦";
  } else if (b.startsWith("484783")) {
    bank = "AL RAJHI BANKING AND INVESTMENT CORP.";
    country = "SAUDI ARABIA";
    country_emoji = " 🇸🇦";
  } else if (b.startsWith("424242")) {
    bank = "Stripe Test Bank";
    country = "UNITED STATES";
    country_emoji = " 🇺🇸";
  } else if (b.startsWith("5252")) {
    bank = "Example Bank";
    country = "UNITED KINGDOM";
    country_emoji = " 🇬🇧";
  }

  return { bin: b, scheme, type, bank, country, country_emoji };
}

async function sendMessageHTML(chatId, htmlText, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Stripe tokenization (test only)
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
        "/gen <6-digit>   — generate 10 cards (table) + BIN info below",
        "/gen1 <6-digit>  — generate 1 card (single line)",
        "/validate <num> <mm> <yyyy> <cvc> — validate via Stripe (TEST KEY ONLY)",
        "",
        "⚠️ Use only STRIPE_SECRET=test key (sk_test_...). Do not test real people's cards."
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

    // /gen: table of 10 + BIN info below
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Format မမှန်ပါ၊ ဥပမာ: /gen 525282</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // generate 10 cards
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const { ccNumber, month, year, cvv } = generateFullCCParts(digits);
        const expiry = `${month}/20${year}`;
        rows.push({ ccNumber, expiry, cvv });
      }

      // build monospaced table
      // column widths
      const col1 = 19; // card number
      const col2 = 10; // expiry
      const col3 = 6;  // cvv

      const header = [
        "Card Number".padEnd(col1),
        "Expiry".padEnd(col2),
        "CVV".padEnd(col3)
      ].join(" ");

      const sep = "-".repeat(col1 + col2 + col3 + 2);

      const lines = [header, sep];
      for (const r of rows) {
        lines.push(
          r.ccNumber.padEnd(col1) + " " + r.expiry.padEnd(col2) + " " + r.cvv.padEnd(col3)
        );
      }

      // BIN info (heuristic)
      const bin6 = digits.slice(0,6);
      const binInfo = simpleBinInfo(bin6);
      const bank = binInfo.bank;
      const country = binInfo.country + (binInfo.country_emoji || "");
      const binDesc = `${binInfo.scheme} - ${binInfo.type}`;

      // assemble message: table then blank line then info (use HTML <pre> for table)
      const tableBlock = `<pre>${lines.join("\n")}</pre>`;
      const infoBlock = `<b>Bank:</b> ${escapeHtml(bank)}\n<b>Country:</b> ${escapeHtml(country)}\n<b>BIN Info:</b> ${escapeHtml(binDesc)}\n<b>BIN:</b> ${escapeHtml(bin6)}`;

      const finalHtml = tableBlock + "\n" + `<pre>${infoBlock}</pre>`; // keep info in pre to preserve layout

      await sendMessageHTML(chatId, finalHtml, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /validate: Stripe test tokenization
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

// small helper to escape HTML in interpolated text
function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
