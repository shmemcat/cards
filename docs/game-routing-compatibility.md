# Game routing compatibility

The second server-separation slice adds game-specific URLs while the existing combined backend remains the sole owner of accounts and both games. These changes are local until released.

## URLs

- Hearts HTTP calls use `/api/hearts/`: games, lobbies, statistics, preferences, and leaderboards. The proxy removes `/api/hearts` before forwarding.
- Euchre HTTP calls use `/api/euchre/`: results, multiplayer history, and leaderboards. The proxy rewrites this to the combined app's current `/account/euchre/` routes.
- Shared accounts keep `/api/account/`. Legacy Hearts authentication URLs also remain available.
- Hearts socket namespaces `/game`, `/lobby`, and `/multi` use transport path `/hearts/socket.io`.
- Euchre's `/euchre` namespace uses transport path `/euchre/socket.io`.
- Both new transport paths still forward to the same backend `/socket.io/`. Namespaces and payloads stay unchanged.

The existing `/api/games/`, `/api/lobbies/`, `/api/stats`, `/api/preferences`, `/api/leaderboard`, `/api/account/euchre/`, and `/socket.io` URLs remain compatible. All HTTP aliases and transport paths still reach `cards-api:5000`; no service ownership has moved.

Nginx routes the game transport prefixes before game pages. Slashless transport requests are rewritten internally, preserving polling POST bodies without redirects. Queries, cookies, Origin, and WebSocket upgrade headers pass through. Both game paths and the legacy path retain the 120-second proxy read timeout. Shared account and game API responses remain uncached at the Cards gateway.

Equivalent aliases are configured in both Vite development proxies, the Cards Node preview/development server, and Hearts' standalone Nginx server. Standalone Euchre still reports an unavailable shared backend as JSON/503; it relies on the Cards gateway for production multiplayer. New transport URLs never fall through to its page HTML.

All Hearts clients use the same transport path. Their existing `forceNew` choices for lobby/multiplayer seat credentials are preserved. Socket.IO's Manager cache includes the transport path, so default multiplexing can reuse a Hearts connection without sharing a Manager with Euchre. The routing suite checks this using the actual installed client library.

## Release order

1. Release the Cards gateway aliases first, keeping every upstream on the current combined backend. Verify both old and new paths.
2. Release the Hearts and Euchre frontends that use the new URLs. The new Hearts standalone image includes its corresponding aliases.
3. Keep the combined server and legacy aliases running throughout later extraction and cutover. Do not point game aliases at independent runtimes until account adapters, database ownership, and the drain/recovery rehearsal are ready.

Publishing new game clients before gateway compatibility would break their connections. There is no automatic fallback from a game-specific path to `/socket.io`: such a fallback could reconnect to the wrong owner after services are separated. Gateway rollback must preserve the aliases while these clients are supported.

## Old-client support window

Support existing deployed clients, including Hearts `v5.0.2` and Euchre `v1.1.1`, throughout migration and for **at least 30 days after the final game cutover**. That clock has not started. Keep the old HTTP aliases and `/socket.io` on the combined runtime until that period has elapsed, all legacy games have finished, and legacy traffic has been absent for seven consecutive days. Removal requires an explicit reviewed cutover; this slice does not retire any client.

When a client is incompatible with its target server, the connection rejection contract is `CLIENT_RELOAD_REQUIRED`, with this visible message:

> This page has been updated. Please reload to reconnect.

The updated clients recognize this Socket.IO connection-error code, stop automatic retries, and show the message through their existing game error UI. Ordinary connection failures keep their existing reconnect behavior. The combined backend does not emit this rejection while old clients are supported.

The Socket.IO CONNECT_ERROR packet carries the message in `message` and the code in `data.code` (the browser receives `error.data.code`). A Python server can produce it with `socketio.exceptions.ConnectionRefusedError(message, {"code": "CLIENT_RELOAD_REQUIRED"})`. The disposable routing fixture verifies this wire format through the proxies.

At retirement, the legacy compatibility server must also use error events understood by older compiled clients, which cannot be taught a new connection-error code after release. Preserve that runtime through the support window and implement/rehearse its retirement response before disabling legacy connections. Never assign the same active table to both legacy and extracted runtimes.

## Verification

Run `npm run test:routing` in Cards with the sibling repositories and their development dependencies installed. It needs the Hearts Python environment, both frontend dependency installs, and a local Nginx executable. Set `HEARTS_PYTHON` or `NGINX_BIN` when they are not at their default locations/on PATH. The test does not download or install tools.

The suite starts a disposable combined backend with an in-memory SQLite database, a synthetic verified account, both Vite proxies, the Node preview, and Nginx using the checked-in production routing rules. Only loopback listeners are used. It does not load a production database or send email. Logs/configurations remain under ignored `.local/routing-check-*` folders for diagnosis.

Checks cover canonical and legacy URLs, query/body/cookie/Origin forwarding, account login and CSRF rejection, slashless polling GET/POST, WebSocket-only connections, polling upgrades, signed-in table reconnects, all three Hearts namespaces, game page routing, and separate Manager identities. Standalone Euchre's unavailable routes return JSON instead of page HTML.

`node scripts/check-deployment.mjs <gateway-origin>` additionally checks a fully built gateway's pages/assets, old host redirects, account session, game API aliases, and all three polling paths. This read-only deployment check does not create games or sign in.

Local verification on 2026-10-22 passed 406 Hearts frontend tests, 263 Euchre frontend tests, the routing integration suite, and both production frontend builds. Routing used native Nginx 1.30.6 on Windows against the disposable combined backend; no container image was built or production route changed by these checks.

Socket.IO documents [transport paths and Manager options](https://socket.io/docs/v4/client-options/) and [reverse-proxy upgrade requirements](https://socket.io/docs/v4/reverse-proxy/).
