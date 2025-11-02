// worker.js
// CC Gen Pack Format (single packed message) + gen1 + validate (Stripe test)
// Produces output like:
// **BIN ⇾** 484783856398**Amount ⇾** 104847838563981143|<card1>|MM|YYYY|CVV|<card2>|...**Bank:** AL RAJHI ...**Country:** SAUDI ARABIA 🇸🇦**BIN Info:** VISA - DEBIT

// --------------------------
// Helpers
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
  const year = String(Math.floor(Math.random() * 5) + 25); // 25..29 (YY)
  return { month, year };
}

function generateCVV() {
  return String(Math.floor(Math.random() * 900) + 100); // 100..999
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

// Simple BIN info heuristic (lightweight)
// For accurate data use an external BIN API (binlist.net) — not included here
function simpleBinInfo(bin) {
  const b = (bin || "").replace(/\D/g, "").slice(0, 8);
  if (b.length < 6) return { bin: b, scheme: "unknown", type: "unknown", bank: "unknown", country: "unknown", country_emoji: "" };
  let scheme = "unknown", type = "unknown";
  if (b.startsWith("4")) scheme = "VISA";
  const first2 = parseInt(b.slice(0,2), 10);
  const first4 = parseInt(b.slice(0,4), 10);
  if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) scheme = "MASTERCARD";
  // small heuristic for debit/credit (not reliable)
  type = "DEBIT";

  // Example bank mapping (extend as needed)
  let bank = "Unknown Bank";
  let country = "Unknown";
  let country_emoji = "";
  if (b.startsWith("484783")) {
    bank = "AL RAJHI BANKING AND INVESTMENT CORP.";
    country = "SAUDI ARABIA";
    country_emoji = " 🇸🇦";
  } else if (b.startsWith("424242")) {
    bank = "Stripe Test Bank";
    country = "UNITED STATES";
    country_emoji = " 🇺🇸";
  }

  return { bin: b, scheme, type, bank, country, country_emoji };
}

// send message (plain text)
async function sendMessagePlain(chatId, text, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: text, disable_web_page_preview: true };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Stripe tokenize (test only)
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
        "/gen <6-digit>    — generate 10 cards, packed single message (BIN ⇾ / Amount ⇾ / cards...)",
        "/gen1 <6-digit>   — generate 1 card (single line)",
        "/validate <num> <mm> <yyyy> <cvc> — validate via Stripe (TEST KEY ONLY)",
        "",
        "⚠️ Use only Stripe test key (STRIPE_SECRET=sk_test_...). Do NOT test real people's cards."
      ].join("\n");
      await sendMessagePlain(chatId, help, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen1: single line (easy copy)
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessagePlain(chatId, "❌ Format မမှန်ပါ၊ ဥပမာ: /gen1 414720", TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const { ccNumber, month, year, cvv } = generateFullCCParts(digits);
      const line = `${ccNumber}|${month}|20${year}|${cvv}`;
      await sendMessagePlain(chatId, line, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /gen: produce packed single message in requested format
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessagePlain(chatId, "❌ Format မမှန်ပါ၊ ဥပမာ: /gen 484783", TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // BIN to report (first 6 digits)
      const binReport = digits.slice(0, 6);
      // Generate big random Amount (18-digit)
      const amount = String(Math.floor(Math.random() * 9e17) + 1e17);

      // generate 10 cards and join as card|mm|yyyy|cvv|card2|...
      const partsList = [];
      for (let i = 0; i < 10; i++) {
        const { ccNumber, month, year, cvv } = generateFullCCParts(digits);
        const fullYear = "20" + year; // convert YY to YYYY
        partsList.push(`${ccNumber}|${month}|${fullYear}|${cvv}`);
      }
      const cardsPacked = partsList.join("|");

      // BIN info heuristic
      const binInfo = simpleBinInfo(binReport);
      const bank = binInfo.bank;
      const country = binInfo.country + (binInfo.country_emoji || "");
      const binDesc = `${binInfo.scheme} - ${binInfo.type}`;

      // Build final packed message
      const finalText =
        `**BIN ⇾** ${binReport}**Amount ⇾** ${amount}|${cardsPacked}**Bank:** ${bank}**Country:** ${country}**BIN Info:** ${binDesc}`;

      await sendMessagePlain(chatId, finalText, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // /validate
    if (text.startsWith("/validate")) {
      const parts = text.split(/\s+/);
      if (parts.length < 5) {
        await sendMessagePlain(chatId, "Usage: /validate <number> <exp_month> <exp_year> <cvc>\nExample: /validate 4242424242424242 12 2026 123", TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const cardNumber = parts[1].replace(/\D/g, "");
      const exp_month = parts[2];
      const exp_year = parts[3];
      const cvc = parts[4];

      if (!STRIPE_SECRET || !STRIPE_SECRET.startsWith("sk_test_")) {
        await sendMessagePlain(chatId, "⚠️ STRIPE_SECRET not set or not a test key. Set STRIPE_SECRET to a Stripe test key (sk_test_...)", TELEGRAM_TOKEN);
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
          await sendMessagePlain(chatId, out, TELEGRAM_TOKEN);
        } else {
          const errMsg = (res.body && res.body.error && res.body.error.message) ? res.body.error.message : JSON.stringify(res.body);
          await sendMessagePlain(chatId, `❌ Stripe error: ${errMsg}`, TELEGRAM_TOKEN);
        }
      } catch (e) {
        await sendMessagePlain(chatId, `⚠️ Request failed: ${String(e)}`, TELEGRAM_TOKEN);
      }
      return new Response("OK", { status: 200 });
    }

    // fallback
    await sendMessagePlain(chatId, "Unknown command. Use /help", TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  }
};
