// WebAR トークン認証Worker
//
// KVには token(=キー "token:<値>") ごとに
//   { token, createdAt, expiresAt, status, updatedAt, revokedAt }
// を保存する。status はここでは 'active' / 'revoked' のみを保持し、
// 「期限切れ」は保存せず読み取り時に now > expiresAt かどうかで都度導出する
// (KVの自動expiration機能は使わない。これにより期限切れトークンを後から
//  再有効化=expiresAtの再設定だけで復活させられる)。
//
// 設定(AUTH_ENABLEDなど)は特別キー "settings" に保存する。

const TOKEN_PREFIX = 'token:';
const SETTINGS_KEY = 'settings';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

const EXPIRY_PRESETS_MS = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
};

function isLocalOrigin(origin) {
    if (!origin) return false;
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
        return false;
    }
}

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = origin === env.ALLOWED_ORIGIN || isLocalOrigin(origin);
    const headers = {
        'Vary': 'Origin',
    };
    if (allowed) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
    return headers;
}

function json(data, init, request, env) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(request, env),
        ...(init && init.headers ? init.headers : {}),
    };
    return new Response(JSON.stringify(data), { ...init, headers });
}

function randomBase64Url(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateToken() {
    return randomBase64Url(32);
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

async function hmacSign(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const bytes = new Uint8Array(sig);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createAdminSession(env) {
    const payload = JSON.stringify({ exp: Date.now() + ADMIN_SESSION_TTL_MS });
    const payloadB64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = await hmacSign(env.ADMIN_SESSION_SECRET, payloadB64);
    return `${payloadB64}.${sig}`;
}

async function verifyAdminSession(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/);
    if (!match) return false;
    const token = match[1];
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payloadB64, sig] = parts;
    const expectedSig = await hmacSign(env.ADMIN_SESSION_SECRET, payloadB64);
    if (!timingSafeEqual(sig, expectedSig)) return false;
    try {
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        return typeof payload.exp === 'number' && Date.now() < payload.exp;
    } catch {
        return false;
    }
}

function deriveStatus(record, now) {
    if (record.status === 'revoked') return 'revoked';
    if (record.expiresAt && now > record.expiresAt) return 'expired';
    return 'active';
}

async function getSettings(env) {
    const raw = await env.TOKENS.get(SETTINGS_KEY, 'json');
    return raw || { authEnabled: true };
}

async function readBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function resolveExpiresAt(body, now) {
    // body.expiryPreset: '1h'|'6h'|'12h'|'24h'|'3d'|'7d'|'unlimited'|'custom'
    // body.customMs: カスタム時の追加ミリ秒
    const preset = body.expiryPreset || '24h';
    if (preset === 'unlimited') return null;
    if (preset === 'custom') {
        const ms = Number(body.customMs);
        if (!Number.isFinite(ms) || ms <= 0) return null;
        return now + ms;
    }
    const ms = EXPIRY_PRESETS_MS[preset];
    if (!ms) return now + EXPIRY_PRESETS_MS['24h'];
    return now + ms;
}

function toPublicRecord(record, now) {
    return {
        token: record.token,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        status: deriveStatus(record, now),
        updatedAt: record.updatedAt || null,
        revokedAt: record.revokedAt || null,
    };
}

async function handleVerify(request, env) {
    const body = await readBody(request);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) return json({ valid: false, reason: 'missing_token' }, { status: 200 }, request, env);

    const settings = await getSettings(env);
    if (settings.authEnabled === false) {
        return json({ valid: false, reason: 'auth_disabled' }, { status: 200 }, request, env);
    }

    const record = await env.TOKENS.get(TOKEN_PREFIX + token, 'json');
    if (!record) return json({ valid: false, reason: 'not_found' }, { status: 200 }, request, env);

    const now = Date.now();
    const status = deriveStatus(record, now);
    if (status !== 'active') {
        return json({ valid: false, reason: status }, { status: 200 }, request, env);
    }
    return json({ valid: true }, { status: 200 }, request, env);
}

async function handleAdminLogin(request, env) {
    const body = await readBody(request);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
        return json({ ok: false, reason: 'invalid_password' }, { status: 401 }, request, env);
    }
    const sessionToken = await createAdminSession(env);
    return json({ ok: true, sessionToken }, { status: 200 }, request, env);
}

async function requireAdmin(request, env) {
    const ok = await verifyAdminSession(request, env);
    if (!ok) return json({ ok: false, reason: 'unauthorized' }, { status: 401 }, request, env);
    return null;
}

async function listAllTokenRecords(env) {
    const records = [];
    let cursor;
    do {
        const page = await env.TOKENS.list({ prefix: TOKEN_PREFIX, cursor });
        for (const key of page.keys) {
            const record = await env.TOKENS.get(key.name, 'json');
            if (record) records.push(record);
        }
        cursor = page.cursor;
        if (page.list_complete) break;
    } while (cursor);
    return records;
}

async function handleListTokens(request, env) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const now = Date.now();
    const records = await listAllTokenRecords(env);
    const publicRecords = records
        .map((r) => toPublicRecord(r, now))
        .sort((a, b) => b.createdAt - a.createdAt);
    const settings = await getSettings(env);

    const summary = { active: 0, expired: 0, revoked: 0 };
    for (const r of publicRecords) summary[r.status]++;

    return json({ ok: true, tokens: publicRecords, summary, authEnabled: settings.authEnabled !== false }, { status: 200 }, request, env);
}

async function handleCreateToken(request, env) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const body = await readBody(request);
    const now = Date.now();
    const token = generateToken();
    const record = {
        token,
        createdAt: now,
        expiresAt: resolveExpiresAt(body, now),
        status: 'active',
        updatedAt: now,
        revokedAt: null,
    };
    await env.TOKENS.put(TOKEN_PREFIX + token, JSON.stringify(record));
    return json({ ok: true, token: toPublicRecord(record, now) }, { status: 200 }, request, env);
}

async function handleExtendToken(request, env, tokenValue) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const record = await env.TOKENS.get(TOKEN_PREFIX + tokenValue, 'json');
    if (!record) return json({ ok: false, reason: 'not_found' }, { status: 404 }, request, env);

    const body = await readBody(request);
    const now = Date.now();
    // 延長は「現在のexpiresAt(なければ現在時刻)」を起点に加算する。無期限化の場合はnullにする。
    const preset = body.expiryPreset || '24h';
    if (preset === 'unlimited') {
        record.expiresAt = null;
    } else {
        const base = record.expiresAt && record.expiresAt > now ? record.expiresAt : now;
        const addMs = preset === 'custom' ? Number(body.customMs) || 0 : (EXPIRY_PRESETS_MS[preset] || 0);
        record.expiresAt = base + addMs;
    }
    record.updatedAt = now;
    await env.TOKENS.put(TOKEN_PREFIX + tokenValue, JSON.stringify(record));
    return json({ ok: true, token: toPublicRecord(record, now) }, { status: 200 }, request, env);
}

async function handleReactivateToken(request, env, tokenValue) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const record = await env.TOKENS.get(TOKEN_PREFIX + tokenValue, 'json');
    if (!record) return json({ ok: false, reason: 'not_found' }, { status: 404 }, request, env);

    const body = await readBody(request);
    const now = Date.now();
    record.status = 'active';
    record.expiresAt = resolveExpiresAt(body, now); // 再有効化した瞬間から新しく期限を数え直す
    record.updatedAt = now;
    record.revokedAt = null;
    await env.TOKENS.put(TOKEN_PREFIX + tokenValue, JSON.stringify(record));
    return json({ ok: true, token: toPublicRecord(record, now) }, { status: 200 }, request, env);
}

async function handleRevokeToken(request, env, tokenValue) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const record = await env.TOKENS.get(TOKEN_PREFIX + tokenValue, 'json');
    if (!record) return json({ ok: false, reason: 'not_found' }, { status: 404 }, request, env);

    const now = Date.now();
    record.status = 'revoked';
    record.revokedAt = now;
    record.updatedAt = now;
    await env.TOKENS.put(TOKEN_PREFIX + tokenValue, JSON.stringify(record));
    return json({ ok: true, token: toPublicRecord(record, now) }, { status: 200 }, request, env);
}

async function handleRevokeAll(request, env) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const now = Date.now();
    const records = await listAllTokenRecords(env);
    let revokedCount = 0;
    for (const record of records) {
        const status = deriveStatus(record, now);
        if (status === 'active') {
            record.status = 'revoked';
            record.revokedAt = now;
            record.updatedAt = now;
            await env.TOKENS.put(TOKEN_PREFIX + record.token, JSON.stringify(record));
            revokedCount++;
        }
    }
    return json({ ok: true, revokedCount }, { status: 200 }, request, env);
}

async function handleSettings(request, env) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;

    const body = await readBody(request);
    const settings = await getSettings(env);
    if (typeof body.authEnabled === 'boolean') settings.authEnabled = body.authEnabled;
    await env.TOKENS.put(SETTINGS_KEY, JSON.stringify(settings));
    return json({ ok: true, settings }, { status: 200 }, request, env);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method;

        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request, env) });
        }

        try {
            if (pathname === '/verify' && method === 'POST') {
                return await handleVerify(request, env);
            }
            if (pathname === '/admin/login' && method === 'POST') {
                return await handleAdminLogin(request, env);
            }
            if (pathname === '/admin/tokens' && method === 'GET') {
                return await handleListTokens(request, env);
            }
            if (pathname === '/admin/tokens' && method === 'POST') {
                return await handleCreateToken(request, env);
            }
            if (pathname === '/admin/tokens/revoke-all' && method === 'POST') {
                return await handleRevokeAll(request, env);
            }
            const extendMatch = pathname.match(/^\/admin\/tokens\/([^/]+)\/extend$/);
            if (extendMatch && method === 'POST') {
                return await handleExtendToken(request, env, decodeURIComponent(extendMatch[1]));
            }
            const reactivateMatch = pathname.match(/^\/admin\/tokens\/([^/]+)\/reactivate$/);
            if (reactivateMatch && method === 'POST') {
                return await handleReactivateToken(request, env, decodeURIComponent(reactivateMatch[1]));
            }
            const revokeMatch = pathname.match(/^\/admin\/tokens\/([^/]+)\/revoke$/);
            if (revokeMatch && method === 'POST') {
                return await handleRevokeToken(request, env, decodeURIComponent(revokeMatch[1]));
            }
            if (pathname === '/admin/settings' && method === 'POST') {
                return await handleSettings(request, env);
            }

            return json({ ok: false, reason: 'not_found' }, { status: 404 }, request, env);
        } catch (err) {
            return json({ ok: false, reason: 'internal_error', message: String(err && err.message || err) }, { status: 500 }, request, env);
        }
    },
};
