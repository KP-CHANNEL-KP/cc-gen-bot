// worker.js (updated)
// - better table spacing
// - getBinInfo returns diagnostics on failure so output shows why BIN was Unknown
// - masked output (no real card numbers)

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function countryCodeToEmoji(code) {
  if (!code) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(...code.toUpperCase().split("").map(c => A + c.charCodeAt(0) - 65));
}

// --------------------------
// getBinInfo with diagnostics
// returns { info: {...} | null, error: null | "HTTP 429" | "NETWORK" | "NOT_FOUND" | message }
// --------------------------
async function getBinInfo(bin6) {
  bin6 = String(bin6 || "").replace(/\D/g, "").slice(0, 6);
  if (bin6.length < 6) return { info: null, error: "INVALID_BIN" };

  const cache = caches.default;
  const cacheKey = new Request(`https://workers.internal/binlist/${bin6}`);

  try {
    // Try cache
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        const cachedJson = await cached.json();
        return { info: cachedJson, error: null };
      } catch (e) { /* fallthrough */ }
    }

    // Fetch binlist
    const resp = await fetch(`https://lookup.binlist.net/${bin6}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "CF-Telegram-CCGen/1.0 (+https://example.com)"
      }
    });

    if (!resp.ok) {
      // return HTTP status as error
      return { info: null, error: `HTTP_${resp.status}` };
    }

    const j = await resp.json();

    const info = {
      scheme: (j.scheme || j.brand || "unknown").toLowerCase(),
      type: (j.type || "unknown").toLowerCase(),
      bank: (j.bank && (j.bank.name || j.bank)) || "Unknown Bank",
      country: (j.country && (j.country.name || j.country)) || "Unknown",
      country_alpha2: (j.country && j.country.alpha2) || null,
      country_emoji: (j.country && j.country.alpha2) ? countryCodeToEmoji(j.country.alpha2) : ""
    };

    // Cache normalized info for 24h
    const respToCache = new Response(JSON.stringify(info), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }
    });
    await cache.put(cacheKey, respToCache.clone());

    return { info, error: null };
  } catch (e) {
    // network or unknown error
    return { info: null, error: "NETWORK_ERROR" };
  }
}

// --------------------------
// Safe mask helpers
// --------------------------
function fillTemplateMasked(template) {
  if (!template) return "";
  let out = "";
  for (let c of String(template)) {
    if (c === "x" || c === "X") out += "X";
    else out += c;
  }
  return out;
}

function normalizeExpiry(monthIn, yearIn) {
  let month = monthIn;
  let year = yearIn;

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

// Telegram helper
async function sendMessageHTML(chatId, htmlText, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: htmlText, parse_mode: "HTML", disable_web_page_preview: true };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Main worker
export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";
    if (!TELEGRAM_TOKEN) return new Response("Error: TELEGRAM_TOKEN_ENV not set.", { status: 500 });

    if (request.method !== "POST") return new Response("✅ Worker running", { status: 200 });

    let update;
    try { update = await request.json(); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) return new Response("No message", { status: 200 });

    const text = message.text.trim();
    const chatId = message.chat.id;

    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot — SAFE MODE",
        "",
        "Use /gen <template>|MM|YY  e.g. /gen 515462001764xxxx|03|31",
        "Will output 10 masked rows and BIN info (if binlist lookup works)."
      ].join("\n");
      await sendMessageHTML(chatId, `<pre>${escapeHtml(help)}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      if (!arg) {
        await sendMessageHTML(chatId, `<pre>❌ Usage: /gen <template>|MM|YY  e.g. /gen 515462001764xxxx|03|31</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      let [templatePart, m, y] = arg.split("|").map(s => s.trim());
      if (!templatePart) templatePart = arg;
      const digitsOnly = (templatePart || "").replace(/[^0-9xX]/g, "");
      if (digitsOnly.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Template invalid — include at least first 6 digits or x's. Example: 515462001764xxxx</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      const { month, year } = normalizeExpiry(m, y);

      // build masked rows
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const masked = fillTemplateMasked(templatePart);
        rows.push({ masked, expiry: `${month}/${year}` });
      }

      // build table with more spacing and blank line after table
      const col1 = 24, col2 = 10;
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2)].join(" ");
      const sep = "-".repeat(col1 + col2 + 1);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.masked.padEnd(col1) + " " + r.expiry.padEnd(col2));
      }
      const tableBlock = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;

      // BIN lookup (use numeric first-6 if provided)
      let firstSix = (templatePart.match(/[0-9]{6}/) || [null])[0] || null;
      // if no numeric 6 in template, but template starts with digits/x, try take first 6 chars (may include X) -> skip lookup
      if (!firstSix) {
        const maybe = templatePart.replace(/[^0-9xX]/g, '').slice(0,6);
        if (maybe && !/[xX]/.test(maybe)) firstSix = maybe;
      }

      let binInfoResult = null;
      if (firstSix) {
        binInfoResult = await getBinInfo(firstSix);
      } else {
        binInfoResult = { info: null, error: "NO_NUMERIC_BIN" };
      }

      let bank = "Unknown Bank", country = "Unknown", countryEmoji = "", scheme = "UNKNOWN", type = "UNKNOWN", binDisplay = firstSix || "N/A";
      let diag = "";
      if (binInfoResult && binInfoResult.info) {
        const info = binInfoResult.info;
        bank = info.bank || bank;
        country = info.country || country;
        countryEmoji = info.country_emoji || "";
        scheme = (info.scheme || scheme).toUpperCase();
        type = (info.type || type).toUpperCase();
      } else {
        // include diagnostic reason for why BIN info missing
        const err = binInfoResult ? binInfoResult.error : "UNKNOWN";
        if (err === "NO_NUMERIC_BIN") diag = "BIN lookup skipped (no numeric 6-digit found in template)";
        else if (err === "INVALID_BIN") diag = "Invalid BIN (need 6 digits)";
        else if (err && err.startsWith("HTTP_")) diag = `BIN lookup failed: ${err} (binlist returned HTTP status)`;
        else if (err === "NETWORK_ERROR") diag = "BIN lookup failed: network error (possible outbound blocked)";
        else diag = "BIN lookup not available";
      }

      // info block with diagnostic on separate pre block for clarity
      const infoLines = [
        `<b>Bank:</b> ${escapeHtml(bank)}`,
        `<b>Country:</b> ${escapeHtml(country)} ${countryEmoji}`,
        `<b>BIN Info:</b> ${escapeHtml(`${scheme} - ${type}`)}`,
        `<b>BIN:</b> ${escapeHtml(binDisplay)}`
      ].join("\n");

      const diagLine = diag ? `\n\n<i>Note:</i> ${escapeHtml(diag)}` : "";

      const finalHtml = tableBlock + "\n" + `<pre>${infoLines}</pre>` + diagLine;

      await sendMessageHTML(chatId, finalHtml, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // fallback
    await sendMessageHTML(chatId, `<pre>Unknown command. Use /help</pre>`, TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  }
};
