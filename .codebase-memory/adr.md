# OpenGem Architecture Notes

## Strict per-account residential proxy flow

OpenGem is deployed at `/opt/opengem` on `72.56.83.46` and uses branch `codex/iproyal-account-proxies` in `ykurilov/OpenGem`.

Each Google account must have an assigned residential proxy. Direct server-IP fallback is intentionally disabled for Google/Gemini/Code Assist traffic.

Key files:
- `src/services/proxy.ts` parses, masks, and names imported proxies.
- `src/services/sqliteDb.ts` stores encrypted account proxy data and account `proxyId` bindings.
- `src/services/account-manager.ts` enforces proxy presence in `ensureFreshToken()` and refreshes OAuth tokens through `account.proxyUrl`.
- `src/controllers/chat.ts` uses `getAccountProxyUrl()` for non-stream and stream Gemini requests. If no proxy is assigned, the account is skipped and direct fallback is disabled.
- `src/services/antigravity.ts` sends OAuth token exchange, token refresh, userinfo, Code Assist discovery/onboarding/tier checks through `proxyUrl`.
- `src/services/http.ts` is the shared HTTP transport. It blocks direct egress to Google-owned hosts (`google.com`, `googleapis.com`, `googleusercontent.com`, `gstatic.com`) when `proxyUrl` is absent.

Runtime verification after the strict guard:
- Direct container egress IP: `72.56.83.46`.
- Proxied account egress IP observed via IPRoyal: `77.249.104.95`.
- Direct Google call without `proxyUrl` is blocked before network: `Direct Google egress is disabled ... account proxy is required.`
- Google call with account `proxyUrl` succeeds with HTTP 302.

## Account Safety Mode

Account Safety Mode reduces suspicious Google account patterns before requests leave OpenGem.

Key files:
- `src/services/account-safety.ts` owns safety config, per-account in-flight counters, request spacing, hourly/daily caps from existing request logs, and account/proxy health checks.
- `src/controllers/chat.ts` calls `beginAccountSafetyRequest()` and `finishAccountSafetyRequest()` around token refresh plus Gemini non-stream/stream requests.
- `src/index.ts` exposes admin-only safety endpoints:
  - `GET /api/safety/status`
  - `POST /api/safety/accounts/:email/health`
- `.env.example` documents safety knobs.

Default safety settings:
- `ACCOUNT_SAFETY_MODE=true`
- `ACCOUNT_SAFETY_MAX_CONCURRENT_PER_ACCOUNT=1`
- `ACCOUNT_SAFETY_MIN_SPACING_MS=2000`
- `ACCOUNT_SAFETY_MAX_REQUESTS_PER_HOUR=60`
- `ACCOUNT_SAFETY_MAX_REQUESTS_PER_DAY=300`
- `ACCOUNT_SAFETY_LOG_SCAN_LIMIT=5000`

Health check behavior:
- direct Google request without proxy must be blocked by `src/services/http.ts`;
- direct egress IP is checked through non-Google ipify;
- proxied egress IP is checked through account `proxyUrl`;
- Google through account `proxyUrl` must return a 2xx/3xx status.

## Proxied OAuth browser

The Accounts UI uses a server-side Chromium auth browser so Google OAuth itself runs through the selected residential proxy.

Key files:
- `src/services/auth-browser.ts` starts temporary Playwright Chromium sessions.
- `app/opengem-console.jsx` renders the screenshot-based remote browser viewport and input controls.
- `src/index.ts` exposes `/api/auth-browser/sessions` endpoints and `/api/auth/callback` handling.

Important implementation details:
- Chromium uses `playwright-core`, system Chromium, and Xvfb in Docker.
- IPRoyal credentials are not passed directly to Chromium. `proxy-chain` creates a local anonymized proxy bridge; Chromium connects to that local bridge.
- Proxy bypass includes `127.0.0.1`, `localhost`, `::1`, so OAuth callback URLs hit OpenGem inside the container directly instead of going through IPRoyal.
- For proxied browser sessions, `/api/auth/callback` returns a standalone completion page (`Account connected`) instead of redirecting to the admin dashboard, because the remote Chromium does not share the admin cookie.

## Deployment guardrails

Production path: `/opt/opengem`.

Safe rsync must preserve production state:

```bash
rsync -az --delete --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'config.json' --exclude '.next' --exclude 'out' ./ root@72.56.83.46:/opt/opengem/
```

Then rebuild:

```bash
ssh root@72.56.83.46 'cd /opt/opengem/deploy/amsterdam && docker compose up -d --build'
```

Never rsync over `data`, `.env`, or `config.json` unless explicitly intended.