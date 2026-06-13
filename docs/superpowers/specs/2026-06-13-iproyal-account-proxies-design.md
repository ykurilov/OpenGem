# IPRoyal Account Proxies Design

## Goal

OpenGem must let an admin manage a pool of IPRoyal residential proxies and bind exactly one proxy to each Google account. In strict mode, the admin must choose a proxy before starting Google OAuth, and OpenGem must use that proxy for the server-side OAuth callback and every later Google/Gemini request made on behalf of that account.

## Current State

The upstream OpenGem account model stores OAuth tokens, project metadata, tier data, cooldown state, and usage stats. It has no proxy fields. `nativeFetch` and `nativeFetchStream` use direct Node `http`/`https` requests, so token exchange, token refresh, project discovery, tier checks, and Gemini generation all leave from the server IP.

## Proxy Format

The admin can paste IPRoyal lines in this form:

```text
host:port:username:password
```

OpenGem normalizes each line to an internal HTTP proxy URL:

```text
http://username:password@host:port
```

The UI and APIs must never return the raw password. Public responses show only a masked display value, host, port, username, and detected session label when present.

## Data Model

Add a proxy pool:

- `id`: stable generated id.
- `name`: admin label, defaulting to host/session.
- `url`: encrypted normalized proxy URL.
- `host`, `port`, `username`, `session`: non-secret display/search metadata.
- `createdAt`, `updatedAt`.

Add `proxyId` to each account. When an account is loaded for server-side use, the database attaches the decrypted `proxyUrl` for internal calls only. Admin API responses sanitize accounts before JSON serialization so frontend code never receives OAuth tokens or raw proxy URLs.

## Strict OAuth Flow

The admin cannot start `/api/auth/login` without `proxyId`.

1. Admin selects a proxy in the Accounts page.
2. Browser opens `/api/auth/login?proxyId=<id>`.
3. OpenGem validates the proxy and stores `{ verifier, proxyId }` under the OAuth `state`.
4. Google consent opens in the user's browser.
5. `/api/auth/callback` loads the selected proxy and uses it for:
   - authorization code exchange,
   - user email lookup,
   - project discovery,
   - tier check.
6. The account is saved with `proxyId`.

The Google consent page itself is still loaded by the user's browser. This design guarantees strict server-side proxying from the first OpenGem-owned Google call onward.

## Runtime Request Flow

All account-specific outbound calls pass the account proxy:

- Gemini non-streaming generation.
- Gemini streaming generation.
- OAuth token refresh.
- Future account metadata checks that call Google APIs.

If an account has no `proxyId` or its proxy was deleted, request handling treats that account as unavailable and logs a redacted error. This prevents silent fallback to the server IP.

## Admin UI

The Accounts page gains a proxy management panel:

- textarea bulk import for IPRoyal lines,
- table of proxies with masked display and test/delete actions,
- selected proxy dropdown used by strict `Connect Account`,
- per-account proxy dropdown to replace an assigned proxy.

The account table shows the assigned proxy label or `No proxy`. The connect button is disabled until at least one proxy is selected.

## API Surface

Add admin-only routes:

- `GET /api/proxies`
- `POST /api/proxies`
- `POST /api/proxies/bulk`
- `PUT /api/proxies/:id`
- `DELETE /api/proxies/:id`
- `POST /api/proxies/:id/test`
- `PUT /api/accounts/:id/proxy`

All route errors redact proxy credentials.

## Verification

Required checks:

- `npm run build`
- API parsing/sanitization tests through TypeScript or focused Node scripts.
- Local Docker build/runtime smoke check.
- Browser or HTTP smoke check after deploy:
  - `/api/setup/status`
  - `/setup` or `/accounts`
  - container health.

