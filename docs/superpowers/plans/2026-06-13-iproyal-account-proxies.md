# IPRoyal Account Proxies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict per-account IPRoyal residential proxy support to OpenGem.

**Architecture:** Store proxies in a dedicated encrypted proxy pool and bind accounts by `proxyId`. Pass the selected proxy through OAuth callback and all account-specific Google/Gemini network calls. Sanitize admin API responses so raw proxy credentials and OAuth tokens never reach the browser.

**Tech Stack:** Node.js 24, Express, TypeScript, SQLite `node:sqlite`, optional Firebase backend, React/Next static admin UI, `https-proxy-agent`.

---

### Task 1: GitHub Fork And Baseline

**Files:**
- Modify: `.dockerignore`
- Create: `Dockerfile`
- Create: `deploy/amsterdam/compose.yml`
- Create: `docs/superpowers/specs/2026-06-13-iproyal-account-proxies-design.md`
- Create: `docs/superpowers/plans/2026-06-13-iproyal-account-proxies.md`

- [ ] **Step 1: Ensure fork remote and branch**

Run:

```bash
git remote -v
git branch --show-current
```

Expected: `origin` points to `https://github.com/ykurilov/OpenGem.git`, `upstream` points to `https://github.com/arifozgun/OpenGem.git`, branch is `codex/iproyal-account-proxies`.

- [ ] **Step 2: Commit baseline deployment/spec files**

Run:

```bash
git add .dockerignore Dockerfile deploy/amsterdam/compose.yml docs/superpowers/specs/2026-06-13-iproyal-account-proxies-design.md docs/superpowers/plans/2026-06-13-iproyal-account-proxies.md
git commit -m "chore: prepare opengem fork deployment"
```

Expected: commit succeeds and working tree keeps only later implementation changes.

### Task 2: Proxy Parsing And Transport

**Files:**
- Create: `src/services/proxy.ts`
- Modify: `src/services/http.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install proxy agent**

Run:

```bash
npm install https-proxy-agent
```

Expected: dependency added to `package.json` and `package-lock.json`.

- [ ] **Step 2: Add proxy helpers**

Create `src/services/proxy.ts` with:

```ts
export interface ParsedProxy {
    normalizedUrl: string;
    host: string;
    port: number;
    username: string;
    maskedUrl: string;
    session?: string;
}
```

The module must export `parseProxyInput`, `maskProxyUrl`, `proxyDisplayName`, and `sanitizeProxyError`. `parseProxyInput` accepts either `host:port:user:password` or a full `http://user:password@host:port` URL, throws on invalid input, and never includes passwords in thrown messages.

- [ ] **Step 3: Add proxy support to native HTTP wrappers**

Extend `RequestOptions` in `src/services/http.ts` with `proxyUrl?: string`. When present, create `new HttpsProxyAgent(proxyUrl)` and pass it as `agent` to `http.request` or `https.request`. Keep existing content-length and timeout behavior.

### Task 3: Database Proxy Pool

**Files:**
- Modify: `src/services/database.ts`
- Modify: `src/services/sqliteDb.ts`
- Modify: `src/services/firebase.ts`

- [ ] **Step 1: Add types and interface methods**

Add `AccountProxy` with `id`, `name`, `url`, `host`, `port`, `username`, `session`, `createdAt`, `updatedAt`. Add optional `proxyId` and internal `proxyUrl` to `Account`. Add methods to `IDatabase`: `getAllProxies`, `getProxy`, `upsertProxy`, `deleteProxy`.

- [ ] **Step 2: Add SQLite migrations**

Update `getDb()` to create `account_proxies` and to add `accounts.proxyId` when missing. Add a `LEFT JOIN account_proxies` in account reads so server-side account objects include decrypted `proxyUrl`.

- [ ] **Step 3: Add Firebase proxy support**

Add `account_proxies` collection helpers and attach proxy URLs to returned account objects by `proxyId`.

### Task 4: Strict OAuth And Account Proxy APIs

**Files:**
- Modify: `src/services/antigravity.ts`
- Modify: `src/services/account-manager.ts`
- Modify: `src/controllers/chat.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Thread proxy through Google helper calls**

Add optional `proxyUrl?: string` parameters to `exchangeCodeForTokens`, `refreshAccessToken`, `getUserEmail`, `discoverProjectId`, and `checkAccountTier`, passing the value into `nativeFetch`.

- [ ] **Step 2: Require proxy for OAuth login**

Change OAuth state storage from `Map<string, string>` to `Map<string, { verifier: string; proxyId: string }>` and require a valid `proxyId` in `/api/auth/login`.

- [ ] **Step 3: Use proxy in OAuth callback**

Load the proxy from `proxyId`; use `proxy.url` for token exchange, email lookup, project discovery, and tier check; save `proxyId` on the account.

- [ ] **Step 4: Prevent direct-IP fallback**

In `ensureFreshToken`, `generateContentWithAccounts`, and `streamGeminiWithSink`, require `account.proxyUrl` when `account.proxyId` exists and pass it to HTTP calls. If `proxyId` exists but URL is missing, mark the attempt failed and continue to another account.

- [ ] **Step 5: Add admin proxy routes**

Implement the routes listed in the design. Sanitize accounts before `/api/accounts` returns JSON. `POST /api/proxies/:id/test` should call `https://api.ipify.org?format=json` through the proxy and return `ok`, `ip`, and masked proxy fields only.

### Task 5: Admin UI

**Files:**
- Modify: `app/opengem-console.jsx`

- [ ] **Step 1: Load proxy pool**

Add `proxies`, `selectedProxyId`, `proxyImportText`, `proxyActionStatus`, and fetch `/api/proxies` during dashboard refresh.

- [ ] **Step 2: Add proxy management panel**

Render bulk import textarea, add/import/test/delete controls, and a table of masked proxies.

- [ ] **Step 3: Make connect strict**

Replace direct `/api/auth/login` link with a button/link that includes `?proxyId=${selectedProxyId}` and is disabled when no proxy is selected.

- [ ] **Step 4: Add per-account proxy replacement**

Add a proxy select in the account row and call `PUT /api/accounts/:id/proxy` on change.

### Task 6: Verification And Deployment

**Files:**
- All implementation files.

- [ ] **Step 1: Build**

Run:

```bash
npm run build
```

Expected: TypeScript and Next build complete with exit code 0.

- [ ] **Step 2: Runtime smoke test**

Build and run Docker locally with temporary `.env`, `config.json`, and `data`, then confirm:

```bash
curl -fsS http://127.0.0.1:<port>/api/setup/status
```

Expected: JSON response from OpenGem.

- [ ] **Step 3: Push branch**

Run:

```bash
git push -u origin codex/iproyal-account-proxies
```

Expected: branch exists on `ykurilov/OpenGem`.

- [ ] **Step 4: Deploy Amsterdam**

Sync to `/opt/opengem`, rebuild with `docker compose up -d --build`, and verify:

```bash
curl -fsS https://opengem.yeycourses.com/api/setup/status
docker ps --filter name=opengem
```

Expected: HTTPS endpoint responds and container is healthy.

