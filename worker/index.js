// worker.js
// Telegram CC Gen (safe-mode)
// - /gen <template> or /gen <template>|MM|YY (or YYYY)
//   -> Generates 10 masked rows (x -> 'X') in a monospaced table and shows BIN info via binlist.net (cached).
// - /gen1 <template>|MM|YY -> single masked line
// - /validate_token <stripe_token> -> (optional) validate a Stripe token id (tok_...) using STRIPE_SECRET (sk_test_...)
// Env vars expected: TELEGRAM_TOKEN_ENV (required), STRIPE_SECRET (optional)

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
// binlist lookup with caching (24h). Returns null on failure.
// --------------------------
async function getBinInfo(bin6) {
  bin6 = String(bin6 || "").replace(/\D/g, "").slice(0, 6);
  if (bin6.length < 6) return null;

  const cache = caches.default;
  const cacheKey = new Request(`https://workers.internal/binlist/${bin6}`);

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        return await cached.json();
      } catch (e) {
        // fallthrough
      }
    }

    const resp = await fetch(`https://lookup.binlist.net/${bin6}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "CF-Telegram-CCGen-Safe/1.0 (+https://example.com)"
      }
    });

    if (!resp.ok) return null;
    const j = await resp.json();

    const info = {
      scheme: (j.scheme || j.brand || "unknown").toLowerCase(),
      type: (j.type || "unknown").toLowerCase(),
      bank: (j.bank && (j.bank.name || j.bank)) || "Unknown Bank",
      country: (j.country && (j.country.name || j.country)) || "Unknown",
      country_alpha2: (j.country && j.country.alpha2) || null,
      country_emoji: (j.country && j.country.alpha2) ? countryCodeToEmoji(j.country.alpha2) : ""
    };

    const respToCache = new Response(JSON.stringify(info), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }
    });
    await cache.put(cacheKey, respToCache.clone());
    return info;
  } catch (e) {
    return null;
  }
}

// --------------------------
// Safe "mask" helpers (DO NOT generate real full numbers)
// - fillTemplateMasked: replaces 'x'/'X' with 'X' (capital letter), leaves digits intact
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

// parse expiry inputs: month as '03', year as '31' or '2031'
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

// --------------------------
// Telegram helpers
// --------------------------
async function sendMessageHTML(chatId, htmlText, TELEGRAM_TOKEN) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// --------------------------
// Stripe token inspect (safe): call GET /v1/tokens/{id} to inspect token info (requires STRIPE_SECRET)
// --------------------------
async function inspectStripeToken(tokenId, STRIPE_SECRET) {
  if (!STRIPE_SECRET) return { error: "STRIPE_SECRET not configured" };
  const resp = await fetch(`https://api.stripe.com/v1/tokens/${encodeURIComponent(tokenId)}`, {
    method: "GET",
    headers: {
      "Authorization": "Basic " + btoa(STRIPE_SECRET + ":")
    }
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

// --------------------------
// Worker entry
// --------------------------
export default {
  async fetch(request, env) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN_ENV || "";
    const STRIPE_SECRET = env.STRIPE_SECRET || "";

    if (!TELEGRAM_TOKEN) {
      return new Response("Error: TELEGRAM_TOKEN_ENV not set in Worker environment.", { status: 500 });
    }

    if (request.method !== "POST") {
      return new Response("✅ CC Gen Worker (safe-mode) running", { status: 200 });
    }

    let update;
    try { update = await request.json(); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
    const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
    if (!message || !message.text) return new Response("No message", { status: 200 });

    const text = message.text.trim();
    const chatId = message.chat.id;

    // help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const help = [
        "👋 CC Gen Bot — SAFE MODE (no real card numbers generated)",
        "",
        "Commands:",
        "/gen <template> or /gen <template>|MM|YY  — generate 10 masked rows (x -> X) and BIN info",
        "/gen1 <template>|MM|YY — single masked line",
        "/validate_token <tok_...> — inspect a Stripe token id (requires STRIPE_SECRET=sk_test_...)",
        "",
        "Notes:",
        "- This worker WILL NOT produce usable card numbers. It prints masked placeholders to avoid misuse.",
        "- For real Stripe testing, create tokens client-side (Stripe Elements) and use validate_token to inspect the token."
      ].join("\n");
      await sendMessageHTML(chatId, `<pre>${escapeHtml(help)}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // gen1 -> single masked line
    if (text.startsWith("/gen1")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      if (!arg) {
        await sendMessageHTML(chatId, `<pre>❌ Usage: /gen1 <template>|MM|YY (example: /gen1 515462001764xxxx|03|31)</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // parse pipe parts
      let [templatePart, m, y] = arg.split("|").map(s => s.trim());
      const masked = fillTemplateMasked(templatePart);
      const { month, year } = normalizeExpiry(m, y);

      const line = `${masked} | ${month}/${year}`;
      await sendMessageHTML(chatId, `<pre>${escapeHtml(line)}</pre>`, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // gen -> 10 masked rows + BIN info
    if (text.startsWith("/gen")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] || "";
      if (!arg) {
        await sendMessageHTML(chatId, `<pre>❌ Usage: /gen <template>|MM|YY (example: /gen 515462001764xxxx|03|31)</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      // parse
      let [templatePart, m, y] = arg.split("|").map(s => s.trim());
      if (!templatePart) templatePart = arg;
      // basic validation: at least 6 chars (digits or x)
      const digitsOnly = (templatePart || "").replace(/[^0-9xX]/g, "");
      if (digitsOnly.length < 6) {
        await sendMessageHTML(chatId, `<pre>❌ Template invalid — include at least first 6 digits or x's. Example: 515462001764xxxx</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      const { month, year } = normalizeExpiry(m, y);

      // generate masked rows (do NOT generate real digits)
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const masked = fillTemplateMasked(templatePart);
        rows.push({ masked, expiry: `${month}/${year}` });
      }

      // table layout (monospaced)
      const col1 = 22, col2 = 10;
      const header = ["Card Number".padEnd(col1), "Expiry".padEnd(col2)].join(" ");
      const sep = "-".repeat(col1 + col2 + 1);
      const lines = [header, sep];
      for (const r of rows) {
        lines.push(r.masked.padEnd(col1) + " " + r.expiry.padEnd(col2));
      }
      const tableBlock = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;

      // BIN info: use the first 6 digits from template if available, else Unknown
      const firstSix = (templatePart.match(/[0-9]{6}/) || [null])[0] || (templatePart.replace(/[^0-9xX]/g,'').slice(0,6) || null);
      let binInfo = null;
      if (firstSix && firstSix.length === 6 && !firstSix.includes("x") && !firstSix.includes("X")) {
        binInfo = await getBinInfo(firstSix);
      } else if (firstSix && firstSix.length === 6 && /[xX]/.test(firstSix)) {
        // no numeric BIN available; set null
        binInfo = null;
      }

      let bank = "Unknown Bank", country = "Unknown", countryEmoji = "", scheme = "unknown", type = "unknown", binDisplay = firstSix || "N/A";
      if (binInfo) {
        bank = binInfo.bank || bank;
        country = binInfo.country || country;
        countryEmoji = binInfo.country_emoji || "";
        scheme = binInfo.scheme || scheme;
        type = binInfo.type || type;
      }

      const infoLines = [
        `<b>Bank:</b> ${escapeHtml(bank)}`,
        `<b>Country:</b> ${escapeHtml(country)} ${countryEmoji}`,
        `<b>BIN Info:</b> ${escapeHtml((scheme || "unknown").toUpperCase() + " - " + (type || "unknown").toUpperCase())}`,
        `<b>BIN:</b> ${escapeHtml(binDisplay)}`
      ].join("\n");

      const finalHtml = tableBlock + "\n" + `<pre>${infoLines}</pre>`;
      await sendMessageHTML(chatId, finalHtml, TELEGRAM_TOKEN);
      return new Response("OK", { status: 200 });
    }

    // validate_token <tok_...> -> safe inspect token info (no raw card numbers)
    if (text.startsWith("/validate_token")) {
      const parts = text.split(/\s+/);
      const tokenId = parts[1] || "";
      if (!tokenId) {
        await sendMessageHTML(chatId, `<pre>❌ Usage: /validate_token <tok_...>\nCreate a token client-side (Stripe Elements) then run this command with the token id.</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      if (!STRIPE_SECRET || !STRIPE_SECRET.startsWith("sk_test_")) {
        await sendMessageHTML(chatId, `<pre>⚠️ STRIPE_SECRET not set or not a test key. Set STRIPE_SECRET to a Stripe test key (sk_test_...)</pre>`, TELEGRAM_TOKEN);
        return new Response("OK", { status: 200 });
      }

      try {
        const res = await inspectStripeToken(tokenId, STRIPE_SECRET);
        if (res.status === 200 && res.body && res.body.id) {
          const card = res.body.card || {};
          const out = [
            `✅ Token inspected`,
            `Token: ${res.body.id}`,
            `Brand: ${card.brand || "unknown"}`,
            `Last4: ${card.last4 || "----"}`,
            `Funding: ${card.funding || "unknown"}`,
            `Country: ${card.country || "unknown"}`
          ].join("\n");
          await sendMessageHTML(chatId, `<pre>${escapeHtml(out)}</pre>`, TELEGRAM_TOKEN);
        } else {
          const err = res.body && res.body.error && res.body.error.message ? res.body.error.message : JSON.stringify(res.body || {});
          await sendMessageHTML(chatId, `<pre>❌ Stripe error: ${escapeHtml(err)}</pre>`, TELEGRAM_TOKEN);
        }
      } catch (e) {
        await sendMessageHTML(chatId, `<pre>⚠️ Request failed: ${escapeHtml(String(e))}</pre>`, TELEGRAM_TOKEN);
      }
      return new Response("OK", { status: 200 });
    }

    // fallback
    await sendMessageHTML(chatId, `<pre>Unknown command. Use /help</pre>`, TELEGRAM_TOKEN);
    return new Response("OK", { status: 200 });
  }
};
