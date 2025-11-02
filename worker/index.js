// worker.js
// Telegram CC Gen Worker (masked card numbers + RANDOM CVV placeholders)
// Env required: TELEGRAM_TOKEN_ENV

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Masked template: replace x/X with literal 'X' (keeps digits intact)
function fillTemplateMasked(template) {
  if (!template) return "";
  let out = "";
  for (const ch of String(template)) {
    if (ch === "x" || ch === "X") out += "X";
    else out += ch;
  }
  return out;
}

// Normalize expiry input (m may be "3" or "03", y may be "31" or "2031")
function normalizeExpiry(m, y) {
  let month = m;
  let year = y;
  if (!month || !/^\d{1,2}$/.test(month)) {
    month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  } else {
    month = String(Number(month)).padStart(2, "0");
  }

  if (!year || !/^\d{2,4}$/.test(year)) {
    const yy = String(Math.floor(Math.random() * 5) + 25); // 25..29
    year = "20" + yy;
  } else {
    if (year.length === 2) year = "20" + year;
    else year = String(Number(year));
  }

  return { month, year };
}

// Random 3-digit CVV generator (100..999)
function genRandomCVV() {
  return String(Math.floor(Math.random() * 900) + 100);
}

// Telegram send (HTML)
async function sendTelegramMessage(token, chatId, htmlText) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text: htmlText, parse_mode: "HTML", disable_web_page_preview: true };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// basic split for long messages
function splitLongText(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLen);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start) end = nl + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function isValidTemplate(t) {
  if (!t || typeof t !== "string") return false;
  const cleaned = t.replace(/[^0-9xX]/g, "");
  if (cleaned.length < 12) return false; // heuristic minimal length
  return /[0-9xX]/.test(cleaned);
}

export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV;
    if (!TELEGRAM_TOKEN) return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });

    if (request.method === "GET") return new Response("OK - CC Gen Worker (masked + random CVV)", { status: 200 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let update;
    try { update = await request.json(); } catch (e) { return new Response("Bad JSON", { status: 400 }); }

    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) return new Response("No message", { status: 200 });

    const text = message.text.trim();
    const chatId = message.chat && message.chat.id;
    if (!chatId) return new Response("No chat id", { status: 200 });

    async function replyHtml(html) {
      const parts = splitLongText(html);
      for (const p of parts) {
        await sendTelegramMessage(TELEGRAM_TOKEN, chatId, p);
      }
    }

    // /start or /help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot — MASKED + RANDOM CVV PLACEHOLDERS",
        "",
        "Commands:",
        "/gen <template> or /gen <template>|MM|YY  — generate 10 masked rows with Expiry + random CVV (100-999)",
        "/gen1 <template>|MM|YY                    — generate 1 masked line with random CVV",
        "",
        "Template example: 515462001764xxxx  (use x/X as placeholders)",
        "Expiry example: |03|31  (MM|YY) or |03|2031 (MM|YYYY)",
        "",
        "Note: This bot WILL NOT produce usable card numbers. CVV values shown are random placeholders and NOT real CVVs."
      ].join("\n");
      await replyHtml(`<pre>${escapeHtml(help)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen1 -> single masked line with random CVV
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts.slice(1).join(" ").trim();
      if (!arg) {
        await replyHtml(`<pre>Usage: /gen1 <template>|MM|YY  e.g. /gen1 515462001764xxxx|03|31</pre>`);
        return new Response("OK", { status: 200 });
      }

      const [templateRaw, m, y] = arg.split("|").map(s => s.trim());
      if (!isValidTemplate(templateRaw)) {
        await replyHtml(`<pre>Invalid template. Include at least 12 digits/x characters. Example: 515462001764xxxx</pre>`);
        return new Response("OK", { status: 200 });
      }

      const masked = fillTemplateMasked(templateRaw);
      const { month, year } = normalizeExpiry(m, y);
      const cvv = genRandomCVV();
      const line = `${masked} | ${month}/${year} | ${cvv}`;
      await replyHtml(`<pre>${escapeHtml(line)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen -> 10 masked rows with random CVV
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts.slice(1).join(" ").trim();
      if (!arg) {
        await replyHtml(`<pre>Usage: /gen <template>|MM|YY  e.g. /gen 515462001764xxxx|03|31</pre>`);
        return new Response("OK", { status: 200 });
      }

      let [templateRaw, m, y] = arg.split("|").map(s => s.trim());
      if (!templateRaw) templateRaw = arg;
      if (!isValidTemplate(templateRaw)) {
        await replyHtml(`<pre>Invalid template. Include at least 12 digits/x characters. Example: 515462001764xxxx</pre>`);
        return new Response("OK", { status: 200 });
      }

      const { month, year } = normalizeExpiry(m, y);
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const masked = fillTemplateMasked(templateRaw);
        rows.push({ num: masked, expiry: `${month}/${year}`, cvv: genRandomCVV() });
      }

      // Build monospaced table with three columns: Card Number | Expiry | CVV
      const col1 = 26; // card number width
      const col2 = 12; // expiry width
      const col3 = 6;  // cvv width
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2), "CVV".padEnd(col3)].join(" ");
      const sep = "-".repeat(col1 + col2 + col3 + 2);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.num.padEnd(col1) + " " + r.expiry.padEnd(col2) + " " + r.cvv.padEnd(col3));
      }

      await replyHtml(`<pre>${escapeHtml(lines.join("\n"))}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // fallback
    await replyHtml(`<pre>Unknown command. Use /help</pre>`);
    return new Response("OK", { status: 200 });
  }
};
