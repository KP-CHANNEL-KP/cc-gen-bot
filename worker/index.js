// ==========================
// Telegram CC Gen Bot (Test Only)
// Nicely formatted, column-aligned output
// ==========================

// ==========================
// Helper Functions
// ==========================

// CC number generator
function generateCC(binFormat) {
  let cc = "";
  for (let c of binFormat) {
    if (c === "x") {
      cc += Math.floor(Math.random() * 10);
    } else {
      cc += c;
    }
  }
  return cc;
}

// Expiry date generator (MM/YY)
function generateExpiry() {
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = String(Math.floor(Math.random() * 5) + 25); // 25-29
  return `${month}/${year}`;
}

// CVV generator (3 digits)
function generateCVV() {
  return String(Math.floor(Math.random() * 900) + 100);
}

// Full CC generator from short 6-digit input
function generateFullCC(shortBin) {
  // normalize: keep digits only, take first 6 if longer
  const digits = (shortBin || "").replace(/\D/g, "").slice(0, 6);
  const short = digits.padEnd(6, "0");
  // build template: use the 6-digit prefix, then fill with 'x' to 16 digits
  const fullBinTemplate = short + "xxxxxxxxxx"; // 6 + 10 = 16
  const ccNumber = generateCC(fullBinTemplate);
  const expiry = generateExpiry();
  const cvv = generateCVV();
  return { ccNumber, expiry, cvv };
}

// Format cards into a monospaced pre block (aligned columns)
function formatCardsAsPre(cards) {
  // column widths
  const col1 = 19; // card number (16 digits) + padding
  const col2 = 7;  // expiry (MM/YY) + padding
  const col3 = 5;  // cvv + padding

  const header = [
    "Card Number".padEnd(col1),
    "Exp".padEnd(col2),
    "CVV".padEnd(col3),
  ].join(" ");

  const rows = cards.map((c, i) => {
    return [
      c.ccNumber.padEnd(col1),
      c.expiry.padEnd(col2),
      c.cvv.padEnd(col3),
    ].join(" ");
  });

  const lines = [header, "-".repeat(col1 + col2 + col3 + 2), ...rows];
  // Wrap in HTML pre so Telegram preserves spacing
  return `<pre>${lines.join("\n")}</pre>`;
}

// Send message to Telegram (using HTML parse mode so <pre> works)
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
    body: JSON.stringify(body),
  });
}

// ==========================
// Worker Entry Point
// ==========================
export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV; // From Cloudflare Secret
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET_ENV; // From Cloudflare Secret

    // optional: if you used a secret path for webhook, validate it here
    // (skip if you handle route-level secret)
    // Example: if you expect path /telegram/SECRET, you can check request.url

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

    if (text.startsWith("/start")) {
      const help = [
        "👋 CC Gen Bot (Test Only)",
        "",
        "အသုံးပြုပုံ:",
        "/gen <6-digit prefix>  — ဥပမာ: /gen 414720",
        "",
        "Reply will be neatly formatted (Card | Exp | CVV).",
      ].join("\n");
      await sendMessage(chatId, `<pre>${help}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    else if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const args = parts[1] || "";
      const digitsOnly = args.replace(/\D/g, "");

      if (!digitsOnly || digitsOnly.length < 6) {
        await sendMessage(
          chatId,
          `<pre>❌ Format မမှန်ပါ။ နံပါတ် 6 လုံးထည့်ပါ။ ဥပမာ:\n/gen 414720</pre>`,
          TELEGRAM_TOKEN
        );
        return new Response("OK", { status: 200 });
      }

      // generate 10 cards
      const cards = [];
      for (let i = 0; i < 10; i++) {
        const card = generateFullCC(digitsOnly);
        cards.push(card);
      }

      const formatted = formatCardsAsPre(cards);
      await sendMessage(chatId, formatted, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // fallback
    await sendMessage(chatId, `<pre>Unknown command. Use /help or /gen 414720</pre>`, TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  },
};
