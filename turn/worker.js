// Cloudflare Worker that hands the game short-lived TURN credentials.
//
// Two players' browsers usually connect straight to each other. On strict
// networks (office or school firewalls, some mobile carriers) they can't, and
// the game traffic has to be relayed through a TURN server. Cloudflare's TURN
// needs a secret API token to make credentials, and a static site can't keep a
// secret, so this Worker keeps it and gives each player credentials that
// expire after a few hours. Deploying it is described in turn/README.md.
//
// Secrets (Worker → Settings → Variables and Secrets):
//   TURN_KEY_ID         the TURN key's ID
//   TURN_KEY_API_TOKEN  the TURN key's API token
// Optional variable:
//   ALLOWED_ORIGINS     comma-separated sites allowed to ask (default below)
const DEFAULT_ORIGINS = 'https://tmsvr.github.io,http://localhost:8765';
const TTL = 4 * 3600; // longer than any game; a new game fetches fresh ones

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim());
    if (!allowed.includes(origin)) return new Response('Forbidden', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!res.ok) return new Response('TURN credentials unavailable', { status: 502, headers: cors });
    const { iceServers } = await res.json();
    // Browsers block port 53, so a URL on it would only time out.
    const clean = iceServers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
    return Response.json({ iceServers: clean }, { headers: cors });
  },
};
