// ==========================
// CC Gen + Stripe Validator (Telegram Worker)
// Features:
//   - /start | /help
//   - /gen <6-digit> => 10 cards, each one message, inline "Copy" button
//   - /gen1 <6-digit> => 1 card, easy copy
//   - /validate <num> <mm> <yyyy> <cvc> => Stripe test tokenization
// Environment Variables:
//   TELEGRAM_TOKEN_ENV, STRIPE_SECRET (sk_test_...)
// ==========================

function generateCC(binFormat) {
  let cc = "";
  for (let c of binFormat) {
    if (c === "x" || c === "X") cc += Math.floor(Math.random() * 10);
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
  return String(Math.floor(Math.random() * 900) + 100); // 100..999
}

function generateFullCC(shortBin) {
  const digits = (shortBin || "").replace(/\D/g, "").slice(0, 6);
  const short = digits.padEnd(6, "0");
  const template = short + "xxxxxxxxxx"; // 16 digits
  const ccNumber = generateCC(template);
  const expiry = generateExpiry();
  const cvv = generateCVV();
  return { ccNumber, expiry, cvv };
}

async function sendMessageRaw(chatId, payload, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = Object.assign({ chat_id: chatId }, payload);
  return await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
    body: params.toString(),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";
    const STRIPE_SECRET = env.STRIPE_SECRET || "";

    if (!TELEGRAM_TOKEN) return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });

    if (request.method !== "POST") return new Response("✅ CC Gen Worker is running!", { status: 200 });

    let update;
    try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) return new Response("No message", { status: 200 });  

    const text = message.text.trim();
    const chatId = message.chat.id;

    // ----------------- /start | /help -----------------
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot (Test Only)",
        "",
        "Commands:",
        "/gen <6-digit>   — generate 10 cards, each with copy button",
        "/gen1 <6-digit>  — generate 1 card, easy copy",
        "/validate <num> <mm> <yyyy> <cvc>  — Stripe test tokenization",
        "",
        "⚠️ Use STRIPE_SECRET=test key only (sk_test_...)"
      ].join("\n");
      await sendMessageRaw(chatId, { text: `<pre>${help}</pre>`, parse_mode: "HTML" }, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // ----------------- /gen1 -----------------
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      if (!arg || arg.replace(/\D/g,"").length < 6) {
        await sendMessageRaw(chatId, { text: `<pre>❌ Format မမှန်ပါ၊ ဥပမာ: /gen1 414720</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        return new Response("OK",{status:200});
      }
      const { ccNumber, expiry, cvv } = generateFullCC(arg);
      await sendMessageRaw(chatId, { text: `<pre>${ccNumber} | ${expiry} | ${cvv}</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
      return new Response("OK",{status:200});
    }

    // ----------------- /gen -----------------
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      if (!arg || arg.replace(/\D/g,"").length < 6) {
        await sendMessageRaw(chatId, { text: `<pre>❌ Format မမှန်ပါ၊ ဥပမာ: /gen 414720</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        return new Response("OK",{status:200});
      }
      const digits = arg.replace(/\D/g,"");

      // generate 10 cards, each with inline "Copy" button
      for (let i=0;i<10;i++){
        const {ccNumber, expiry, cvv} = generateFullCC(digits);
        const cardText = `${ccNumber} | ${expiry} | ${cvv}`;
        const lineHtml = `<pre>${cardText}</pre>`;
        const replyMarkup = { inline_keyboard: [[{text:"Copy ➜", switch_inline_query_current_chat: cardText}]] };
        await sendMessageRaw(chatId, {text: lineHtml, parse_mode:"HTML", reply_markup: JSON.stringify(replyMarkup)}, TELEGRAM_TOKEN);
      }
      return new Response("OK",{status:200});
    }

    // ----------------- /validate -----------------
    if (text.startsWith("/validate")) {
      const parts = text.split(/\s+/);
      if(parts.length<5){
        await sendMessageRaw(chatId,{text:`<pre>Usage:\n/validate <number> <exp_month> <exp_year> <cvc>\nExample:\n/validate 4242424242424242 12 2026 123</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        return new Response("OK",{status:200});
      }
      const [_, cardNumber, exp_month, exp_year, cvc] = parts;

      if(!STRIPE_SECRET || !STRIPE_SECRET.startsWith("sk_test_")){
        await sendMessageRaw(chatId,{text:`<pre>⚠️ STRIPE_SECRET not set or not a test key (sk_test_...)</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        return new Response("OK",{status:200});
      }

      try{
        const res = await stripeTokenize(cardNumber, exp_month, exp_year, cvc, STRIPE_SECRET);
        if(res.status===200 && res.body?.id){
          const card=res.body.card||{};
          const out=`✅ Test token created
Token: ${res.body.id}
Brand: ${card.brand||"unknown"}
Last4: ${card.last4||"----"}
Funding: ${card.funding||"unknown"}
Country: ${card.country||"unknown"}`;
          await sendMessageRaw(chatId,{text:`<pre>${out}</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        }else{
          const errMsg=res.body?.error?.message||JSON.stringify(res.body);
          await sendMessageRaw(chatId,{text:`<pre>❌ Stripe error: ${errMsg}</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
        }
      }catch(e){
        await sendMessageRaw(chatId,{text:`<pre>⚠️ Request failed: ${String(e)}</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
      }
      return new Response("OK",{status:200});
    }

    // fallback
    await sendMessageRaw(chatId,{text:`<pre>Unknown command. Use /help</pre>`, parse_mode:"HTML"}, TELEGRAM_TOKEN);
    return new Response("OK",{status:200});
  }
};
