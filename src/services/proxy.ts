export interface ParsedProxy {
    normalizedUrl: string;
    host: string;
    port: number;
    username: string;
    maskedUrl: string;
    session?: string;
}

export interface PublicProxy {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    maskedUrl: string;
    session?: string;
    createdAt?: Date | number;
    updatedAt?: Date | number;
}

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export function parseProxyInput(input: string): ParsedProxy {
    const raw = String(input || '').trim();
    if (!raw) {
        throw new Error('Proxy value is required.');
    }

    try {
        if (raw.includes('://')) {
            return parseProxyUrl(raw);
        }
        return parseColonProxy(raw);
    } catch (err: any) {
        if (err?.message?.startsWith('Proxy ')) {
            throw err;
        }
        throw new Error('Proxy value is invalid.');
    }
}

export function maskProxyUrl(proxyUrl: string): string {
    try {
        const parsed = new URL(proxyUrl);
        const username = decodeURIComponent(parsed.username || '');
        const userDisplay = username ? `${maskMiddle(username)}:***@` : '';
        return `${parsed.protocol}//${userDisplay}${parsed.hostname}:${parsed.port || defaultPort(parsed.protocol)}`;
    } catch {
        return 'invalid-proxy';
    }
}

export function proxyDisplayName(parsed: ParsedProxy): string {
    const session = parsed.session ? `session ${parsed.session}` : parsed.username;
    return `${parsed.host}:${parsed.port} (${session})`;
}

export function sanitizeProxyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || 'Proxy request failed');
    return message
        .replace(/https?:\/\/[^@\s]+@/gi, 'http://***:***@')
        .replace(/([?&](?:proxy|password|pass|token)=)[^&\s]+/gi, '$1***');
}

function parseColonProxy(raw: string): ParsedProxy {
    const parts = raw.split(':');
    if (parts.length < 4) {
        throw new Error('Proxy must use host:port:username:password format.');
    }

    const [host, portValue, username, ...passwordParts] = parts;
    const password = passwordParts.join(':');
    return buildParsedProxy({ protocol: 'http:', host, portValue, username, password });
}

function parseProxyUrl(raw: string): ParsedProxy {
    const url = new URL(raw);
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
        throw new Error('Proxy protocol must be http or https.');
    }
    return buildParsedProxy({
        protocol: url.protocol,
        host: url.hostname,
        portValue: url.port || defaultPort(url.protocol),
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
    });
}

function buildParsedProxy(input: {
    protocol: string;
    host: string;
    portValue: string;
    username: string;
    password: string;
}): ParsedProxy {
    const host = input.host.trim();
    const username = input.username.trim();
    const password = input.password;
    const port = Number(input.portValue);

    if (!host) throw new Error('Proxy host is required.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Proxy port is invalid.');
    }
    if (!username) throw new Error('Proxy username is required.');
    if (!password) throw new Error('Proxy password is required.');

    const normalizedUrl = `${input.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    return {
        normalizedUrl,
        host,
        port,
        username,
        maskedUrl: maskProxyUrl(normalizedUrl),
        session: extractSession(`${username}_${password}`),
    };
}

function extractSession(value: string): string | undefined {
    const match = value.match(/(?:^|[_-])session[-_]([A-Za-z0-9]+)/i);
    return match?.[1];
}

function maskMiddle(value: string): string {
    if (value.length <= 4) return '***';
    return `${value.slice(0, 3)}...${value.slice(-2)}`;
}

function defaultPort(protocol: string): string {
    return protocol === 'https:' ? '443' : '80';
}
