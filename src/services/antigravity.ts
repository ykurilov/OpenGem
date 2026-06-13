import crypto from 'crypto';

import { nativeFetch } from './http';

export const ANTIGRAVITY_CLI_CREDENTIALS = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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'
};

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const GEMINI_API_BASE = `${CODE_ASSIST_ENDPOINT}/v1internal`;
export const DEFAULT_MODEL = 'gemini-3-flash-agent';      // Primary model (hardcoded default)
const CODE_ASSIST_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
const CODE_ASSIST_METADATA = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
};
const CODE_ASSIST_FREE_TIER = 'free-tier';
const CODE_ASSIST_LEGACY_TIER = 'legacy-tier';

export const OAUTH_CONFIG = {
    clientId: ANTIGRAVITY_CLI_CREDENTIALS.clientId,
    clientSecret: ANTIGRAVITY_CLI_CREDENTIALS.clientSecret,
    redirectUri: process.env.OAUTH_REDIRECT_URI || 'http://127.0.0.1:3050/api/auth/callback',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
    ],
};

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function generatePkce() {
    const verifier = crypto.randomBytes(32).toString('hex');
    const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

interface GeminiUserTier {
    id?: string;
    name?: string;
    isDefault?: boolean;
    hasOnboardedPreviously?: boolean;
}

interface IneligibleTier {
    reasonCode?: string;
    reasonMessage?: string;
    tierName?: string;
    validationUrl?: string;
}

interface LoadCodeAssistResponse {
    currentTier?: GeminiUserTier | null;
    allowedTiers?: GeminiUserTier[] | null;
    ineligibleTiers?: IneligibleTier[] | null;
    cloudaicompanionProject?: string | { id?: string; name?: string } | null;
    paidTier?: GeminiUserTier | null;
}

interface LongRunningOperationResponse {
    name?: string;
    done?: boolean;
    response?: {
        cloudaicompanionProject?: {
            id?: string;
            name?: string;
        };
    };
}

async function codeAssistPost<T>(method: string, accessToken: string, body: any, proxyUrl?: string): Promise<T> {
    const response = await nativeFetch(`${CODE_ASSIST_ENDPOINT}/v1internal:${method}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'opengem-intelligence/1.0',
        },
        proxyUrl,
        timeoutMs: 60_000,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`${method} failed (${response.status}): ${summarizeGoogleError(await response.text())}`);
    }

    return response.json() as Promise<T>;
}

async function codeAssistGetOperation<T>(name: string, accessToken: string, proxyUrl?: string): Promise<T> {
    const response = await nativeFetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${name}`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'opengem-intelligence/1.0',
        },
        proxyUrl,
        timeoutMs: 60_000,
    });

    if (!response.ok) {
        throw new Error(`getOperation failed (${response.status}): ${summarizeGoogleError(await response.text())}`);
    }

    return response.json() as Promise<T>;
}

function summarizeGoogleError(bodyText: string): string {
    try {
        const parsed = JSON.parse(bodyText);
        const message = parsed?.error?.message || parsed?.message;
        if (message) return String(message);
    } catch {
        // Fall through to a short text snippet.
    }
    return bodyText ? bodyText.slice(0, 500) : 'empty response';
}

function projectIdFromValue(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && 'id' in value) {
        const id = (value as { id?: unknown }).id;
        if (typeof id === 'string') return id;
    }
    return undefined;
}

function defaultOnboardTier(response: LoadCodeAssistResponse): GeminiUserTier {
    return response.allowedTiers?.find((tier) => tier.isDefault) || {
        id: CODE_ASSIST_LEGACY_TIER,
        name: '',
    };
}

function codeAssistSetupError(response: LoadCodeAssistResponse, fallback = 'Could not discover GCP project ID.'): Error {
    const reasons = response.ineligibleTiers
        ?.map((tier) => [tier.tierName, tier.reasonCode, tier.reasonMessage].filter(Boolean).join(': '))
        .filter(Boolean);
    if (reasons?.length) {
        return new Error(`Google account is not eligible for Gemini Code Assist: ${reasons.join('; ')}`);
    }
    if (CODE_ASSIST_PROJECT_ID) {
        return new Error(fallback);
    }
    return new Error(`${fallback} This Google account may require GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID or may not be eligible for the managed free tier.`);
}

async function waitForOnboardingOperation(
    operation: LongRunningOperationResponse,
    accessToken: string,
    proxyUrl?: string,
): Promise<LongRunningOperationResponse> {
    if (operation.done || !operation.name) return operation;

    let current = operation;
    for (let attempt = 0; attempt < 12 && !current.done; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5_000));
        current = await codeAssistGetOperation<LongRunningOperationResponse>(operation.name, accessToken, proxyUrl);
    }
    return current;
}

export async function discoverProjectId(accessToken: string, proxyUrl?: string): Promise<string> {
    try {
        const projectMetadata = CODE_ASSIST_PROJECT_ID
            ? { ...CODE_ASSIST_METADATA, duetProject: CODE_ASSIST_PROJECT_ID }
            : CODE_ASSIST_METADATA;
        const loadResponse = await codeAssistPost<LoadCodeAssistResponse>('loadCodeAssist', accessToken, {
            cloudaicompanionProject: CODE_ASSIST_PROJECT_ID,
            metadata: projectMetadata,
        }, proxyUrl);

        if (loadResponse.currentTier) {
            const projectId = projectIdFromValue(loadResponse.cloudaicompanionProject);
            if (projectId) return projectId;
            if (CODE_ASSIST_PROJECT_ID) return CODE_ASSIST_PROJECT_ID;
            throw codeAssistSetupError(loadResponse);
        }

        const tier = defaultOnboardTier(loadResponse);
        const onboardingMetadata = tier.id === CODE_ASSIST_FREE_TIER ? CODE_ASSIST_METADATA : projectMetadata;
        const onboardResponse = await codeAssistPost<LongRunningOperationResponse>('onboardUser', accessToken, {
            tierId: tier.id,
            cloudaicompanionProject: tier.id === CODE_ASSIST_FREE_TIER ? undefined : CODE_ASSIST_PROJECT_ID,
            metadata: onboardingMetadata,
        }, proxyUrl);
        const completedOnboarding = await waitForOnboardingOperation(onboardResponse, accessToken, proxyUrl);
        const onboardedProjectId = projectIdFromValue(completedOnboarding.response?.cloudaicompanionProject);
        if (onboardedProjectId) return onboardedProjectId;
        if (CODE_ASSIST_PROJECT_ID) return CODE_ASSIST_PROJECT_ID;

        throw codeAssistSetupError(loadResponse, 'Code Assist onboarding finished without a project ID.');
    } catch (error) {
        console.error('❌ Project discovery failed:', error);
        throw error;
    }
}

export async function checkAccountTier(accessToken: string, proxyUrl?: string): Promise<{ isPro: boolean, tierName: string }> {
    try {
        const projectMetadata = CODE_ASSIST_PROJECT_ID
            ? { ...CODE_ASSIST_METADATA, duetProject: CODE_ASSIST_PROJECT_ID }
            : CODE_ASSIST_METADATA;
        const data = await codeAssistPost<LoadCodeAssistResponse>('loadCodeAssist', accessToken, {
            cloudaicompanionProject: CODE_ASSIST_PROJECT_ID,
            metadata: projectMetadata,
            mode: 'HEALTH_CHECK',
        }, proxyUrl);
        const currentTier = data?.currentTier?.id || 'unknown';
        const paidTier = data?.paidTier?.id;
        const isPro = paidTier === 'g1-pro-tier' || currentTier === 'premium-tier' || paidTier === 'premium-tier';
        const tierName = data?.paidTier?.name || data?.currentTier?.name || currentTier;
        return { isPro, tierName };
    } catch (err) {
        console.error('Failed to check account tier:', err);
    }
    return { isPro: false, tierName: 'Unknown' };
}

export async function exchangeCodeForTokens(code: string, verifier: string, proxyUrl?: string) {
    const response = await nativeFetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        proxyUrl,
        body: new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            client_secret: OAUTH_CONFIG.clientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: OAUTH_CONFIG.redirectUri,
            grant_type: 'authorization_code',
        }).toString(),
    });

    if (!response.ok) {
        throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    const data = await response.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
}

export async function refreshAccessToken(refreshToken: string, proxyUrl?: string) {
    const refreshParams = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const response = await nativeFetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        proxyUrl,
        body: refreshParams.toString(),
    });

    if (!response.ok) {
        throw new Error(`Token refresh failed: ${await response.text()}`);
    }

    const data = await response.json();
    return {
        accessToken: data.access_token,
        // Optional because Google doesn't always return a new refresh token
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
}

export async function getUserEmail(accessToken: string, proxyUrl?: string): Promise<string> {
    const response = await nativeFetch(OAUTH_CONFIG.userInfoUrl, {
        proxyUrl,
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch user email');
    }
    const data = await response.json() as any;
    return data.email;
}
