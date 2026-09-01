export async function onRequest(context) {
  const { params, env } = context;
  const code = String(params.code || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const SUPA = env.VITE_SUPABASE_URL;
  const ANON = env.VITE_SUPABASE_ANON_KEY;
  if (!SUPA || !ANON || !code) return new Response("Not found", { status: 404 });

  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/logo_get`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_school_code: code }),
    });
    if (!r.ok) return new Response("Not found", { status: 404 });

    const logo = await r.json();
    if (typeof logo !== "string" || !logo.startsWith("data:image")) {
      return new Response("Not found", { status: 404 });
    }

    const [header, base64] = logo.split(",");
    const mime = header.match(/data:(.*?);base64/)?.[1] || "image/png";
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    return new Response(bytes, {
      headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return new Response("Not found", { status: 404 });
  }
}
