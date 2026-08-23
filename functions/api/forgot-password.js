export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request body" }, 400); }
  const { username } = body || {};
  if (!username) return json({ error: "Username required" }, 400);
  const SUPA = env.VITE_SUPABASE_URL;
  const ANON = env.VITE_SUPABASE_ANON_KEY;
  const SECRET = env.RESET_SECRET;
  const RESEND = env.RESEND_API_KEY;
  const FROM = env.RESET_FROM || "School Portal <onboarding@resend.dev>";
  if (!SUPA || !ANON || !SECRET || !RESEND) return json({ error: "Password reset is not configured on the server." }, 500);
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/reset_create`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_username: username, p_secret: SECRET }),
    });
    if (!r.ok) throw new Error(`reset_create ${r.status}`);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.email) return json({ ok: true }, 200);
    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [row.email], subject: "Your school portal reset code",
        text: `Hello ${row.name || ""},\n\nYour password reset code is: ${row.code}\n\nEnter it in the portal within 20 minutes to set a new password.\nIf you did not ask for this, ignore this message — your password has not changed.\n\nBanane Shantral Primary School\nSabuli, Wajir County`,
      }),
    });
    if (!mail.ok) { console.error("Resend error", mail.status, await mail.text().catch(() => "")); return json({ error: "Could not send the email. Ask the administrator to reset your password." }, 502); }
    return json({ ok: true }, 200);
  } catch (e) { console.error(e); return json({ error: "Reset request failed." }, 500); }
}
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed" }, 405);
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
