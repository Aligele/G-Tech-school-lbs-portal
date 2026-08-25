// Sends a password-reset code by email.
//
// Runs on Cloudflare's edge, never in the browser, so the Resend key and the
// database reset-secret are never exposed to visitors.
//
// Required Cloudflare Pages environment variables (Settings -> Environment
// variables, on the Pages project -- set under BOTH Production and Preview,
// since Cloudflare keeps them separate):
//   RESEND_API_KEY          from resend.com -> API Keys
//   RESET_SECRET             the value stored in app_config.reset_secret
//   VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY -- same as the rest of the app

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Bad request body" }, 400);
  }

  const { username } = body || {};
  if (!username) return json({ error: "Username required" }, 400);

  const SUPA = env.VITE_SUPABASE_URL;
  const ANON = env.VITE_SUPABASE_ANON_KEY;
  const SECRET = env.RESET_SECRET;
  const RESEND = env.RESEND_API_KEY;
  const FROM = env.RESET_FROM || "School Portal <onboarding@resend.dev>";

  // Name exactly which value is missing, rather than one message that could
  // mean any of four different problems. This is the only way to tell "the
  // dashboard silently failed to save a field" apart from "everything is
  // fine and the mail server itself is the issue" -- two very different
  // fixes that looked identical from the outside before this change.
  const missing = [];
  if (!SUPA) missing.push("VITE_SUPABASE_URL");
  if (!ANON) missing.push("VITE_SUPABASE_ANON_KEY");
  if (!SECRET) missing.push("RESET_SECRET");
  if (!RESEND) missing.push("RESEND_API_KEY");
  if (missing.length) {
    return json({ error: `Password reset is not configured on the server. Missing: ${missing.join(", ")}` }, 500);
  }

  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/reset_create`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_username: username, p_secret: SECRET }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json({ error: `Database rejected the request (reset_create ${r.status}): ${t.slice(0, 200)}` }, 502);
    }
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;

    // Always answer the same way once past this point, so nobody can use
    // this to discover which usernames exist or which addresses are
    // registered.
    if (!row || !row.email) return json({ ok: true }, 200);

    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [row.email],
        subject: "Your school portal reset code",
        text:
`Hello ${row.name || ""},

Your password reset code is: ${row.code}

Enter it in the portal within 20 minutes to set a new password.
If you did not ask for this, ignore this message -- your password has not changed.

Banane Shantral Primary School
Sabuli, Wajir County`,
      }),
    });

    if (!mail.ok) {
      const t = await mail.text().catch(() => "");
      console.error("Resend error", mail.status, t);
      return json({ error: `Resend rejected the email (${mail.status}): ${t.slice(0, 200)}` }, 502);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    console.error(e);
    return json({ error: `Reset request failed: ${String(e.message || e).slice(0, 200)}` }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed" }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
