# TURN relay (Cloudflare)

Online games connect the players' browsers straight to each other. On strict
networks (office or school firewalls, some mobile carriers) that fails and the
traffic has to go through a relay, a TURN server. PeerJS brings a free shared
one (UDP only, best effort). Cloudflare's also relays over TCP and TLS on port
443, which gets through almost any firewall.

Cloudflare makes TURN credentials only for a request carrying a secret API
token, and a static site can't keep a secret. So a small Cloudflare Worker
(`worker.js`) keeps the token and hands each player credentials that expire
after 4 hours. The game asks it before each connection (`ICE_URL` in
`src/net.js`); if it doesn't answer within 3 seconds, the game connects with
PeerJS's servers as before.

**Cost:** Cloudflare charges $0.05 per GB relayed. Only the players who
can't connect directly use the relay, and a game sends little data (roughly
a few hundred MB per hour of play, so about a cent an hour). Fetching
credentials from the Worker is free (the free Workers plan allows 100,000
requests a day).

## Setting it up

1. **Make a TURN key.** In the Cloudflare dashboard open **Realtime** →
   **TURN Server** (https://dash.cloudflare.com/?to=/:account/calls) and
   create a key (any name, e.g. `petal-patrol`). Copy both the **Turn Token
   ID** and the **API Token**: the token is shown only once.
2. **Make the Worker.** **Workers & Pages** → **Create** → **Create Worker**,
   name it `petal-turn`, **Deploy** the hello-world, then **Edit code**:
   replace everything with `worker.js` from this folder and **Deploy** again.
3. **Give it the secrets.** In the Worker: **Settings** → **Variables and
   Secrets** → **Add**, type **Secret**: `TURN_KEY_ID` = the Turn Token ID,
   and `TURN_KEY_API_TOKEN` = the API Token. Deploy if it asks.
   If the game is served from anywhere other than `https://tmsvr.github.io`
   and `http://localhost:8765`, also add a plain variable `ALLOWED_ORIGINS`
   listing the sites, comma-separated.
4. **Check it.** Its address is on the Worker's page, like
   `https://petal-turn.<your-subdomain>.workers.dev`:

   ```bash
   curl -H "Origin: https://tmsvr.github.io" https://petal-turn.YOUR-SUBDOMAIN.workers.dev
   ```

   It should print `{"iceServers":[…]}` with `turn:` URLs, a `username` and a
   `credential`. Without the `Origin` header it answers `Forbidden`, as
   intended.
5. **Point the game at it.** Put that address in `ICE_URL` in `src/net.js`,
   commit and push.
6. **Check in the game.** Host a game with the browser console open: there
   should be no "No TURN relay" warning. To see whether a game actually goes
   through the relay, open `chrome://webrtc-internals` in Chrome during it:
   the selected candidate pair shows `relay` when it does.

## Keeping it safe

- The API token lives only in the Worker's secrets. Never put it in the repo.
- The Worker only answers pages from the allowed sites. That stops other
  websites from using your relay, but not someone determined with a script,
  so set a **billing notification** in the Cloudflare dashboard (Manage
  Account → Billing → notifications) to hear about unexpected use. If the
  token ever leaks, delete the TURN key and make a new one (steps 1 and 3).
