// Talkweave — Cloudflare Worker backend
// This Worker is the ONLY thing that ever talks to the real Google Cloud
// Translation API. The Android app / website never sees the real key —
// it only calls this Worker's URL.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

      if (url.pathname === "/translate" && request.method === "POST") {
        return withCors(await handleTranslate(request, env));
      }

      if (url.pathname === "/kofi-webhook" && request.method === "POST") {
        return await handleKofiWebhook(request, env);
      }

      if (url.pathname === "/admin/stats" && request.method === "GET") {
        return withCors(await handleAdminStats(request, env));
      }

      if (url.pathname === "/admin/config" && request.method === "POST") {
        return withCors(await handleAdminConfig(request, env));
      }

      return withCors(json({ error: "Not found" }, 404));
    } catch (err) {
      return withCors(json({ error: "Server error" }, 500));
    }
  },
};

function withCors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-App-Secret");
  return new Response(res.body, { status: res.status, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthStr() {
  return new Date().toISOString().slice(0, 7);
}

async function kvGetNumber(env, key) {
  const v = await env.USAGE.get(key);
  return v ? parseInt(v, 10) : 0;
}

async function kvIncrement(env, key, amount, expirationTtl) {
  const current = await kvGetNumber(env, key);
  const next = current + amount;
  await env.USAGE.put(key, String(next), expirationTtl ? { expirationTtl } : undefined);
  return next;
}

async function isServiceEnabled(env) {
  const flag = await env.USAGE.get("config:service_enabled");
  if (flag === null) return true;
  return flag === "true";
}

async function isPremium(env, email) {
  if (!email) return false;
  const expiry = await env.USAGE.get(`premium:${email.toLowerCase().trim()}`);
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

async function handleTranslate(request, env) {
  if (!(await isServiceEnabled(env))) {
    return json({ error: "Translation service is temporarily unavailable. Please try later." }, 503);
  }

  if (request.headers.get("X-App-Secret") !== env.APP_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const text = (body.text || "").toString();
  const source = (body.source || "auto").toString();
  const target = (body.target || "en").toString();
  const deviceId = (body.deviceId || "unknown").toString().slice(0, 64);
  const email = body.email ? body.email.toString().slice(0, 128) : "";

  if (!text.trim()) return json({ error: "No text provided" }, 400);
  if (text.length > 5000) return json({ error: "Text too long (max 5000 characters per request)" }, 400);

  const premium = await isPremium(env, email);

  const FREE_LIMIT = parseInt(env.FREE_DAILY_CHAR_LIMIT || "2000", 10);
  const PREMIUM_LIMIT = parseInt(env.PREMIUM_DAILY_CHAR_LIMIT || "15000", 10);
  const MONTHLY_BUDGET = parseInt(env.MONTHLY_BUDGET_CHARS || "450000", 10);

  const day = todayStr();
  const month = monthStr();

  const globalMonthUsage = await kvGetNumber(env, `usage:global:${month}`);
  if (globalMonthUsage + text.length > MONTHLY_BUDGET) {
    return json({ error: "Monthly translation budget reached. Please try again next month, or contact support." }, 429);
  }

  const userKey = premium ? `usage:premium:${email.toLowerCase()}:${day}` : `usage:free:${deviceId}:${day}`;
  const userLimit = premium ? PREMIUM_LIMIT : FREE_LIMIT;
  const userUsage = await kvGetNumber(env, userKey);

  if (userUsage + text.length > userLimit) {
    return json(
      {
        error: premium
          ? "Daily usage limit reached — this resets tomorrow."
          : "Free daily limit reached. Upgrade to Premium for a much higher limit, or try again tomorrow.",
      },
      429
    );
  }

  const apiUrl = `https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_API_KEY}`;
  const googleRes = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: source === "auto" ? undefined : source,
      target,
      format: "text",
    }),
  });

  if (!googleRes.ok) {
    return json({ error: "Translation provider error. Please try again." }, 502);
  }

  const data = await googleRes.json();
  const translated = data?.data?.translations?.[0]?.translatedText || "";

  await kvIncrement(env, userKey, text.length, 60 * 60 * 24 * 2);
  await kvIncrement(env, `usage:global:${month}`, text.length, 60 * 60 * 24 * 40);

  return json({ translatedText: translated });
}

async function handleKofiWebhook(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid webhook payload" }, 400);
  }

  const raw = form.get("data");
  if (!raw) return json({ error: "Missing data" }, 400);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }

  if (payload.verification_token !== env.KOFI_VERIFICATION_TOKEN) {
    return json({ error: "Invalid verification token" }, 403);
  }

  const email = (payload.email || "").toLowerCase().trim();
  if (!email) return json({ error: "No email in payload" }, 400);

  const expiry = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
  await env.USAGE.put(`premium:${email}`, expiry);

  return json({ ok: true });
}

async function handleAdminStats(request, env) {
  if (request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  const month = monthStr();
  const globalUsage = await kvGetNumber(env, `usage:global:${month}`);
  const budget = parseInt(env.MONTHLY_BUDGET_CHARS || "450000", 10);
  const estimatedCostUsd = Math.max(0, globalUsage - 500000) / 1000000 * 20;
  return json({
    month,
    charactersUsedThisMonth: globalUsage,
    monthlyBudgetChars: budget,
    percentOfBudgetUsed: ((globalUsage / budget) * 100).toFixed(1) + "%",
    estimatedCostUsdIfOverFreeTier: estimatedCostUsd.toFixed(2),
    serviceEnabled: await isServiceEnabled(env),
  });
}

async function handleAdminConfig(request, env) {
  if (request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid body" }, 400);
  }
  if (typeof body.enabled === "boolean") {
    await env.USAGE.put("config:service_enabled", body.enabled ? "true" : "false");
  }
  return json({ ok: true, serviceEnabled: await isServiceEnabled(env) });
}
