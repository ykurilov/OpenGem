# Proxied Auth Browser Design

## Goal

Make Google account connection strict end-to-end: the Google login page, OAuth callback completion, token exchange, userinfo, Code Assist onboarding, and later Gemini calls all use the selected account's residential proxy.

## Approach

OpenGem adds a temporary remote browser session for OAuth. The admin selects a proxy, clicks `Proxied Login`, and OpenGem starts a Chromium browser on the server with that proxy configured. The Accounts page displays a screenshot-based viewport and sends click/keyboard commands back to the browser. Google sees the selected residential proxy IP during login.

The callback stays on the built-in loopback redirect URI:

```text
http://127.0.0.1:3050/api/auth/callback
```

Because Chromium runs in the same container as OpenGem, the loopback callback reaches the app without any manual copy-paste.

## Components

- `src/services/auth-browser.ts` owns temporary Chromium sessions, screenshots, mouse clicks, text input, special keys, completion/error status, TTL cleanup, and Xvfb cleanup.
- `src/index.ts` exposes admin-only `/api/auth-browser/sessions` endpoints and links OAuth state to an auth browser session.
- `app/opengem-console.jsx` adds the Accounts-page remote viewport and controls.
- `Dockerfile` installs system Chromium and Xvfb. `playwright-core` controls the system browser without downloading a bundled browser.

## Security Model

Only authenticated admins can create or control auth browser sessions. Sessions are temporary, capped, and deleted from `/tmp` after close or TTL. Proxy credentials are read from the encrypted proxy store and are not sent to the frontend. Google credentials typed into the remote browser are forwarded to Chromium and are not stored by OpenGem.

## Error Handling

If Chromium or Xvfb fails, the API returns a sanitized error. If OAuth fails after callback, the session status becomes `error` and the UI shows the sanitized message. If OAuth completes, the session status becomes `completed`, Accounts refreshes, and the user can close the browser.

## Verification

- Local `npm run build` must pass.
- Docker image must build with Chromium and Xvfb installed.
- Production `/accounts` must return 200.
- Production proxy count must remain unchanged.
- A test auth browser session should reach Google through the selected proxy and expose screenshot/control endpoints.
