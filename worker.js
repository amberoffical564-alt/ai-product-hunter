// AI Product Hunter backend: Cloudflare Worker -> Amazon Creators API.
// Secrets (set in Cloudflare, never in the frontend): CREDENTIAL_ID, CREDENTIAL_SECRET
// Plain variables: PARTNER_TAG (e.g. yourtag-20), ALLOWED_ORIGIN (e.g. https://yourname.github.io)
// Optional: CREDENTIAL_VERSION (default "3.1"), TOKEN_URL (default Login with Amazon, NA)
let cached = null, expiresAt = 0;

async function getToken(env) {
  if (cached && Date.now() < expiresAt) return cached;
  const r = await fetch(env.TOKEN_URL || "https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.CREDENTIAL_ID,
      client_secret: env.CREDENTIAL_SECRET,
      scope: "creatorsapi::default",
    }),
  });
  if (!r.ok) throw new Error("Amazon auth failed (" + r.status + ")");
  const d = await r.json();
  cached = d.access_token;
  expiresAt = Date.now() + ((d.expires_in || 3600) - 120) * 1000;
  return cached;
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "", "Vary": "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, cors);

    const url = new URL(req.url);
    const need = ["CREDENTIAL_ID", "CREDENTIAL_SECRET", "PARTNER_TAG"].filter((k) => !env[k]);
    if (url.pathname === "/health") return json({ configured: need.length === 0, missing: need }, 200, cors);
    if (url.pathname !== "/search") return json({ error: "Not found" }, 404, cors);
    if (need.length) return json({ error: "Backend secrets missing: " + need.join(", ") }, 500, cors);

    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!q) return json({ error: "Missing search term" }, 400, cors);

    const body = {
      keywords: q,
      partnerTag: env.PARTNER_TAG,
      marketplace: "www.amazon.com",
      itemCount: 10,
      resources: ["itemInfo.title", "images.primary.medium", "offersV2.listings.price",
                  "browseNodeInfo.browseNodes", "browseNodeInfo.websiteSalesRank"],
    };
    // Amazon prices are in cents.
    const minP = Math.round(parseFloat(url.searchParams.get("minPrice")) * 100);
    const maxP = Math.round(parseFloat(url.searchParams.get("maxPrice")) * 100);
    const minR = Math.floor(parseFloat(url.searchParams.get("minRating")));
    if (minP > 0) body.minPrice = minP;
    if (maxP > 0) body.maxPrice = maxP;
    if (minR > 0) body.minReviewsRating = Math.min(minR, 4);

    try {
      const token = await getToken(env);
      const v = env.CREDENTIAL_VERSION || "3.1";
      const auth = "Bearer " + token + (v.startsWith("2") ? ", Version " + v : "");
      const r = await fetch("https://creatorsapi.amazon/catalog/v1/searchItems", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", "x-marketplace": "www.amazon.com" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: "Amazon API error " + r.status }, 502, cors);
      const products = (d.searchResult?.items || []).map((i) => {
        const m = i.offersV2?.listings?.[0]?.price?.money;
        const n = i.browseNodeInfo?.browseNodes?.[0];
        return {
          asin: i.asin,
          name: i.itemInfo?.title?.displayValue ?? null,
          price: m?.amount ?? null,
          currency: m?.currency ?? null,
          rating: null,   // not returned by Creators API search resources
          reviews: null,  // not returned either; never invent these
          category: n?.displayName || n?.contextFreeName || null,
          imageUrl: i.images?.primary?.medium?.url ?? null,
          productUrl: i.detailPageURL ?? null, // includes your affiliate tag
          salesRank: i.browseNodeInfo?.websiteSalesRank?.salesRank ?? null,
        };
      });
      return json({ products }, 200, cors);
    } catch (e) {
      return json({ error: "Backend error: " + e.message }, 502, cors);
    }
  },
};
