// worker.js (fixed fillTemplateToLength -> always produce OUTPUT_DIGITS length)
// Telegram CC Gen Worker — SAFE TEST MODE (NON-WORKING numbers)
// Env required: TELEGRAM_TOKEN_ENV

// ----------------- Configuration -----------------
const CVV_MODE = "random"; // "random" or "XXX"
const OUTPUT_DIGITS = 12; // ensure output digit count
const USE_MASKED_PLACEHOLDERS = false; // if true, 'x' => 'X' (masked); if false, 'x' => random digit
// ------------------------------------------------

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function randDigit() { return String(Math.floor(Math.random() * 10)); }
function randDigits(n) { let r=""; for(let i=0;i<n;i++) r+=randDigit(); return r; }
function genRandomCVV() { return String(Math.floor(Math.random() * 900) + 100); }

// ======= NEW: robust fillTemplateToLength =======
// Keep digits from template in order; treat x/X as placeholders to fill with digits (or 'X' if masked).
// Guarantee returned string length === length by padding with random digits if needed.
// Non-digit characters other than x/X are ignored.
function fillTemplateToLength(template, length) {
  template = String(template || "");
  let outArr = [];

  // first pass: take characters from template and map digits/x to output
  for (let i = 0; i < template.length && outArr.length < length; i++) {
    const ch = template[i];
    if (/\d/.test(ch)) {
      outArr.push(ch);
    } else if (ch === "x" || ch === "X") {
      if (USE_MASKED_PLACEHOLDERS) outArr.push("X");
      else outArr.push(randDigit());
    } else {
      // ignore any other char (spaces, dashes, pipes)
    }
  }

  // second pass: if still short, try to reuse trailing x placeholders from template positions beyond length
  // (not strictly necessary) — instead just pad with random digits or masked 'X'
  while (outArr.length < length) {
    outArr.push(USE_MASKED_PLACEHOLDERS ? "X" : randDigit());
  }

  // if for some reason it's longer, slice to requested length
  return outArr.slice(0, length).join("");
}

// Luhn checksum helper (compute check digit for numeric string without check digit)
function luhnChecksumDigit(numStrWithoutCheckDigit) {
  const s = numStrWithoutCheckDigit;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let n = Number(s[s.length - 1 - i]);
    if (i % 2 === 0) {
      n = n * 2;
      if (n > 9) n = n - 9;
    }
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check;
}

// Make intentionally-invalid by changing last digit away from correct one (only if fully numeric)
function makeIntentionallyInvalid(numStr) {
  if (numStr.includes("X")) return numStr; // masked -> leave as-is
  if (!/^\d+$/.test(numStr)) return numStr; // non-numeric, leave
  if (numStr.length < 2) return numStr;
  const withoutLast = numStr.slice(0, -1);
  const correct = luhnChecksumDigit(withoutLast);
  // pick a different digit
  let newLast = (correct + 1) % 10;
  // ensure not equal to existing last digit
  if (Number(numStr.slice(-1)) === newLast) newLast = (newLast + 1) % 10;
  return withoutLast + String(newLast);
}

function normalizeExpiry(m, y) {
  let month = m;
  let year = y;
  if (!month || !/^\d{1,2}$/.test(month)) month = String(Math.floor(Math.random()*12)+1).padStart(2,"0");
  else month = String(Number(month)).padStart(2,"0");
  if (!year || !/^\d{2,4}$/.test(year)) {
    const yy = String(Math.floor(Math.random()*5)+25);
    year = "20" + yy;
  } else {
    if (year.length === 2) year = "20" + year;
    else year = String(Number(year));
  }
  return { month, year };
}

async function sendTelegramMessage(token, chatId, htmlText) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text: htmlText, parse_mode: "HTML", disable_web_page_preview: true };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

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
  return cleaned.length >= 1;
}

export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV;
    if (!TELEGRAM_TOKEN) return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });

    if (request.method === "GET") return new Response("OK - CC Gen Worker (SAFE TEST MODE)", { status: 200 });
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
      for (const p of parts) await sendTelegramMessage(TELEGRAM_TOKEN, chatId, p);
    }

    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot — SAFE TEST MODE (NON‑WORKING numbers)",
        "",
        "Usage:",
        "/gen <template> or /gen <template>|MM|YY  — fill template to 12 digits, generate 10 rows",
        "/gen1 <template>|MM|YY                     — single row",
        "",
        "Template: digits and x/X placeholders allowed. Example: 515462001764xxxx or 515462xxxxx",
        "If you provide expiry it will be used; otherwise random expiry is generated.",
        "CVV: configured server-side (random or XXX).",
        "",
        "IMPORTANT: Numbers produced are intentionally INVALID and marked 'INVALID-TEST'. Do NOT use for transactions."
      ].join("\n");
      await replyHtml(`<pre>${escapeHtml(help)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen1
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts.slice(1).join(" ").trim();
      if (!arg) {
        await replyHtml(`<pre>Usage: /gen1 <template>|MM|YY  e.g. /gen1 515462001764xxxx|03|31</pre>`);
        return new Response("OK", { status: 200 });
      }
      let [templateRaw, m, y] = arg.split("|").map(s => s.trim());
      if (!isValidTemplate(templateRaw)) {
        await replyHtml(`<pre>Invalid template. Use digits and x/X placeholders. Example: 515462001764xxxx</pre>`);
        return new Response("OK", { status: 200 });
      }

      const filled12 = fillTemplateToLength(templateRaw, OUTPUT_DIGITS);
      const invalid = makeIntentionallyInvalid(filled12);
      const { month, year } = normalizeExpiry(m, y);
      const cvv = CVV_MODE === "random" ? genRandomCVV() : "XXX";
      const line = `${invalid} | ${month}/${year} | ${cvv}  (INVALID-TEST)`;
      await replyHtml(`<pre>${escapeHtml(line)}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // /gen -> 10 rows
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
        await replyHtml(`<pre>Invalid template. Use digits and x/X placeholders. Example: 515462001764xxxx</pre>`);
        return new Response("OK", { status: 200 });
      }

      const { month, year } = normalizeExpiry(m, y);
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const filled12 = fillTemplateToLength(templateRaw, OUTPUT_DIGITS);
        const invalid = makeIntentionallyInvalid(filled12);
        const cvv = CVV_MODE === "random" ? genRandomCVV() : "XXX";
        rows.push({ num: invalid, expiry: `${month}/${year}`, cvv });
      }

      // Build table: Card(12) | Expiry | CVV
      const col1 = 20, col2 = 10, col3 = 6;
      const header = ["Card(12)".padEnd(col1), "Expiry".padEnd(col2), "CVV".padEnd(col3)].join(" ");
      const sep = "-".repeat(col1 + col2 + col3 + 2);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.num.padEnd(col1) + " " + r.expiry.padEnd(col2) + " " + r.cvv.padEnd(col3));
      }
      lines.push("");
      lines.push("Note: All numbers are NON‑WORKING (INVALID-TEST). Do NOT use for transactions.");
      await replyHtml(`<pre>${escapeHtml(lines.join("\n"))}</pre>`);
      return new Response("OK", { status: 200 });
    }

    // fallback
    await replyHtml(`<pre>Unknown command. Use /help</pre>`);
    return new Response("OK", { status: 200 });
  }
};
