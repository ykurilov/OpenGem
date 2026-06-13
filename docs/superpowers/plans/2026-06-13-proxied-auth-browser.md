# Proxied Auth Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a temporary server-side Chromium auth browser so Google login itself uses the selected residential proxy.

**Architecture:** OpenGem launches one Xvfb-backed Chromium session per OAuth connection attempt. The backend stores the selected proxy in OAuth state, starts Chromium with Playwright proxy settings, serves screenshots to the admin UI, accepts input events, and marks the browser session completed after OAuth callback succeeds.

**Tech Stack:** Express, React dashboard, Playwright Core, system Chromium, Xvfb, SQLite-backed proxy store.

---

### Task 1: Runtime Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`
- Modify: `.env.example`

- [x] Add `playwright-core` as a dependency.
- [x] Install system Chromium and Xvfb in the production Docker image.
- [x] Document `AUTH_BROWSER_CHROMIUM_PATH` and `AUTH_BROWSER_HEADLESS`.

### Task 2: Auth Browser Service

**Files:**
- Create: `src/services/auth-browser.ts`

- [x] Create session IDs.
- [x] Start Xvfb-backed Chromium with selected proxy credentials.
- [x] Navigate to OAuth URL.
- [x] Capture screenshots.
- [x] Dispatch mouse clicks, text, and special keys.
- [x] Close sessions and clean temporary profile directories.
- [x] Mark sessions completed or errored from OAuth callback handling.

### Task 3: API Wiring

**Files:**
- Modify: `src/index.ts`

- [x] Refactor OAuth URL creation into a shared helper.
- [x] Store optional `authBrowserSessionId` in OAuth state.
- [x] Add admin-only auth browser endpoints.
- [x] Mark the matching browser session completed or errored from callback completion.

### Task 4: Accounts UI

**Files:**
- Modify: `app/opengem-console.jsx`

- [x] Add proxied login button.
- [x] Add remote browser viewport.
- [x] Poll screenshots.
- [x] Send click, text, paste, and special-key events.
- [x] Refresh accounts after browser session completion.
- [x] Keep manual callback field as fallback.

### Task 5: Verification And Deployment

**Files:**
- Verify: local repo
- Verify: production server `/opt/opengem`

- [x] Run `npm run build`.
- [x] Run `git diff --check`.
- [x] Confirm no real proxy credentials are committed.
- [ ] Commit and push the branch.
- [ ] Rsync to Amsterdam server and rebuild Docker image.
- [ ] Verify container health, public `/accounts`, proxy count, and auth-browser code markers.
