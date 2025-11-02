// worker.js
// Telegram CC Gen Worker — SAFE TEST MODE (produces NON‑WORKING test numbers)
// - Fills templates to 12 digits (fills x/X with random digits).
// - Keeps expiry if provided, otherwise random.
// - CVV generated per config (random or XXX).
// - IMPORTANT: Generated PANs are intentionally made Luhn-invalid and tagged "INVALID-TEST".
// Env required: TELEGRAM_TOKEN_ENV

// ----------------- Configuration -----------------
const CVV_MODE = "random"; // "random" or "XXX"
const OUTPUT_DIGITS = 12; // fill template to this many digits (as requested)
const USE_MASKED_PLACEHOLDERS = false; // if true, 'x' => 'X' (masked); if false, 'x' => random digit
// ------------------------------------------------

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function randDigit() { return String(Math.floor(Math.random() * 10)); }
function randDigits(n) { let r=""; for(let i=0;i<n;i++) r+=randDigit(); return r; }
function genRandomCVV() { return String(Math.floor(Math.random() * 900) + 100); }

// Fill template: keep digits, treat x/X as placeholders to fill
function fillTemplateToLength(template, length) {
  template = String(template || "").replace(/\s+/g,"");
  // Build digits-only string by replacing non-digit, non-x with empty
  let out = "";
  for (const ch of template) {
    if (/\d/.test(ch)) out += ch;
    else if (ch === "x" || ch === "X") {
      out += USE_MASKED_PLACEHOLDERS ? "X" : randDigit();
    }
    // ignore other characters
    if (out.length >= length) break;
  }
  // If still short, pad with random digits
  while (out.length < length) {
    out += USE_MASKED_PLACEHOLDERS ? "X" : randDigit();
  }
  // If contains 'X' masking and USE_MASKED_PLACEHOLDERS true, keep those Xs.
  return out.slice(0, length);
}

// Luhn calculation helper (returns checksum digit expected)
// We will deliberately corrupt the final digit to make the number INVALID.
function luhnChecksumDigit(numStrWithoutCheckDigit) {
  // returns the check digit (0-9) that would make number valid
  const s = numStrWithoutCheckDigit;
  let sum = 0;
  // iterate from right to left, position index starting at 0
  for (let i = 0; i < s.length; i++) {
    let n = Number(s[s.length - 1 - i]);
    if (i % 2 === 0) { // double every second digit from right (since check digit not included here)
      n = n * 2;
      if (n > 9) n = n - 9;
    }
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check;
}

// Make intentionally-invalid by flipping last digit away from correct one (if last is numeric)
function makeIntentionallyInvalid(numStr) {
  // If contains 'X' (masked placeholders), we won't attempt Luhn — instead append " (INVALID-TEST)"
  if (numStr.includes("X")) return numStr;
  // If numeric:
  if (/^\d+$/.test(numStr)) {
    // Compute correct check digit for (all but last digit)
    const withoutLast = numStr.slice(0, -1);
    const correct = luhnChecksumDigit(withoutLast);
    // pick a digit != correct
    let d = Number(numStr.slice(-1));
    if (d === correct) {
      d = (d + 1) % 10; // change to different digit
    } else {
      // optionally set to (correct+1) %10 to ensure mismatch
      d = (correct + 1) % 10;
    }
    return withoutLast + String(d);
  } else {
    return numStr;
  }
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
  // allow digits and x/X and length at least 1
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

      // Build table: Card(12) | Expiry | CVV | Note
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
