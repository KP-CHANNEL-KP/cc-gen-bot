// ==========================
// Telegram CC Gen Bot (Test Only)
// - /gen <6-digit>        => generate 10 cards (Card | Exp | CVV) (neatly formatted)
// - /validate <num> <mm> <yyyy> <cvc> => tokenize via Stripe (TEST KEY ONLY)
// IMPORTANT: Use only Stripe test key (sk_test_...). Do NOT validate real cards.
// ==========================

// --------------------------
// Helpers
// --------------------------

function generateCC(binFormat) {
  let cc = "";
  for (let c of binFormat) {
    if (c === "x") cc += Math.floor(Math.random() * 10);
    else cc += c;
  }
  return cc;
}

function generateExpiry() {
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = String(Math.floor(Math.random() * 5) + 25); // 25..29
  return `${month}/${year}`;
}

function generateCVV() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function generateFullCC(shortBin) {
  const digits = (shortBin || "").replace(/\D/g, "").slice(0, 6);
  const short = digits.padEnd(6, "0");
  const fullTemplate = short + "xxxxxxxxxx"; // 6 + 10 = 16
  const ccNumber = generateCC(fullTemplate);
  const expiry = generateExpiry();
  const cvv = generateCVV();
  return { ccNumber, expiry, cvv };
}

function formatCardsAsPre(cards) {
  const col1 = 19; // card
  const col2 = 7;  // exp
  const col3 = 5;  // cvv
  const header = [
    "Card Number".padEnd(col1),
    "Exp".padEnd(col2),
    "CVV".padEnd(col3)
  ].join(" ");
  const rows = cards.map(c => {
    return [
      c.ccNumber.padEnd(col1),
      c.expiry.padEnd(col2),
      c.cvv.padEnd(col3)
    ].join(" ");
  });
  const lines = [header, "-".repeat(col1 + col2 + col3 + 2), ...rows];
  return `<pre>${lines.join("\n")}</pre>`;
}

async function sendMessage(chatId, htmlText, TELEGRAM_TOKEN) {
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
// Stripe tokenization (test only)
// Returns parsed JSON response and HTTP status
// --------------------------
async function stripeTokenize(cardNumber, exp_month, exp_year, cvc, STRIPE_SECRET) {
  // Build x-www-form-urlencoded body
  const params = new URLSearchParams();
  params.append("card[number]", cardNumber);
  params.append("card[exp_month]", String(exp_month));
  params.append("card[exp_year]", String(exp_year));
  params.append("card[cvc]", String(cvc));

  // Basic auth using secret key (as username)
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
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";   // required
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET_ENV || "";   // optional
    const STRIPE_SECRET = env.STRIPE_SECRET || "";         // should be sk_test_...

    // If you used a secret path component for the webhook route, you can validate here:
    // (Optional) Example:
    // const url = new URL(request.url);
    // if (!url.pathname.includes(WEBHOOK_SECRET)) return new Response("Forbidden", { status: 403 });

    if (request.method !== "POST") {
      return new Response("✅ CC Gen Worker is running!", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    const message = update.message;
    if (!message || !message.text) {
      return new Response("No message", { status: 200 });
    }

    const text = message.text.trim();
    const chatId = message.chat.id;

    // ---------- /start ----------
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot (Test Only)",
        "",
        "Commands:",
        "/gen <6-digit>    — generate 10 test cards (Card | Exp | CVV)",
        "/validate <num> <mm> <yyyy> <cvc>  — validate via Stripe (TEST KEY ONLY)",
        "",
        "⚠️ Use only Stripe test key (STRIPE_SECRET=sk_test_...). Do not use real cards."
      ].join("\n");
      await sendMessage(chatId, `<pre>${help}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // ---------- /gen ----------
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      const digits = arg.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        await sendMessage(chatId, `<pre>❌ Format မမှန်ပါ။ နံပါတ် 6 လုံးထည့်ပါ။ ဥပမာ:\n/gen 414720</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }
      const cards = [];
      for (let i = 0; i < 10; i++) cards.push(generateFullCC(digits));
      const formatted = formatCardsAsPre(cards);
      await sendMessage(chatId, formatted, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // ---------- /validate ----------
    if (text.startsWith("/validate")) {
      const parts = text.split(/\s+/);
      // expected: /validate 4242424242424242 12 2026 123
      if (parts.length < 5) {
        await sendMessage(chatId, `<pre>Usage:\n/validate <number> <exp_month> <exp_year> <cvc>\nExample:\n/validate 4242424242424242 12 2026 123</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      const cardNumber = parts[1].replace(/\D/g, "");
      const exp_month = parts[2];
      const exp_year = parts[3];
      const cvc = parts[4];

      // Safety: require test key
      if (!STRIPE_SECRET || !STRIPE_SECRET.startsWith("sk_test_")) {
        await sendMessage(chatId, `<pre>⚠️ STRIPE_SECRET not set or not a test key. Set STRIPE_SECRET to a Stripe test key (sk_test_...)</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      try {
        const res = await stripeTokenize(cardNumber, exp_month, exp_year, cvc, STRIPE_SECRET);
        if (res.status === 200 && res.body && res.body.id) {
          // token created => Stripe accepted details (in test mode)
          const card = res.body.card || {};
          const out = [
            `✅ Test token created`,
            `Token: ${res.body.id}`,
            `Brand: ${card.brand || "unknown"}`,
            `Last4: ${card.last4 || "----"}`,
            `Funding: ${card.funding || "unknown"}`,
            `Country: ${card.country || "unknown"}`
          ].join("\n");
          await sendMessage(chatId, `<pre>${out}</pre>`, TELEGRAM_TOKEN);
        } else {
          // error from Stripe
          const errMsg = (res.body && res.body.error && res.body.error.message) ? res.body.error.message : JSON.stringify(res.body);
          await sendMessage(chatId, `<pre>❌ Stripe error: ${errMsg}</pre>`, TELEGRAM_TOKEN);
        }
      } catch (e) {
        await sendMessage(chatId, `<pre>⚠️ Request failed: ${String(e)}</pre>`, TELEGRAM_TOKEN);
      }

      return new Response("OK", { status: 200 });
    }

    // ---------- fallback ----------
    await sendMessage(chatId, `<pre>Unknown command. Use /help</pre>`, TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  }
};
