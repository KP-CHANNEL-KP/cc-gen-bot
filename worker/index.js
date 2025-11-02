// worker.js
// Telegram CC Gen Worker (expanded, safe-mode, deploy-ready)
// Env required: TELEGRAM_TOKEN_ENV
// Env optional: WEBHOOK_SECRET (if set, requests must include header "x-webhook-secret": "<value>")
// Commands:
//   /start, /help
//   /gen <template> or /gen <template>|MM|YY (or YYYY)   -> generate 10 masked cards (each line)
//   /gen1 <template>|MM|YY                              -> single masked line
//
// Notes:
// - This worker DOES NOT output unmasked live card numbers for safety.
// - Template may include digits and x/X placeholders. Example: 515462001764xxxx
// - If template does not contain 6 numeric digits at start, BIN lookup disabled (we removed BIN lookup per request).
// - Works as Telegram webhook receiver: configure your bot webhook to this worker URL.

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// replace 'x'/'X' in template with random digits (safe: still masked if template contains X letters)
function fillTemplateRandom(template) {
  if (!template) return "";
  let out = "";
  for (const ch of String(template)) {
    if (ch === "x" || ch === "X") {
      out += String(Math.floor(Math.random() * 10));
    } else {
      out += ch;
    }
  }
  return out;
}

// If you prefer to keep 'X' literal mask rather than real digits, use this:
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

// Telegram send (HTML)
async function sendTelegramMessage(token, chatId, htmlText) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
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

// Splits a very long message into smaller chunks (Telegram has message size limits)
function splitLongText(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLen);
    // try to break at newline
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start) end = nl + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

// Validate template: must have at least one 'x' or at least one non-x digit and length >= 12 (best-effort)
function isValidTemplate(t) {
  if (!t || typeof t !== "string") return false;
  const cleaned = t.replace(/[^0-9xX]/g, "");
  if (cleaned.length < 12) return false; // heuristic minimal length
  // allow templates that include digits and/or x
  return /[0-9xX]/.test(cleaned);
}

// Optional webhook secret guard
function checkWebhookSecret(request, expected) {
  if (!expected) return true; // not required
  const header = request.headers.get("x-webhook-secret") || request.headers.get("x-webhook-token");
  return header === expected;
}

export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV;
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET; // optional

    if (!TELEGRAM_TOKEN) {
      return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });
    }

    // Allow GET for quick health check
    if (request.method === "GET") {
      return new Response("OK - CC Gen Worker (safe)", { status: 200 });
    }

    // Only accept POST updates from Telegram (webhook)
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // If webhook secret is configured, verify header
    if (!checkWebhookSecret(request, WEBHOOK_SECRET)) {
      return new Response("Forbidden (webhook secret)", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) {
      // nothing to do
      return new Response("No message", { status: 200 });
    }

    const text = message.text.trim();
    const chatId = message.chat && (message.chat.id || (message.chat && message.chat.id));
    if (!chatId) return new Response("No chat id", { status: 200 });

    // helper to reply
    async function replyHtml(html) {
      const parts = splitLongText(html);
      for (const p of parts) {
        await sendTelegramMessage(TELEGRAM_TOKEN, chatId, p);
      }
    }

    // /start or /help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot — SAFE MODE",
        "",
        "Commands:",
        "/gen <template> or /gen <template>|MM|YY  — generate 10 masked rows",
        "/gen1 <template>|MM|YY                  — generate 1 masked line",
        "",
        "Template example: 515462001764xxxx  (use x/X as placeholders)",
        "Expiry example: |03|31  (MM|YY) or |03|2031 (MM|YYYY)",
        "",
        "Notes:",
        "- This bot DOES NOT output unmasked live card numbers.",
        "- For Stripe testing, use client-side tokenization and server-side token inspect."
      ].join("\n");
      await replyHtml(`<pre>${escapeHtml(help)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen1 -> single masked line
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts.slice(1).join(" ").trim(); // support if template contains spaces (unlikely)
      if (!arg) {
        await replyHtml(`<pre>Usage: /gen1 <template>|MM|YY  e.g. /gen1 515462001764xxxx|03|31</pre>`);
        return new Response("OK", { status: 200 });
      }

      const [templateRaw, m, y] = arg.split("|").map(s => s.trim());
      if (!isValidTemplate(templateRaw)) {
        await replyHtml(`<pre>Invalid template. Include at least 12 digits/x characters. Example: 515462001764xxxx</pre>`);
        return new Response("OK", { status: 200 });
      }

      // Choose whether to output masked X placeholders or random digits for x's:
      // Option A: masked placeholders (safe): use fillTemplateMasked
      // Option B: random digits (still not real validated numbers): use fillTemplateRandom
      const useMaskedPlaceholders = true; // set to false to fill with random digits instead

      const cardNum = useMaskedPlaceholders ? fillTemplateMasked(templateRaw) : fillTemplateRandom(templateRaw);
      const { month, year } = normalizeExpiry(m, y);
      const line = `${cardNum} | ${month}/${year}`;
      await replyHtml(`<pre>${escapeHtml(line)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen -> 10 masked rows table
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

      // choose masked placeholders or random digits for x's
      const useMaskedPlaceholders = true; // true => X characters; false => random digits in place of x

      const { month, year } = normalizeExpiry(m, y);

      // Generate 10 rows
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const val = useMaskedPlaceholders ? fillTemplateMasked(templateRaw) : fillTemplateRandom(templateRaw);
        rows.push({ num: val, expiry: `${month}/${year}` });
      }

      // Build monospaced table
      const col1 = 26; // card number column width
      const col2 = 10;
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2)].join(" ");
      const sep = "-".repeat(col1 + col2 + 1);
      const lines = [header, sep];
      for (const r of rows) lines.push(r.num.padEnd(col1) + " " + r.expiry.padEnd(col2));

      const tableHtml = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
      await replyHtml(tableHtml);
      return new Response("OK", { status: 200 });
    }

    // fallback
    await replyHtml(`<pre>Unknown command. Use /help</pre>`);
    return new Response("OK", { status: 200 });
  }
};
