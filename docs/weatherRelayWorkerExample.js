/**
 * weatherRelayWorkerExample.js
 * -----------------------------
 * A minimal, stateless proxy that lets HAZEL fetch weather from MET Norway
 * without violating either of two constraints browsers cannot get around on
 * their own:
 *
 *   1. Fetch's forbidden-header list means client-side JavaScript cannot set
 *      User-Agent, and MET Norway requires it for identification (see their
 *      own Locationforecast HOWTO: "Do not use this in production
 *      environments!" for direct browser calls).
 *   2. Whoever's contact details go in that header takes the consequences of
 *      that header's traffic. That must be the person who deployed this
 *      Worker, not whoever wrote the code they copied it from — see
 *      config.js for why HAZEL never ships a default.
 *
 * This file does ONE thing: take a lat/lon, add one identifying header,
 * forward the request, return the response unchanged. It stores nothing —
 * not the coordinates, not the forecast, not even in a log line beyond
 * whatever Cloudflare's platform-level access log already keeps for every
 * request to every Worker.
 *
 * Deploy this on Cloudflare's free tier (workers.cloudflare.com) — no
 * account beyond that is needed, no database, no server to maintain.
 *
 * Setup
 * -----
 * 1. Create a new Worker, paste this file in.
 * 2. Set two environment variables (Worker Settings -> Variables):
 *      APP_IDENTIFIER   e.g. "HAZEL/1.0"
 *      CONTACT          e.g. "your-real-email@example.org" or your site URL
 *    The Worker refuses to start without both — see the check below. This is
 *    deliberate: it is the one thing every deployer MUST personalise, per
 *    MET Norway's Terms of Service, and a silent fallback would mean copies
 *    of this file quietly sharing one identity.
 * 3. Point HAZEL's config.js weatherRelayUrl at your Worker's URL, e.g.
 *      https://your-worker-name.your-subdomain.workers.dev
 * 4. Restrict the Worker's route or CORS origin to your own domain once
 *    deployed, so other sites cannot ride on your identification and your
 *    Cloudflare quota. The permissive CORS header below is convenient for
 *    getting started; tighten it before relying on this in production.
 */

const MET_NO_BASE = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (!env.APP_IDENTIFIER || !env.CONTACT) {
      return new Response(
        "This relay is not configured. Set the APP_IDENTIFIER and CONTACT " +
          "environment variables before use — see the comment at the top of " +
          "this file, and MET Norway's Terms of Service " +
          "(https://api.met.no/doc/TermsOfService) for why this is required.",
        { status: 500, headers: corsHeaders() }
      );
    }

    const url = new URL(request.url);
    const lat = url.searchParams.get("lat");
    const lon = url.searchParams.get("lon");

    if (!lat || !lon) {
      return new Response('Missing "lat" or "lon" query parameter.', {
        status: 400,
        headers: corsHeaders(),
      });
    }

    // MET Norway ask for at most 4 decimal places — more defeats their
    // caching and risks throttling (Locationforecast HOWTO).
    const metNoUrl = `${MET_NO_BASE}?lat=${encodeURIComponent(
      Number(lat).toFixed(4)
    )}&lon=${encodeURIComponent(Number(lon).toFixed(4))}`;

    const upstreamResponse = await fetch(metNoUrl, {
      headers: {
        // The one line this whole file exists to add. A browser cannot set
        // this itself; that is the entire reason this relay exists.
        "User-Agent": `${env.APP_IDENTIFIER} (${env.CONTACT})`,
      },
      // MET Norway supports conditional requests (If-Modified-Since); a
      // future version of this relay could pass that through using
      // Cloudflare's own edge cache, cutting requests to MET Norway further
      // without HAZEL's own server storing anything. Left as a comment
      // rather than implemented, so this file stays easy to read start to
      // finish for anyone checking what it does before deploying it.
    });

    // Pass the response straight through — status, body, and the small set
    // of headers a browser actually needs to use it. Nothing is read,
    // logged, or transformed beyond that.
    const headers = corsHeaders();
    headers.set("Content-Type", upstreamResponse.headers.get("Content-Type") ?? "application/json");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  },
};

function corsHeaders() {
  return new Headers({
    // Tighten this to your own domain once deployed — see step 4 above.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
}
