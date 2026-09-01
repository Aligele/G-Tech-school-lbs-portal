export async function onRequest(context) {
  const { params, env } = context;
  const code = String(params.code || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const SUPA = env.VITE_SUPABASE_URL;
  const ANON = env.VITE_SUPABASE_ANON_KEY;

  let name = "School Portal";
  let icons = [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];

  if (SUPA && ANON && code) {
    try {
      const r = await fetch(`${SUPA}/rest/v1/rpc/schools_list`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        const rows = await r.json();
        const match = (rows || []).find((s) => String(s.code).toLowerCase() === code);
        if (match) name = match.name || name;
      }

      const logoRes = await fetch(`${SUPA}/rest/v1/rpc/logo_get`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_school_code: code }),
      });
      if (logoRes.ok) {
        const logo = await logoRes.json();
        if (typeof logo === "string" && logo.startsWith("data:image")) {
          icons = [
            { src: logo, sizes: "192x192", type: "image/png", purpose: "any" },
            { src: logo, sizes: "512x512", type: "image/png", purpose: "any" },
            { src: logo, sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: logo, sizes: "512x512", type: "image/png", purpose: "maskable" },
          ];
        }
      }
    } catch (e) {}
  }

  const manifest = {
    name,
    short_name: name.length > 20 ? name.split(" ")[0] : name,
    description: `The school portal for ${name} — pupils, marks, fees and attendance, one login away.`,
    start_url: `/?school=${code}`,
    scope: "/",
    display: "standalone",
    background_color: "#FBF7EC",
    theme_color: "#0E7A3C",
    orientation: "portrait-primary",
    icons,
  };

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
