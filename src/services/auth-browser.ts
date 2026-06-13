import crypto from 'crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { chromium, type BrowserContext, type Page } from 'playwright-core';
const ProxyChain: {
    anonymizeProxy(proxyUrl: string): Promise<string>;
    closeAnonymizedProxy(proxyUrl: string, closeConnections?: boolean): Promise<void>;
} = require('proxy-chain');

import type { AccountProxy } from './database';
import { parseProxyInput, sanitizeProxyError } from './proxy';

const VIEWPORT = { width: 1280, height: 900 };
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const CHROMIUM_PATH = process.env.AUTH_BROWSER_CHROMIUM_PATH || '/usr/bin/chromium';
const TEMP_ROOT = path.join(os.tmpdir(), 'opengem-auth-browser');
const USE_HEADLESS_BROWSER = process.env.AUTH_BROWSER_HEADLESS === 'true';

type AuthBrowserStatus = 'starting' | 'ready' | 'completed' | 'error' | 'closed';

interface AuthBrowserSession {
    id: string;
    proxyId: string;
    proxyName: string;
    createdAt: number;
    expiresAt: number;
    status: AuthBrowserStatus;
    currentUrl: string;
    error?: string;
    context: BrowserContext;
    page: Page;
    userDataDir: string;
    browserProxyUrl: string;
    xvfb?: ChildProcessWithoutNullStreams;
    closeTimer: NodeJS.Timeout;
}

export interface PublicAuthBrowserSession {
    id: string;
    proxyId: string;
    proxyName: string;
    createdAt: string;
    expiresAt: string;
    status: AuthBrowserStatus;
    currentUrl: string;
    error?: string;
    viewport: typeof VIEWPORT;
}

const sessions = new Map<string, AuthBrowserSession>();

export function createAuthBrowserSessionId(): string {
    return crypto.randomBytes(12).toString('hex');
}

export async function startAuthBrowserSession(input: {
    id: string;
    proxy: AccountProxy;
    authUrl: string;
}): Promise<PublicAuthBrowserSession> {
    await enforceSessionLimit();

    const parsedProxy = parseProxyInput(input.proxy.url);
    const browserProxyUrl = await ProxyChain.anonymizeProxy(parsedProxy.normalizedUrl);
    const userDataDir = path.join(TEMP_ROOT, input.id);
    fs.mkdirSync(userDataDir, { recursive: true });
    const browserEnv = {
        ...process.env,
        XDG_CONFIG_HOME: path.join(userDataDir, 'xdg-config'),
        XDG_CACHE_HOME: path.join(userDataDir, 'xdg-cache'),
        XDG_DATA_HOME: path.join(userDataDir, 'xdg-data'),
    };
    fs.mkdirSync(browserEnv.XDG_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(browserEnv.XDG_CACHE_HOME, { recursive: true });
    fs.mkdirSync(browserEnv.XDG_DATA_HOME, { recursive: true });
    const display = `:${90 + sessions.size}`;
    const xvfb = USE_HEADLESS_BROWSER ? undefined : startXvfb(display);
    if (xvfb) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    let context: BrowserContext;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            executablePath: CHROMIUM_PATH,
            headless: USE_HEADLESS_BROWSER,
            viewport: VIEWPORT,
            env: USE_HEADLESS_BROWSER ? browserEnv : { ...browserEnv, DISPLAY: display },
            proxy: {
                server: browserProxyUrl,
            },
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-crash-reporter',
                '--disable-crashpad',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--no-first-run',
                '--disable-blink-features=AutomationControlled',
                `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
            ],
        });
    } catch (err) {
        xvfb?.kill('SIGTERM');
        await ProxyChain.closeAnonymizedProxy(browserProxyUrl, true).catch(() => undefined);
        fs.rmSync(userDataDir, { recursive: true, force: true });
        throw err;
    }

    const page = context.pages()[0] || await context.newPage();
    const now = Date.now();
    const session: AuthBrowserSession = {
        id: input.id,
        proxyId: input.proxy.id,
        proxyName: input.proxy.name,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        status: 'starting',
        currentUrl: 'about:blank',
        context,
        page,
        userDataDir,
        browserProxyUrl,
        xvfb,
        closeTimer: setTimeout(() => {
            void stopAuthBrowserSession(input.id);
        }, SESSION_TTL_MS),
    };

    sessions.set(input.id, session);
    page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) {
            session.currentUrl = page.url();
        }
    });
    page.on('close', () => {
        if (session.status !== 'completed' && session.status !== 'error') {
            session.status = 'closed';
        }
    });

    void navigateAuthBrowserSession(session, input.authUrl);

    return publicSession(session);
}

async function navigateAuthBrowserSession(session: AuthBrowserSession, authUrl: string): Promise<void> {
    try {
        await session.page.goto(authUrl, { waitUntil: 'commit', timeout: 15_000 });
        if (session.status === 'starting') {
            session.status = 'ready';
        }
        session.currentUrl = session.page.url();
    } catch (err) {
        session.currentUrl = session.page.url();
        if (session.status === 'closed' || session.status === 'completed') {
            return;
        }
        if (session.currentUrl && session.currentUrl !== 'about:blank') {
            session.status = 'ready';
            session.error = `Navigation is still loading: ${sanitizeProxyError(err)}`;
            return;
        }
        session.status = 'error';
        session.error = sanitizeProxyError(err);
    }
}

export function getAuthBrowserSession(id: string): PublicAuthBrowserSession | null {
    const session = sessions.get(id);
    return session ? publicSession(session) : null;
}

export async function captureAuthBrowserSession(id: string): Promise<PublicAuthBrowserSession & { image: string }> {
    const session = requireSession(id);
    let image = '';
    let screenshotError = '';
    try {
        const buffer = await session.page.screenshot({
            type: 'jpeg',
            quality: 72,
            fullPage: false,
            timeout: 5_000,
        });
        image = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (err) {
        screenshotError = `Browser frame is not ready yet: ${sanitizeProxyError(err)}`;
    }
    session.currentUrl = session.page.url();
    return {
        ...publicSession(session),
        error: screenshotError || session.error,
        image,
    };
}

export async function clickAuthBrowserSession(id: string, xRatio: number, yRatio: number): Promise<PublicAuthBrowserSession> {
    const session = requireSession(id);
    const x = clamp(xRatio, 0, 1) * VIEWPORT.width;
    const y = clamp(yRatio, 0, 1) * VIEWPORT.height;
    await session.page.mouse.click(x, y);
    session.currentUrl = session.page.url();
    return publicSession(session);
}

export async function typeInAuthBrowserSession(id: string, text: string): Promise<PublicAuthBrowserSession> {
    const session = requireSession(id);
    const safeText = String(text || '').slice(0, 2000);
    if (safeText) {
        await session.page.keyboard.insertText(safeText);
    }
    session.currentUrl = session.page.url();
    return publicSession(session);
}

export async function pressAuthBrowserKey(id: string, key: string): Promise<PublicAuthBrowserSession> {
    const session = requireSession(id);
    const normalizedKey = String(key || '').trim();
    const allowedKeys = new Set([
        'Enter',
        'Tab',
        'Backspace',
        'Delete',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
    ]);
    if (!allowedKeys.has(normalizedKey)) {
        throw new Error('Unsupported browser key.');
    }
    await session.page.keyboard.press(normalizedKey);
    session.currentUrl = session.page.url();
    return publicSession(session);
}

export async function stopAuthBrowserSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.closeTimer);
    session.status = 'closed';
    await session.context.close().catch(() => undefined);
    await ProxyChain.closeAnonymizedProxy(session.browserProxyUrl, true).catch(() => undefined);
    session.xvfb?.kill('SIGTERM');
    fs.rmSync(session.userDataDir, { recursive: true, force: true });
}

export function markAuthBrowserSessionCompleted(id: string | undefined, email?: string): void {
    if (!id) return;
    const session = sessions.get(id);
    if (!session) return;
    session.status = 'completed';
    session.error = email ? `Connected ${email}` : undefined;
}

export function markAuthBrowserSessionError(id: string | undefined, error: unknown): void {
    if (!id) return;
    const session = sessions.get(id);
    if (!session) return;
    session.status = 'error';
    session.error = sanitizeProxyError(error);
}

async function enforceSessionLimit(): Promise<void> {
    const active = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (active.length >= MAX_ACTIVE_SESSIONS) {
        const oldest = active.shift();
        if (!oldest) break;
        await stopAuthBrowserSession(oldest.id);
    }
}

function requireSession(id: string): AuthBrowserSession {
    const session = sessions.get(id);
    if (!session) {
        throw new Error('Auth browser session not found or expired.');
    }
    return session;
}

function publicSession(session: AuthBrowserSession): PublicAuthBrowserSession {
    return {
        id: session.id,
        proxyId: session.proxyId,
        proxyName: session.proxyName,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        status: session.status,
        currentUrl: session.currentUrl,
        error: session.error,
        viewport: VIEWPORT,
    };
}

function startXvfb(display: string): ChildProcessWithoutNullStreams {
    const xvfb = spawn('Xvfb', [
        display,
        '-screen',
        '0',
        `${VIEWPORT.width}x${VIEWPORT.height}x24`,
        '-nolisten',
        'tcp',
    ]);
    xvfb.on('error', err => {
        console.error('Auth browser Xvfb error:', sanitizeProxyError(err));
    });
    return xvfb;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}
