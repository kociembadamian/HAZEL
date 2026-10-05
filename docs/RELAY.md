# Deploying the weather relay

HAZEL can fetch live weather from [MET Norway](https://api.met.no/), whose
data is free to use — including commercially — under CC BY 4.0 / NLOD 2.0,
with attribution.

A browser cannot call their API directly in production. This is not a HAZEL
design choice — it is [MET Norway's own documented
position](https://api.met.no/doc/locationforecast/HowTO#dynamic-web-pages-and-cors):
client-side JavaScript cannot set the `User-Agent` header their Terms of
Service require for identification, so a direct call risks being throttled
or blacklisted, and they say plainly: *"Do not use this in production
environments!"*

The fix is a small stateless relay: one function that adds the one header a
browser cannot, and otherwise gets out of the way. `weatherRelayWorkerExample.js`
in this folder is a complete, working example — about 60 lines, no
database, nothing stored.

## Why you must deploy your own

The relay's identifying header carries **your** contact details, because per
MET Norway's terms, whoever is named in that header is responsible for the
traffic it produces. If everyone who forked HAZEL shared one deployer's
identity, one misbehaving installation could get every HAZEL user blocked —
which is exactly the failure mode this architecture avoids. HAZEL therefore
ships with `config.js`'s `weatherRelayUrl` empty, and the Weather step works
in manual-entry mode until you deploy your own relay and set it.

## Steps

1. **Create a Cloudflare account** (free tier is enough — [dash.cloudflare.com](https://dash.cloudflare.com)).
2. **Create a new Worker**: Workers & Pages → Create → "Hello World" template,
   then replace its contents with `weatherRelayWorkerExample.js`.
3. **Set two environment variables** (Worker → Settings → Variables):
   - `APP_IDENTIFIER` — e.g. `HAZEL/1.0`
   - `CONTACT` — a real, working contact: an email address or your site's URL.
     Per MET Norway's terms: *"Do not fake this or you are likely to be
     permanently blacklisted."*
4. **Deploy.** Cloudflare gives you a URL like
   `https://hazel-weather-relay.your-name.workers.dev`.
5. **Point HAZEL at it** — in `config.js`:
   ```js
   weatherRelayUrl: "https://hazel-weather-relay.your-name.workers.dev",
   ```
6. **Tighten CORS once it works.** The example ships with
   `Access-Control-Allow-Origin: *` so it is easy to test from anywhere while
   you set it up. Before relying on it, change that to your own domain in
   `corsHeaders()` — otherwise any other website could call your relay and
   spend your identity's goodwill with MET Norway.

## What this relay does and does not do

**Does:** add one header, forward one request, return the response.

**Does not:** store coordinates, cache forecasts, log requests beyond
whatever Cloudflare's platform keeps for every Worker, or know who is asking.

If you would rather not run even this much infrastructure, that's a
legitimate choice — leave `weatherRelayUrl` empty and HAZEL's Weather step
runs entirely on manual entry, which needs no network at all.
