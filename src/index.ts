import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getDatabase, invalidateDbCache } from './services/database';
import type { Account, AccountProxy } from './services/database';
import { requireAdmin } from './middleware/auth';
import { isConfigured, getConfig, saveConfig, generateJwtSecret, generateApiKey, verifyUsername, switchDatabaseBackend, updateAdminCredentials } from './services/config';
import {
    OAUTH_CONFIG,
    generatePkce,
    exchangeCodeForTokens,
    discoverProjectId,
    getUserEmail,
    checkAccountTier,
    DEFAULT_MODEL
} from './services/antigravity';
import { warmAccountCache, invalidateAccountCache } from './services/account-manager';
import { hashAffinityValue } from './services/account-affinity';
import { nativeFetch } from './services/http';
import { parseProxyInput, proxyDisplayName, sanitizeProxyError } from './services/proxy';

dotenv.config();

const app = express();
app.set('trust proxy', 1); // Trust first proxy (LiteSpeed/cPanel)
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? (process.env.CORS_ORIGIN === '*'
            ? true
            : (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : false))
        : true,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
            fontSrc: ["'self'"],
        }
    }
}));
app.use(cookieParser());
const webDir = path.join(__dirname, '../out');
app.use(express.static(webDir, { index: false, redirect: false }));

function sendWebPage(res: express.Response, route: string) {
    const normalized = route === '/' ? '/index' : route;
    const candidates = [
        path.join(webDir, `${normalized}.html`),
        path.join(webDir, normalized, 'index.html'),
        path.join(webDir, 'index.html'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return res.sendFile(candidate);
        }
    }
    return res.status(500).send('OpenGem frontend build not found. Run `npm run build` before starting the server.');
}

// --- SETUP MIDDLEWARE ---
// Redirect all requests to /setup if not configured (except setup routes and static files)
app.use((req, res, next) => {
    // Always allow setup routes, static assets
    if (
        req.path === '/setup' ||
        req.path === '/api/setup' ||
        req.path === '/api/setup/status' ||
        req.path === '/robots.txt' ||
        req.path.startsWith('/_next/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.woff2')
    ) {
        return next();
    }

    if (!isConfigured()) {
        return res.redirect('/setup');
    }

    next();
});

// --- SETUP ROUTES ---

// Serve setup.html at clean /setup URL
app.get(['/setup', '/setup/'], (req, res) => {
    sendWebPage(res, '/setup');
});

app.get('/api/setup/status', (req, res) => {
    res.json({ configured: isConfigured() });
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\n');
});

app.post('/api/setup', async (req, res) => {
    // Prevent re-setup if already configured
    if (isConfigured()) {
        return res.status(400).json({ error: 'System is already configured. Reset config.json to reconfigure.' });
    }

    const { firebase, admin, dbBackend } = req.body;
    const backend: 'firebase' | 'local' = dbBackend === 'local' ? 'local' : 'firebase';

    // Validate Firebase config only when firebase backend is chosen
    if (backend === 'firebase') {
        if (!firebase || !firebase.apiKey || !firebase.projectId || !firebase.authDomain ||
            !firebase.storageBucket || !firebase.messagingSenderId || !firebase.appId) {
            return res.status(400).json({ error: 'Missing required Firebase configuration fields.' });
        }
    }

    if (!admin || !admin.username || !admin.password) {
        return res.status(400).json({ error: 'Missing admin username or password.' });
    }

    if (admin.password.length < 8) {
        return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
    }

    if (!/[A-Z]/.test(admin.password) || !/[a-z]/.test(admin.password) || !/[0-9]/.test(admin.password)) {
        return res.status(400).json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, and one digit.' });
    }

    try {
        const [hashedUsername, hashedPassword] = await Promise.all([
            bcrypt.hash(admin.username, 12),
            bcrypt.hash(admin.password, 12),
        ]);

        const config: any = {
            admin: {
                username: hashedUsername,
                password: hashedPassword,
            },
            jwtSecret: generateJwtSecret(),
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString(),
            dbBackend: backend,
        };

        if (backend === 'firebase') {
            config.firebase = {
                apiKey: firebase.apiKey,
                authDomain: firebase.authDomain,
                projectId: firebase.projectId,
                storageBucket: firebase.storageBucket,
                messagingSenderId: firebase.messagingSenderId,
                appId: firebase.appId,
                measurementId: firebase.measurementId || '',
            };
        }

        saveConfig(config);

        res.json({
            success: true,
            message: 'Setup completed successfully!'
        });
    } catch (err: any) {
        console.error('Setup error:', err);
        const errMsg = process.env.NODE_ENV === 'production' ? 'Setup failed. Please try again.' : 'Setup failed: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// --- Helper to get config values safely ---
function getJwtSecret(): string {
    return getConfig().jwtSecret;
}

function getAdminCredentials() {
    const config = getConfig();
    return { username: config.admin.username, password: config.admin.password };
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 login requests per windowMs
    message: { error: 'Too many login attempts, please try again after 15 minutes.' }
});

// --- ADMIN AUTH ROUTES ---

app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const admin = getAdminCredentials();

    // Both username and password are verified via bcrypt.compare (timing-safe)
    const [usernameValid, passwordValid] = await Promise.all([
        verifyUsername(username, admin.username),
        bcrypt.compare(password, admin.password),
    ]);

    if (usernameValid && passwordValid) {
        const token = jwt.sign({ admin: true }, getJwtSecret(), { expiresIn: '12h' });
        res.cookie('admin_session', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 12 * 60 * 60 * 1000 // 12 hours
        });
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_session');
    res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ admin: true });
});

// --- CREDENTIAL CHANGE ROUTE ---
//
// Allows an authenticated admin to rotate username and/or password from the
// Settings page. The current password is always required as a re-authentication
// step (defence in depth — a stolen session cookie alone must not be enough
// to lock the legitimate owner out of their own instance).
//
// The same complexity policy enforced at setup time applies here: min 8 chars,
// at least one uppercase, one lowercase, and one digit. Both new credentials
// are bcrypt-hashed (cost 12) before they ever leave this handler.
app.post('/api/admin/credentials', requireAdmin, async (req, res) => {
    try {
        const { currentPassword, newUsername, newPassword } = req.body || {};

        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({ error: 'Current password is required.' });
        }
        if (!newUsername || typeof newUsername !== 'string' || !newUsername.trim()) {
            return res.status(400).json({ error: 'New username is required.' });
        }
        if (!newPassword || typeof newPassword !== 'string') {
            return res.status(400).json({ error: 'New password is required.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }
        if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
            return res.status(400).json({ error: 'New password must contain at least one uppercase letter, one lowercase letter, and one digit.' });
        }

        const admin = getAdminCredentials();
        const currentValid = await bcrypt.compare(currentPassword, admin.password);
        if (!currentValid) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const [hashedUsername, hashedPassword] = await Promise.all([
            bcrypt.hash(newUsername.trim(), 12),
            bcrypt.hash(newPassword, 12),
        ]);

        updateAdminCredentials(hashedUsername, hashedPassword);

        // Invalidate the existing session so the admin must re-authenticate with
        // the new credentials. The cookie is httpOnly so the client cannot remove
        // it itself.
        res.clearCookie('admin_session');
        res.json({ success: true, message: 'Credentials updated. Please log in again.' });
    } catch (err: any) {
        console.error('Credentials change error:', err);
        const errMsg = process.env.NODE_ENV === 'production'
            ? 'Failed to update credentials. Please try again.'
            : 'Failed to update credentials: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// Simple in-memory store for PKCE verifiers keyed by state parameter
const authStates = new Map<string, { verifier: string; proxyId: string }>();

function sanitizeAccount(account: Account) {
    const { accessToken, refreshToken, proxyUrl, ...safeAccount } = account;
    return safeAccount;
}

function publicProxy(proxy: AccountProxy) {
    const parsed = parseProxyInput(proxy.url);
    return {
        id: proxy.id,
        name: proxy.name,
        host: proxy.host || parsed.host,
        port: proxy.port || parsed.port,
        username: proxy.username || parsed.username,
        session: proxy.session || parsed.session,
        maskedUrl: parsed.maskedUrl,
        createdAt: proxy.createdAt,
        updatedAt: proxy.updatedAt,
    };
}

function parseOAuthCallbackParams(callbackUrl: string): { code?: string; state?: string; error?: string } {
    const parsed = new URL(callbackUrl);
    return {
        code: parsed.searchParams.get('code') || undefined,
        state: parsed.searchParams.get('state') || undefined,
        error: parsed.searchParams.get('error') || undefined,
    };
}

async function completeOAuthAccountConnection(code: string, state: string): Promise<void> {
    const authState = authStates.get(state);
    if (!authState) {
        throw new Error('Invalid or expired authentication state.');
    }
    authStates.delete(state);

    const proxy = await getDatabase().getProxy(authState.proxyId);
    if (!proxy) {
        throw new Error('Selected account proxy is no longer available.');
    }
    const proxyUrl = proxy.url;

    const tokens = await exchangeCodeForTokens(code, authState.verifier, proxyUrl);
    const email = await getUserEmail(tokens.accessToken, proxyUrl);
    const projectId = await discoverProjectId(tokens.accessToken, proxyUrl);
    const { isPro, tierName } = await checkAccountTier(tokens.accessToken, proxyUrl);

    await getDatabase().upsertAccount({
        id: email,
        email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        projectId,
        expiresAt: tokens.expiresAt,
        isActive: true,
        isPro,
        tierName,
        lastUsedAt: new Date(),
        proxyId: proxy.id,
    });
    invalidateAccountCache();
}

async function buildProxyFromInput(value: string, name?: string, id?: string): Promise<AccountProxy> {
    const parsed = parseProxyInput(value);
    return {
        id: id || crypto.randomBytes(12).toString('hex'),
        name: (name || '').trim() || proxyDisplayName(parsed),
        url: parsed.normalizedUrl,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        session: parsed.session,
    };
}

/**
 * Extract an API key from the request, supporting all four conventions used
 * by Gemini, OpenAI, and Anthropic SDKs:
 *   - Authorization: Bearer <key>     (Gemini, OpenAI)
 *   - x-goog-api-key: <key>           (Gemini)
 *   - x-api-key: <key>                (Anthropic)
 *   - ?key=<key>                      (Gemini query string fallback)
 */
function extractApiKey(req: express.Request): string | null {
    const authHeader = req.header('authorization');
    if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1].trim();
    }
    const goog = req.header('x-goog-api-key');
    if (goog) return goog.trim();
    const anthropic = req.header('x-api-key');
    if (anthropic) return anthropic.trim();
    if (typeof req.query.key === 'string') return req.query.key;
    return null;
}

/**
 * Build a protocol-appropriate 401 / 500 response.
 * `errorShape` lets each compatibility surface return errors in the format
 * its SDK expects, instead of leaking the Gemini-shape `{error: "..."}`.
 */
function sendAuthError(
    res: express.Response,
    status: number,
    message: string,
    shape: 'gemini' | 'openai' | 'anthropic',
): void {
    if (res.headersSent) return;
    if (shape === 'openai') {
        res.status(status).json({
            error: { message, type: 'invalid_request_error', param: null, code: status === 401 ? 'invalid_api_key' : null },
        });
        return;
    }
    if (shape === 'anthropic') {
        res.status(status).json({
            type: 'error',
            error: { type: status === 401 ? 'authentication_error' : 'api_error', message },
        });
        return;
    }
    res.status(status).json({ error: message });
}

function makeApiKeyMiddleware(shape: 'gemini' | 'openai' | 'anthropic') {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const apiKey = extractApiKey(req);
        if (!apiKey) {
            return sendAuthError(res, 401, 'Unauthorized. API Key required.', shape);
        }
        try {
            const isValid = await getDatabase().validateApiKey(apiKey);
            if (!isValid) {
                return sendAuthError(res, 401, 'Unauthorized. Invalid API Key.', shape);
            }
            (req as any).opengemApiKeyHash = hashAffinityValue(apiKey);
            next();
        } catch (err) {
            console.error('API Key validation error:', err);
            return sendAuthError(res, 500, 'Internal Server Error.', shape);
        }
    };
}

// Backwards-compatible alias used by the existing Gemini proxy route.
const requireApiKey = makeApiKeyMiddleware('gemini');

// --- AUTH ROUTES ---

// 1. Redirect to Google Consent screen
app.get('/api/auth/login', requireAdmin, async (req, res) => {
    try {
        const proxyId = String(req.query.proxyId || '').trim();
        if (!proxyId) {
            return res.status(400).send('A proxy must be selected before connecting an account.');
        }

        const proxy = await getDatabase().getProxy(proxyId);
        if (!proxy) {
            return res.status(400).send('Selected proxy was not found.');
        }

        const { verifier, challenge } = generatePkce();
        // Separate cryptographic state parameter for CSRF protection
        const state = crypto.randomBytes(32).toString('hex');
        authStates.set(state, { verifier, proxyId: proxy.id });

        const params = new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            response_type: 'code',
            redirect_uri: OAUTH_CONFIG.redirectUri,
            scope: OAUTH_CONFIG.scopes.join(' '),
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: state,
            access_type: 'offline',
            prompt: 'consent',
        });

        res.redirect(`${OAUTH_CONFIG.authUrl}?${params.toString()}`);
    } catch (err: any) {
        console.error('OAuth login error:', sanitizeProxyError(err));
        res.status(500).send('Failed to start OAuth flow.');
    }
});

// 2. Callback from Google
app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error || !code || !state) {
        return res.status(400).send(`OAuth Error: ${error || 'Missing parameters'}`);
    }

    try {
        await completeOAuthAccountConnection(code as string, state as string);
        res.redirect('/');
    } catch (err: any) {
        const safeError = sanitizeProxyError(err);
        console.error('Callback error:', safeError);
        const errMsg = process.env.NODE_ENV === 'production' ? 'Authentication failed. Please try again.' : `Authentication failed: ${safeError}`;
        res.status(500).send(errMsg);
    }
});

app.post('/api/auth/manual-callback', requireAdmin, async (req, res) => {
    try {
        const callbackUrl = String(req.body?.callbackUrl || '').trim();
        if (!callbackUrl) {
            return res.status(400).json({ error: 'Callback URL is required.' });
        }
        const { code, state, error } = parseOAuthCallbackParams(callbackUrl);
        if (error || !code || !state) {
            return res.status(400).json({ error: `OAuth callback is missing code or state${error ? `: ${error}` : ''}.` });
        }
        await completeOAuthAccountConnection(code, state);
        res.json({ success: true });
    } catch (err: any) {
        const safeError = sanitizeProxyError(err);
        console.error('Manual callback error:', safeError);
        res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Authentication failed. Please try again.' : safeError });
    }
});

// --- ACCOUNT MGMT ROUTES ---

app.get('/api/accounts', requireAdmin, async (req, res) => {
    const accounts = await getDatabase().getAllAccounts();
    res.json(accounts.map(sanitizeAccount));
});

app.put('/api/accounts/:id/reactivate', requireAdmin, async (req, res) => {
    await getDatabase().reactivateAccount(String(req.params.id));
    invalidateAccountCache(); // Sync in-memory account list
    res.json({ success: true });
});

app.delete('/api/accounts/:id', requireAdmin, async (req, res) => {
    await getDatabase().deleteAccount(String(req.params.id));
    invalidateAccountCache(); // Sync in-memory account list
    res.json({ success: true });
});

app.put('/api/accounts/:id/proxy', requireAdmin, async (req, res) => {
    try {
        const proxyId = String(req.body?.proxyId || '').trim();
        if (!proxyId) {
            return res.status(400).json({ error: 'proxyId is required.' });
        }
        const proxy = await getDatabase().getProxy(proxyId);
        if (!proxy) {
            return res.status(404).json({ error: 'Proxy not found.' });
        }
        await getDatabase().updateAccount(String(req.params.id), { proxyId: proxy.id });
        invalidateAccountCache();
        res.json({ success: true, proxy: publicProxy(proxy) });
    } catch (err: any) {
        console.error('Assign account proxy error:', sanitizeProxyError(err));
        res.status(500).json({ error: 'Failed to assign account proxy.' });
    }
});

// --- ACCOUNT PROXY ROUTES ---

app.get('/api/proxies', requireAdmin, async (req, res) => {
    try {
        const proxies = await getDatabase().getAllProxies();
        res.json(proxies.map(publicProxy));
    } catch (err: any) {
        console.error('Get proxies error:', sanitizeProxyError(err));
        res.status(500).json({ error: 'Failed to fetch proxies.' });
    }
});

app.post('/api/proxies', requireAdmin, async (req, res) => {
    try {
        const value = String(req.body?.value || '').trim();
        const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
        const proxy = await buildProxyFromInput(value, name);
        const saved = await getDatabase().upsertProxy(proxy);
        res.json(publicProxy(saved));
    } catch (err: any) {
        console.error('Create proxy error:', sanitizeProxyError(err));
        res.status(400).json({ error: sanitizeProxyError(err) });
    }
});

app.post('/api/proxies/bulk', requireAdmin, async (req, res) => {
    try {
        const text = String(req.body?.text || '');
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) {
            return res.status(400).json({ error: 'No proxy lines provided.' });
        }

        const saved: AccountProxy[] = [];
        const errors: Array<{ line: number; error: string }> = [];
        for (let i = 0; i < lines.length; i++) {
            try {
                const proxy = await buildProxyFromInput(lines[i]);
                saved.push(await getDatabase().upsertProxy(proxy));
            } catch (err) {
                errors.push({ line: i + 1, error: sanitizeProxyError(err) });
            }
        }

        res.json({ proxies: saved.map(publicProxy), errors });
    } catch (err: any) {
        console.error('Bulk proxy import error:', sanitizeProxyError(err));
        res.status(500).json({ error: 'Failed to import proxies.' });
    }
});

app.put('/api/proxies/:id', requireAdmin, async (req, res) => {
    try {
        const existing = await getDatabase().getProxy(String(req.params.id));
        if (!existing) {
            return res.status(404).json({ error: 'Proxy not found.' });
        }
        const value = typeof req.body?.value === 'string' && req.body.value.trim()
            ? req.body.value
            : existing.url;
        const name = typeof req.body?.name === 'string' && req.body.name.trim()
            ? req.body.name
            : existing.name;
        const proxy = await buildProxyFromInput(value, name, existing.id);
        const saved = await getDatabase().upsertProxy(proxy);
        invalidateAccountCache();
        res.json(publicProxy(saved));
    } catch (err: any) {
        console.error('Update proxy error:', sanitizeProxyError(err));
        res.status(400).json({ error: sanitizeProxyError(err) });
    }
});

app.delete('/api/proxies/:id', requireAdmin, async (req, res) => {
    try {
        const proxyId = String(req.params.id);
        const accounts = await getDatabase().getAllAccounts();
        const inUse = accounts.filter(account => account.proxyId === proxyId);
        if (inUse.length > 0) {
            return res.status(400).json({ error: `Proxy is assigned to ${inUse.length} account(s). Replace those assignments first.` });
        }
        await getDatabase().deleteProxy(proxyId);
        invalidateAccountCache();
        res.json({ success: true });
    } catch (err: any) {
        console.error('Delete proxy error:', sanitizeProxyError(err));
        res.status(500).json({ error: 'Failed to delete proxy.' });
    }
});

app.post('/api/proxies/:id/test', requireAdmin, async (req, res) => {
    try {
        const proxy = await getDatabase().getProxy(String(req.params.id));
        if (!proxy) {
            return res.status(404).json({ error: 'Proxy not found.' });
        }
        const response = await nativeFetch('https://api.ipify.org?format=json', {
            proxyUrl: proxy.url,
            timeoutMs: 30000,
        });
        const body = response.ok ? await response.json() : { error: await response.text() };
        res.status(response.ok ? 200 : 502).json({
            ok: response.ok,
            status: response.status,
            ip: body?.ip,
            proxy: publicProxy(proxy),
            error: response.ok ? undefined : 'Proxy test failed.',
        });
    } catch (err: any) {
        console.error('Proxy test error:', sanitizeProxyError(err));
        res.status(502).json({ ok: false, error: sanitizeProxyError(err) });
    }
});

// --- API KEYS ROUTES ---

app.get('/api/keys', requireAdmin, async (req, res) => {
    try {
        const keys = await getDatabase().getAllApiKeys();
        res.json(keys);
    } catch (err: any) {
        console.error('Get keys error:', err);
        res.status(500).json({ error: 'Failed to fetch API keys' });
    }
});

app.post('/api/keys', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Key name is required.' });
        }
        const key = generateApiKey();
        const apiKey = await getDatabase().createApiKey(name.trim(), key);
        res.json(apiKey);
    } catch (err: any) {
        console.error('Create key error:', err);
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

app.delete('/api/keys/:id', requireAdmin, async (req, res) => {
    try {
        await getDatabase().deleteApiKey(String(req.params.id));
        res.json({ success: true });
    } catch (err: any) {
        console.error('Delete key error:', err);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// --- STATS & LOGS ROUTES ---

app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await getDatabase().getStats();
        res.json(stats);
    } catch (err: any) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/logs', requireAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 50;
        const logs = await getDatabase().getRecentLogs(limit);
        res.json(logs);
    } catch (err: any) {
        console.error('Logs error:', err);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// --- DATABASE BACKEND ROUTES ---

app.get('/api/admin/db-status', requireAdmin, (req, res) => {
    try {
        const config = getConfig();
        res.json({ backend: config.dbBackend || 'firebase' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to get DB status' });
    }
});

app.post('/api/admin/db-switch', requireAdmin, async (req, res) => {
    const { to, firebase } = req.body;

    if (to !== 'firebase' && to !== 'local') {
        return res.status(400).json({ error: 'Invalid backend. Must be "firebase" or "local".' });
    }

    const currentConfig = getConfig();
    const currentBackend = currentConfig.dbBackend || 'firebase';

    if (currentBackend === to) {
        return res.status(400).json({ error: `Already using ${to} backend.` });
    }

    // Validate Firebase config when switching to firebase
    if (to === 'firebase') {
        if (!firebase || !firebase.apiKey || !firebase.projectId || !firebase.authDomain ||
            !firebase.storageBucket || !firebase.messagingSenderId || !firebase.appId) {
            return res.status(400).json({ error: 'Missing required Firebase configuration fields.' });
        }
    }

    try {
        const sourceDb = getDatabase();

        // Update config FIRST so getDatabase() returns the new backend
        switchDatabaseBackend(to, to === 'firebase' ? firebase : undefined);
        invalidateDbCache();
        const targetDb = getDatabase();

        console.log(`🔄 Migrating data from ${currentBackend} → ${to}...`);

        // Migrate accounts (raw data — do not double-encrypt tokens)
        const accounts = await sourceDb.getAllAccounts();
        for (const account of accounts) {
            await targetDb.upsertAccount(account);
        }

        const proxies = await sourceDb.getAllProxies();
        for (const proxy of proxies) {
            await targetDb.upsertProxy(proxy);
        }

        // Migrate API keys (re-create by name; we lost the original key text so regenerate)
        // Note: we cannot migrate key hashes cross-backend since we don't store the raw key.
        // Instead we copy the metadata, flagging that users may need to regenerate keys.
        // For now we skip key migration and let the user know.

        // Migrate logs
        const logs = await sourceDb.getRecentLogs(5000);
        for (const log of [...logs].reverse()) {
            await targetDb.addRequestLog({
                accountEmail: log.accountEmail,
                question: log.question,
                answer: log.answer,
                ...(log.systemInstruction && { systemInstruction: log.systemInstruction }),
                ...(log.model && { model: log.model }),
                ...(log.isFallback !== undefined && { isFallback: log.isFallback }),
                ...(log.affinityKeyHash && { affinityKeyHash: log.affinityKeyHash }),
                ...(log.affinitySource && { affinitySource: log.affinitySource }),
                ...(log.affinityHit !== undefined && { affinityHit: log.affinityHit }),
                ...(log.affinityRebound !== undefined && { affinityRebound: log.affinityRebound }),
                ...(log.promptTokens !== undefined && { promptTokens: log.promptTokens }),
                ...(log.completionTokens !== undefined && { completionTokens: log.completionTokens }),
                ...(log.effectiveTokensUsed !== undefined && { effectiveTokensUsed: log.effectiveTokensUsed }),
                tokensUsed: log.tokensUsed,
                success: log.success,
                timestamp: log.timestamp,
            });
        }

        console.log(`✅ Migration complete. ${accounts.length} accounts, ${proxies.length} proxies, ${logs.length} logs migrated.`);

        res.json({
            success: true,
            backend: to,
            migrated: { accounts: accounts.length, proxies: proxies.length, logs: logs.length },
            note: 'API keys could not be automatically migrated. Please regenerate them in the Keys tab.',
        });

        // Restart the process so the new backend is fully initialised from a clean state.
        // nodemon / pm2 will automatically bring the server back up.
        console.log(`🔁 Restarting server to apply new database backend (${to})...`);
        // Exit with non-zero code so nodemon treats it as a crash and auto-restarts.
        // Exit 0 (clean) tells nodemon to wait for file changes — exit 1 forces restart.
        setTimeout(() => process.exit(1), 500);
    } catch (err: any) {
        console.error('DB switch error:', err);
        // Try to roll back config change
        try { switchDatabaseBackend(currentBackend as any); invalidateDbCache(); } catch { }
        const errMsg = process.env.NODE_ENV === 'production'
            ? 'Database switch failed. Please try again.'
            : 'Database switch failed: ' + err.message;
        res.status(500).json({ error: errMsg });
    }
});

// --- COMPATIBILITY CONTROLLERS ---

import { handleGenerateContent, handleAdminChat } from './controllers/chat';
import { handleOpenAIChatCompletions, handleOpenAIListModels } from './controllers/openai';
import { handleAnthropicMessages } from './controllers/anthropic';

// --- MODEL CONFIGURATION ROUTES ---



const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // Strict API limit per minute to prevent brute force / dos
    message: { error: 'Too many requests. Please try again later.' }
});

// --- ADMIN CHAT ROUTE ---
app.post('/api/admin/chat', requireAdmin, (req, res) => {
    handleAdminChat(req, res);
});

// --- SPA ROUTING ---

app.get(/^\/(overview|accounts|keys|logs|docs|chat|settings)\/?$/, (req, res) => {
    sendWebPage(res, req.path.replace(/\/$/, ''));
});

app.get('/', (req, res) => {
    sendWebPage(res, '/');
});

app.post('/v1beta/models/:model\\::action', apiLimiter, requireApiKey, (req, res, next) => {
    if (req.params.action === 'generateContent' || req.params.action === 'streamGenerateContent') {
        return handleGenerateContent(req, res);
    }
    return res.status(404).json({ error: 'Not found or unsupported action' });
});

// --- OPENAI-COMPATIBLE ROUTES ---

const requireApiKeyOpenAI = makeApiKeyMiddleware('openai');
const requireApiKeyAnthropic = makeApiKeyMiddleware('anthropic');

app.post('/v1/chat/completions', apiLimiter, requireApiKeyOpenAI, (req, res) => {
    handleOpenAIChatCompletions(req, res);
});

app.get('/v1/models', requireApiKeyOpenAI, (req, res) => {
    handleOpenAIListModels(req, res);
});

// --- ANTHROPIC-COMPATIBLE ROUTES ---

app.post('/v1/messages', apiLimiter, requireApiKeyAnthropic, (req, res) => {
    handleAnthropicMessages(req, res);
});

const PORT = Number(process.env.PORT) || 3050;
// Bind to loopback by default — production deployments behind nginx/Cloudflare
// should never expose this Node process directly to the public internet.
// Operators who run OpenGem on the open internet (rare) can opt in by setting
// HOST=0.0.0.0 explicitly.
const HOST = process.env.HOST || '127.0.0.1';
const EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

app.listen(PORT, HOST, async () => {
    console.log(`🚀 OpenGem running on http://${HOST}:${PORT}`);

    if (!isConfigured()) {
        console.log(`⚙️  Setup required! Visit http://localhost:${PORT}/setup to configure.`);
    } else {
        console.log(`✅ System configured and ready.`);
        // Warm the in-memory account cache so the first request is instant
        warmAccountCache().catch(err => console.error('Account cache warm failed:', err));
    }

    // Background job: auto-reactivate exhausted accounts every 5 minutes
    setInterval(async () => {
        if (!isConfigured()) return;
        try {
            const count = await getDatabase().reactivateExhaustedAccounts(EXHAUSTION_COOLDOWN_MS);
            if (count > 0) {
                console.log(`♻️ Background job: reactivated ${count} exhausted account(s).`);
                invalidateAccountCache(); // Refresh cache after reactivations
            }
        } catch (err) {
            console.error('❌ Background reactivation check failed:', err);
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
});

// Export the Express app (for potential future use)
export default app;
