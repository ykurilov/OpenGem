import type { Account, IDatabase, RequestLog } from './database';
import { getAccountCooldownInfo } from './account-cooldown';
import { nativeFetch } from './http';

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MIN_SPACING_MS = 2_000;
const DEFAULT_MAX_REQUESTS_PER_HOUR = 60;
const DEFAULT_MAX_REQUESTS_PER_DAY = 300;
const DEFAULT_LOG_SCAN_LIMIT = 5_000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface AccountSafetyConfig {
    enabled: boolean;
    maxConcurrentPerAccount: number;
    minSpacingMs: number;
    maxRequestsPerHour: number;
    maxRequestsPerDay: number;
    logScanLimit: number;
}

interface AccountSafetyMetrics {
    inFlight: number;
    requestsLastHour: number;
    requestsLastDay: number;
    lastStartedAt?: string;
    cooldown?: {
        reason: string;
        cooldownUntil: string;
        failureCount: number;
    };
}

export interface AccountSafetyDecision {
    allowed: boolean;
    reason?: string;
    retryAfterMs?: number;
    metrics: AccountSafetyMetrics;
}

const inFlightByAccount = new Map<string, number>();
const lastStartedAtByAccount = new Map<string, number>();

export function getAccountSafetyConfig(): AccountSafetyConfig {
    return {
        enabled: readBooleanEnv('ACCOUNT_SAFETY_MODE', true),
        maxConcurrentPerAccount: readPositiveIntEnv('ACCOUNT_SAFETY_MAX_CONCURRENT_PER_ACCOUNT', DEFAULT_MAX_CONCURRENT),
        minSpacingMs: readNonNegativeIntEnv('ACCOUNT_SAFETY_MIN_SPACING_MS', DEFAULT_MIN_SPACING_MS),
        maxRequestsPerHour: readPositiveIntEnv('ACCOUNT_SAFETY_MAX_REQUESTS_PER_HOUR', DEFAULT_MAX_REQUESTS_PER_HOUR),
        maxRequestsPerDay: readPositiveIntEnv('ACCOUNT_SAFETY_MAX_REQUESTS_PER_DAY', DEFAULT_MAX_REQUESTS_PER_DAY),
        logScanLimit: readPositiveIntEnv('ACCOUNT_SAFETY_LOG_SCAN_LIMIT', DEFAULT_LOG_SCAN_LIMIT),
    };
}

export async function beginAccountSafetyRequest(account: Account, db: IDatabase): Promise<AccountSafetyDecision> {
    const decision = await evaluateAccountSafety(account, db);
    if (!decision.allowed) return decision;

    const currentInFlight = inFlightByAccount.get(account.email) || 0;
    inFlightByAccount.set(account.email, currentInFlight + 1);
    lastStartedAtByAccount.set(account.email, Date.now());

    return {
        ...decision,
        metrics: {
            ...decision.metrics,
            inFlight: currentInFlight + 1,
            lastStartedAt: new Date(lastStartedAtByAccount.get(account.email) || Date.now()).toISOString(),
        },
    };
}

export function finishAccountSafetyRequest(email: string): void {
    const current = inFlightByAccount.get(email) || 0;
    if (current <= 1) {
        inFlightByAccount.delete(email);
        return;
    }
    inFlightByAccount.set(email, current - 1);
}

export async function evaluateAccountSafety(account: Account, db: IDatabase): Promise<AccountSafetyDecision> {
    const config = getAccountSafetyConfig();
    const metrics = await getAccountSafetyMetrics(account.email, db, config);

    if (!config.enabled) {
        return { allowed: true, metrics };
    }

    if (!account.proxyId || !account.proxyUrl) {
        return {
            allowed: false,
            reason: 'Account has no assigned proxy.',
            metrics,
        };
    }

    if (metrics.inFlight >= config.maxConcurrentPerAccount) {
        return {
            allowed: false,
            reason: `Account already has ${metrics.inFlight} in-flight request(s).`,
            retryAfterMs: config.minSpacingMs,
            metrics,
        };
    }

    const lastStartedAt = lastStartedAtByAccount.get(account.email);
    if (lastStartedAt) {
        const nextAllowedAt = lastStartedAt + config.minSpacingMs;
        if (Date.now() < nextAllowedAt) {
            return {
                allowed: false,
                reason: `Account request spacing guard is active.`,
                retryAfterMs: nextAllowedAt - Date.now(),
                metrics,
            };
        }
    }

    if (metrics.requestsLastHour >= config.maxRequestsPerHour) {
        return {
            allowed: false,
            reason: `Hourly safety cap reached (${metrics.requestsLastHour}/${config.maxRequestsPerHour}).`,
            retryAfterMs: await retryAfterForWindow(account.email, db, config, HOUR_MS),
            metrics,
        };
    }

    if (metrics.requestsLastDay >= config.maxRequestsPerDay) {
        return {
            allowed: false,
            reason: `Daily safety cap reached (${metrics.requestsLastDay}/${config.maxRequestsPerDay}).`,
            retryAfterMs: await retryAfterForWindow(account.email, db, config, DAY_MS),
            metrics,
        };
    }

    return { allowed: true, metrics };
}

export async function getAccountSafetyStatus(db: IDatabase): Promise<{
    config: AccountSafetyConfig;
    generatedAt: string;
    accounts: Array<{
        email: string;
        isActive: boolean;
        proxyId?: string;
        hasProxy: boolean;
        tierName?: string;
        safety: AccountSafetyDecision;
    }>;
}> {
    const config = getAccountSafetyConfig();
    const accounts = await db.getAllAccounts();
    const statuses = await Promise.all(accounts.map(async account => ({
        email: account.email,
        isActive: account.isActive,
        proxyId: account.proxyId,
        hasProxy: Boolean(account.proxyId && account.proxyUrl),
        tierName: account.tierName,
        safety: await evaluateAccountSafety(account, db),
    })));

    return {
        config,
        generatedAt: new Date().toISOString(),
        accounts: statuses,
    };
}

export async function runAccountSafetyHealthCheck(account: Account): Promise<{
    account: {
        email: string;
        proxyId?: string;
        hasProxy: boolean;
        tierName?: string;
    };
    directGoogleBlocked: boolean;
    directGoogleError?: string;
    directEgressIp?: string;
    proxiedEgressIp?: string;
    directAndProxiedDiffer: boolean;
    googleViaProxy: {
        ok: boolean;
        status?: number;
        error?: string;
    };
    ok: boolean;
    checkedAt: string;
}> {
    const result = {
        account: {
            email: account.email,
            proxyId: account.proxyId,
            hasProxy: Boolean(account.proxyId && account.proxyUrl),
            tierName: account.tierName,
        },
        directGoogleBlocked: false,
        directGoogleError: undefined as string | undefined,
        directEgressIp: undefined as string | undefined,
        proxiedEgressIp: undefined as string | undefined,
        directAndProxiedDiffer: false,
        googleViaProxy: {
            ok: false,
            status: undefined as number | undefined,
            error: undefined as string | undefined,
        },
        ok: false,
        checkedAt: new Date().toISOString(),
    };

    try {
        await nativeFetch('https://accounts.google.com/', { timeoutMs: 5_000 });
    } catch (err: any) {
        result.directGoogleError = String(err?.message || err);
        result.directGoogleBlocked = result.directGoogleError.includes('Direct Google egress is disabled');
    }

    try {
        const directResponse = await nativeFetch('https://api.ipify.org?format=json', { timeoutMs: 15_000 });
        const direct = await directResponse.json();
        result.directEgressIp = direct?.ip;
    } catch (err: any) {
        result.directEgressIp = `error: ${String(err?.message || err)}`;
    }

    if (!account.proxyUrl) {
        result.googleViaProxy.error = 'Account proxy is not configured.';
        return result;
    }

    try {
        const proxyResponse = await nativeFetch('https://api.ipify.org?format=json', {
            proxyUrl: account.proxyUrl,
            timeoutMs: 15_000,
        });
        const proxied = await proxyResponse.json();
        result.proxiedEgressIp = proxied?.ip;
    } catch (err: any) {
        result.proxiedEgressIp = `error: ${String(err?.message || err)}`;
    }

    try {
        const googleResponse = await nativeFetch('https://accounts.google.com/', {
            proxyUrl: account.proxyUrl,
            timeoutMs: 15_000,
            headers: { 'User-Agent': 'Mozilla/5.0 OpenGem safety check' },
        });
        result.googleViaProxy.status = googleResponse.status;
        result.googleViaProxy.ok = googleResponse.status >= 200 && googleResponse.status < 400;
    } catch (err: any) {
        result.googleViaProxy.error = String(err?.message || err);
    }

    result.directAndProxiedDiffer = Boolean(
        result.directEgressIp
        && result.proxiedEgressIp
        && !result.directEgressIp.startsWith('error:')
        && !result.proxiedEgressIp.startsWith('error:')
        && result.directEgressIp !== result.proxiedEgressIp,
    );
    result.ok = result.directGoogleBlocked && result.directAndProxiedDiffer && result.googleViaProxy.ok;
    return result;
}

async function getAccountSafetyMetrics(email: string, db: IDatabase, config: AccountSafetyConfig): Promise<AccountSafetyMetrics> {
    const logs = await getRecentAccountLogs(email, db, config);
    const now = Date.now();
    const cooldown = getAccountCooldownInfo(email);
    return {
        inFlight: inFlightByAccount.get(email) || 0,
        requestsLastHour: logs.filter(log => toTime(log.timestamp) >= now - HOUR_MS).length,
        requestsLastDay: logs.filter(log => toTime(log.timestamp) >= now - DAY_MS).length,
        lastStartedAt: lastStartedAtByAccount.has(email)
            ? new Date(lastStartedAtByAccount.get(email) || 0).toISOString()
            : undefined,
        cooldown: cooldown ? {
            reason: cooldown.reason,
            cooldownUntil: new Date(cooldown.cooldownUntil).toISOString(),
            failureCount: cooldown.failureCount,
        } : undefined,
    };
}

async function retryAfterForWindow(email: string, db: IDatabase, config: AccountSafetyConfig, windowMs: number): Promise<number> {
    const now = Date.now();
    const logs = await getRecentAccountLogs(email, db, config);
    const expiries = logs
        .map(log => toTime(log.timestamp) + windowMs)
        .filter(expiry => expiry > now)
        .sort((a, b) => a - b);
    return Math.max(0, (expiries[0] || now) - now);
}

async function getRecentAccountLogs(email: string, db: IDatabase, config: AccountSafetyConfig): Promise<RequestLog[]> {
    const logs = await db.getRecentLogs(config.logScanLimit);
    return logs.filter(log => log.accountEmail === email);
}

function toTime(value: Date | number): number {
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
