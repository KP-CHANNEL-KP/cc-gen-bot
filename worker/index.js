// ==========================
// Telegram CC Gen Bot (Test Only)
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
  const fullBin = shortBin.padEnd(16, "x"); // Auto fill to 16 digits
  const ccNumber = generateCC(fullBin);
  const expiry = generateExpiry();
  const cvv = generateCVV();
  return { ccNumber, expiry, cvv };
}

// Send message to Telegram
async function sendMessage(chatId, text, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: text };
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

    if (request.method !== "POST") {
      return new Response("✅ CC Gen Worker is running!", { status: 200 });
    }

    const update = await request.json();
    const message = update.message;
    if (!message || !message.text) {
      return new Response("No message", { status: 200 });
    }

    const text = message.text.trim();
    const chatId = message.chat.id;

    if (text.startsWith("/start")) {
      await sendMessage(
        chatId,
        "👋 CC Gen Bot (Test Only)\nအသုံးပြုပုံ:\n/gen 414720",
        TELEGRAM_TOKEN
      );
    } else if (text.startsWith("/gen")) {
      const args = text.split(" ")[1];
      if (!args || args.length < 6) {
        await sendMessage(
          chatId,
          "❌ Format မမှန်ပါ။ နံပါတ် 6 လုံးထည့်ပါ။ ဥပမာ:\n/gen 414720",
          TELEGRAM_TOKEN
        );
      } else {
        let cards = [];
        for (let i = 0; i < 10; i++) {
          const { ccNumber, expiry, cvv } = generateFullCC(args);
          cards.push(`${ccNumber} | ${expiry} | ${cvv}`);
        }
        await sendMessage(chatId, "✅ Generated Cards:\n\n" + cards.join("\n"), TELEGRAM_TOKEN);
      }
    }

    return new Response("OK", { status: 200 });
  },
};
