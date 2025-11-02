// ==========================
// Telegram CC Gen Bot (Test Only)
// ==========================

const TELEGRAM_TOKEN = TELEGRAM_TOKEN_ENV;
const WEBHOOK_SECRET = WEBHOOK_SECRET_ENV;

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

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: text };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default {
  async fetch(request, env) {
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
        "👋 CC Gen Bot (Test Only)\nအသုံးပြုပုံ:\n/gen 414720xxxxxxxxxx"
      );
    } else if (text.startsWith("/gen")) {
      const args = text.split(" ")[1];
      if (!args || !args.includes("x")) {
        await sendMessage(chatId, "❌ Format မမှန်ပါ။ ဥပမာ:\n/gen 414720xxxxxxxxxx");
      } else {
        let cards = [];
        for (let i = 0; i < 10; i++) cards.push(generateCC(args));
        await sendMessage(chatId, "✅ Generated Cards:\n\n" + cards.join("\n"));
      }
    }

    return new Response("OK", { status: 200 });
  },
};
