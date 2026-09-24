// 文化祭 WebAR 管理画面ロジック。
// 秘密情報(管理者パスワード・APIキー等)はこのファイル/このページには一切含まない。
// すべての認証・トークン操作はCloudflare Worker側で行い、ここはWorkerのAPIを叩くだけ。

const WORKER_BASE = 'https://webar-auth.blackeggs-webar.workers.dev';
const PROTECTED_BASE_URL = 'https://blackeggss.github.io/WebAR/';
const SESSION_STORAGE_KEY = 'webar_admin_session';

const EXPIRY_LABELS = {
    '1h': '1時間',
    '6h': '6時間',
    '12h': '12時間',
    '24h': '24時間',
    '3d': '3日',
    '7d': '7日',
    unlimited: '無期限',
    custom: 'カスタム',
};

const loginScreen = document.getElementById('login_screen');
const dashboardScreen = document.getElementById('dashboard_screen');
const loginForm = document.getElementById('login_form');
const loginPasswordInput = document.getElementById('login_password');
const loginError = document.getElementById('login_error');
const logoutBtn = document.getElementById('logout_btn');

const summaryText = document.getElementById('summary_text');
const authEnabledToggle = document.getElementById('auth_enabled_toggle');

const qrDisplay = document.getElementById('qr_display');

const createForm = document.getElementById('create_form');
const createExpirySelect = document.getElementById('create_expiry');
const createCustomHoursInput = document.getElementById('create_custom_hours');

const activeTableBody = document.querySelector('#active_table tbody');
const expiredTableBody = document.querySelector('#expired_table tbody');
const revokedTableBody = document.querySelector('#revoked_table tbody');
const revokeAllBtn = document.getElementById('revoke_all_btn');

const durationDialog = document.getElementById('duration_dialog');
const durationDialogTitle = document.getElementById('duration_dialog_title');
const durationDialogSelect = document.getElementById('duration_dialog_select');
const durationDialogCustomHours = document.getElementById('duration_dialog_custom_hours');
const durationDialogCancel = document.getElementById('duration_dialog_cancel');
const durationDialogConfirm = document.getElementById('duration_dialog_confirm');

const toastEl = document.getElementById('toast');

let sessionToken = sessionStorage.getItem(SESSION_STORAGE_KEY) || null;
let toastTimer = null;

// Cloudflare KVのlist()は書き込み直後は反映が遅れることがあるため、
// サーバーへ再取得しに行かず、このローカル配列を唯一の描画元として
// 作成・延長・再有効化・無効化・削除のたびに直接更新する。
let tokens = [];

function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function formatDateTime(ms) {
    if (!ms) return '無期限';
    return new Date(ms).toLocaleString('ja-JP');
}

function truncateToken(token) {
    if (token.length <= 16) return token;
    return `${token.slice(0, 8)}…${token.slice(-6)}`;
}

async function apiFetch(path, options = {}) {
    const res = await fetch(WORKER_BASE + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
            ...(options.headers || {}),
        },
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (res.status === 401) {
        sessionToken = null;
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        showLogin();
        throw new Error('セッションが切れました。再度ログインしてください。');
    }
    if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.reason) || `リクエストに失敗しました(${res.status})`);
    }
    return body;
}

function showLogin() {
    loginScreen.hidden = false;
    dashboardScreen.hidden = true;
}

function showDashboard() {
    loginScreen.hidden = true;
    dashboardScreen.hidden = false;
    loadTokens();
}

// ---- ログイン ----

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const password = loginPasswordInput.value;
    try {
        const res = await fetch(WORKER_BASE + '/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
            loginError.textContent = 'パスワードが正しくありません。';
            loginError.hidden = false;
            return;
        }
        sessionToken = body.sessionToken;
        sessionStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
        loginPasswordInput.value = '';
        showDashboard();
    } catch {
        loginError.textContent = '通信に失敗しました。時間をおいて再度お試しください。';
        loginError.hidden = false;
    }
});

logoutBtn.addEventListener('click', () => {
    sessionToken = null;
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    showLogin();
});

// ---- トークン一覧の読み込み・描画 ----

async function loadTokens() {
    try {
        const data = await apiFetch('/admin/tokens');
        tokens = data.tokens;
        authEnabledToggle.checked = data.authEnabled !== false;
        renderAll();
    } catch (err) {
        showToast(err.message);
    }
}

// tokens配列(ローカルのソース・オブ・トゥルース)からテーブル・サマリーを再描画する。
// サーバーへは問い合わせない(list()の遅延を避けるため)。
function renderAll() {
    const summary = { active: 0, expired: 0, revoked: 0 };
    for (const t of tokens) summary[t.status]++;
    summaryText.textContent = `有効なトークン：${summary.active} / 期限切れ：${summary.expired} / 無効化：${summary.revoked}`;

    activeTableBody.innerHTML = '';
    expiredTableBody.innerHTML = '';
    revokedTableBody.innerHTML = '';

    document.querySelector('#active_section .empty_text').hidden = summary.active > 0;
    document.querySelector('#expired_section .empty_text').hidden = summary.expired > 0;
    document.querySelector('#revoked_section .empty_text').hidden = summary.revoked > 0;

    const sorted = [...tokens].sort((a, b) => b.createdAt - a.createdAt);
    for (const token of sorted) {
        const row = buildTokenRow(token);
        if (token.status === 'active') activeTableBody.appendChild(row);
        else if (token.status === 'expired') expiredTableBody.appendChild(row);
        else revokedTableBody.appendChild(row);
    }
}

function upsertToken(record) {
    const i = tokens.findIndex((t) => t.token === record.token);
    if (i >= 0) tokens[i] = record;
    else tokens.unshift(record);
    renderAll();
}

function removeToken(tokenValue) {
    tokens = tokens.filter((t) => t.token !== tokenValue);
    renderAll();
}

function buildTokenRow(token) {
    const tr = document.createElement('tr');

    const tokenTd = document.createElement('td');
    tokenTd.className = 'token_cell';
    const tokenLabel = document.createElement('span');
    tokenLabel.textContent = truncateToken(token.token);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'small_btn secondary_btn';
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => copyToken(token.token));
    tokenTd.appendChild(tokenLabel);
    tokenTd.appendChild(document.createElement('br'));
    tokenTd.appendChild(copyBtn);
    tr.appendChild(tokenTd);

    const createdTd = document.createElement('td');
    createdTd.textContent = formatDateTime(token.createdAt);
    tr.appendChild(createdTd);

    const expiresTd = document.createElement('td');
    expiresTd.textContent = formatDateTime(token.expiresAt);
    tr.appendChild(expiresTd);

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status_badge status_${token.status}`;
    badge.textContent = token.status === 'active' ? '有効' : token.status === 'expired' ? '期限切れ' : '無効化済み';
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    actionsTd.appendChild(buildActionsCell(token));
    tr.appendChild(actionsTd);

    return tr;
}

function buildActionsCell(token) {
    const wrap = document.createElement('div');

    if (token.status === 'active') {
        for (const preset of ['1h', '6h', '24h', '7d']) {
            const btn = document.createElement('button');
            btn.className = 'small_btn secondary_btn';
            btn.textContent = `${EXPIRY_LABELS[preset]}延長`;
            btn.addEventListener('click', () => extendToken(token.token, preset));
            wrap.appendChild(btn);
        }
        const unlimitedBtn = document.createElement('button');
        unlimitedBtn.className = 'small_btn secondary_btn';
        unlimitedBtn.textContent = '無期限に変更';
        unlimitedBtn.addEventListener('click', () => extendToken(token.token, 'unlimited'));
        wrap.appendChild(unlimitedBtn);

        const customBtn = document.createElement('button');
        customBtn.className = 'small_btn secondary_btn';
        customBtn.textContent = 'カスタム延長';
        customBtn.addEventListener('click', () => openDurationDialog('延長する期限を選択', (preset, customHours) => extendToken(token.token, preset, customHours)));
        wrap.appendChild(customBtn);

        const qrBtn = document.createElement('button');
        qrBtn.className = 'small_btn';
        qrBtn.textContent = 'このトークンをQR表示';
        qrBtn.addEventListener('click', () => showQrFor(token.token));
        wrap.appendChild(qrBtn);

        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'small_btn danger_btn';
        revokeBtn.textContent = '無効化';
        revokeBtn.addEventListener('click', () => revokeToken(token.token));
        wrap.appendChild(revokeBtn);
    } else {
        const reactivateBtn = document.createElement('button');
        reactivateBtn.className = 'small_btn';
        reactivateBtn.textContent = '再有効化';
        reactivateBtn.addEventListener('click', () => openDurationDialog('再有効化後の有効期限を選択', (preset, customHours) => reactivateToken(token.token, preset, customHours)));
        wrap.appendChild(reactivateBtn);

        if (token.status === 'revoked') {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'small_btn danger_btn';
            deleteBtn.textContent = '完全に削除';
            deleteBtn.addEventListener('click', () => deleteToken(token.token));
            wrap.appendChild(deleteBtn);
        }
    }

    return wrap;
}

async function copyToken(token) {
    try {
        await navigator.clipboard.writeText(token);
        showToast('トークンをコピーしました');
    } catch {
        showToast('コピーに失敗しました');
    }
}

// ---- トークン作成 ----

createExpirySelect.addEventListener('change', () => {
    createCustomHoursInput.hidden = createExpirySelect.value !== 'custom';
});

createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const preset = createExpirySelect.value;
    const customHours = Number(createCustomHoursInput.value);
    const body = { expiryPreset: preset };
    if (preset === 'custom') {
        if (!customHours || customHours <= 0) {
            showToast('カスタム時間数を入力してください');
            return;
        }
        body.customMs = customHours * 60 * 60 * 1000;
    }
    try {
        const data = await apiFetch('/admin/tokens', { method: 'POST', body: JSON.stringify(body) });
        showToast('トークンを発行しました');
        upsertToken(data.token);
        showQrFor(data.token.token);
    } catch (err) {
        showToast(err.message);
    }
});

// ---- 延長・再有効化・無効化 ----

let durationDialogCallback = null;

function openDurationDialog(title, onConfirm) {
    durationDialogTitle.textContent = title;
    durationDialogSelect.value = '24h';
    durationDialogCustomHours.hidden = true;
    durationDialogCustomHours.value = '';
    durationDialogCallback = onConfirm;
    durationDialog.hidden = false;
}

durationDialogSelect.addEventListener('change', () => {
    durationDialogCustomHours.hidden = durationDialogSelect.value !== 'custom';
});

durationDialogCancel.addEventListener('click', () => {
    durationDialog.hidden = true;
    durationDialogCallback = null;
});

durationDialogConfirm.addEventListener('click', () => {
    const preset = durationDialogSelect.value;
    const customHours = Number(durationDialogCustomHours.value);
    if (preset === 'custom' && (!customHours || customHours <= 0)) {
        showToast('カスタム時間数を入力してください');
        return;
    }
    const callback = durationDialogCallback;
    durationDialog.hidden = true;
    durationDialogCallback = null;
    if (callback) callback(preset, customHours);
});

async function extendToken(tokenValue, preset, customHours) {
    const body = { expiryPreset: preset };
    if (preset === 'custom') body.customMs = customHours * 60 * 60 * 1000;
    try {
        const data = await apiFetch(`/admin/tokens/${encodeURIComponent(tokenValue)}/extend`, { method: 'POST', body: JSON.stringify(body) });
        showToast('有効期限を延長しました');
        upsertToken(data.token);
    } catch (err) {
        showToast(err.message);
    }
}

async function reactivateToken(tokenValue, preset, customHours) {
    const body = { expiryPreset: preset };
    if (preset === 'custom') body.customMs = customHours * 60 * 60 * 1000;
    try {
        const data = await apiFetch(`/admin/tokens/${encodeURIComponent(tokenValue)}/reactivate`, { method: 'POST', body: JSON.stringify(body) });
        showToast('トークンを再有効化しました');
        upsertToken(data.token);
    } catch (err) {
        showToast(err.message);
    }
}

async function revokeToken(tokenValue) {
    if (!confirm('このトークンを無効化しますか？')) return;
    try {
        const data = await apiFetch(`/admin/tokens/${encodeURIComponent(tokenValue)}/revoke`, { method: 'POST', body: JSON.stringify({}) });
        showToast('トークンを無効化しました');
        upsertToken(data.token);
    } catch (err) {
        showToast(err.message);
    }
}

async function deleteToken(tokenValue) {
    if (!confirm('このトークンを完全に削除します。この操作は取り消せません。よろしいですか？')) return;
    try {
        await apiFetch(`/admin/tokens/${encodeURIComponent(tokenValue)}/delete`, { method: 'POST', body: JSON.stringify({}) });
        showToast('トークンを完全に削除しました');
        removeToken(tokenValue);
    } catch (err) {
        showToast(err.message);
    }
}

revokeAllBtn.addEventListener('click', async () => {
    if (!confirm('現在有効なトークンをすべて無効化します。よろしいですか？(期限切れのトークンは対象外です)')) return;
    try {
        const data = await apiFetch('/admin/tokens/revoke-all', { method: 'POST', body: JSON.stringify({}) });
        showToast(`${data.revokedCount}件のトークンを無効化しました`);
        const now = Date.now();
        tokens = tokens.map((t) => (t.status === 'active' ? { ...t, status: 'revoked', revokedAt: now, updatedAt: now } : t));
        renderAll();
    } catch (err) {
        showToast(err.message);
    }
});

// ---- AUTH_ENABLED トグル ----

authEnabledToggle.addEventListener('change', async () => {
    const authEnabled = authEnabledToggle.checked;
    try {
        await apiFetch('/admin/settings', { method: 'POST', body: JSON.stringify({ authEnabled }) });
        showToast(authEnabled ? '認証を有効にしました' : '認証を無効にしました(全ページ利用不可)');
    } catch (err) {
        showToast(err.message);
        authEnabledToggle.checked = !authEnabled;
    }
});

// ---- QRコード表示 ----

function buildQrBlock(label, url) {
    const block = document.createElement('div');
    block.className = 'qr_block';

    const labelEl = document.createElement('p');
    labelEl.className = 'qr_block_label';
    labelEl.textContent = label;
    block.appendChild(labelEl);

    const qrBox = document.createElement('div');
    block.appendChild(qrBox);
    new QRCode(qrBox, { text: url, width: 200, height: 200 });

    const urlText = document.createElement('p');
    urlText.className = 'qr_url_text';
    urlText.textContent = url;
    block.appendChild(urlText);

    return block;
}

function showQrFor(tokenValue) {
    qrDisplay.innerHTML = '';
    qrDisplay.appendChild(buildQrBlock('/WebAR/', `${PROTECTED_BASE_URL}?token=${encodeURIComponent(tokenValue)}`));
    qrDisplay.appendChild(buildQrBlock('/WebAR/auto/', `${PROTECTED_BASE_URL}auto/?token=${encodeURIComponent(tokenValue)}`));
    document.getElementById('qr_section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- 起動 ----

if (sessionToken) {
    showDashboard();
} else {
    showLogin();
}
