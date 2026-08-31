export async function onRequest(context) {
  const { params, env } = context;
  const code = String(params.code || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const SUPA = env.VITE_SUPABASE_URL;
  const ANON = env.VITE_SUPABASE_ANON_KEY;
  if (!SUPA || !ANON || !code) {
    return Response.redirect(new URL("/", context.request.url), 302);
  }

  let name = "School Portal";
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/schools_list`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (r.ok) {
      const rows = await r.json();
      const match = (rows || []).find((s) => String(s.code).toLowerCase() === code);
      if (!match) return Response.redirect(new URL("/", context.request.url), 302);
      name = match.name || name;
    }
  } catch (e) {
    // if the lookup fails, still let the visitor through to the app itself
  }

  const safe = name.replace(/</g, "&lt;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safe}</title>
<meta name="description" content="Official portal for ${safe}. Pupils and parents check exam results, class position, attendance and school fees.">
<link rel="manifest" href="/manifest/${code}">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta http-equiv="refresh" content="0; url=/?school=${code}">
<script>window.location.replace("/?school=${code}");</script>
</head>
<body>
  <p>Opening ${safe}… <a href="/?school=${code}">Tap here if it does not open automatically.</a></p>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}
