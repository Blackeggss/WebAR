// WebAR 認証ゲート(独立モジュール)。
// 保護対象の3ページ(/, /auto/, /auto_soccer/)の起動直前に1回だけ呼ばれ、
// URLの ?token= をCloudflare Workerに問い合わせて有効性を確認する。
// カメラ/AR/IndexedDB等、呼び出し側の既存処理には一切関与しない。

const WORKER_BASE = 'https://webar-auth.blackeggs-webar.workers.dev';
const PUBLIC_URL = 'https://blackeggss.github.io/WebAR/public/';
const REDIRECT_COUNTDOWN_SEC = 4;

// messagePrefix(理由の説明文)の後に「N秒後に制限されたページへ移動します。」を続けて表示し、
// 1秒ごとにNをカウントダウンしながら0になったら/public/へ遷移する。
function showOverlayWithCountdown(messagePrefix) {
    const overlay = document.createElement('div');
    overlay.id = 'auth_gate_overlay';
    const style = document.createElement('style');
    style.textContent = `
        #auth_gate_overlay {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: #05060a;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 32px;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        #auth_gate_overlay p {
            white-space: pre-line;
            line-height: 1.9;
            font-size: 16px;
            max-width: 420px;
            margin: 0;
        }
    `;
    const text = document.createElement('p');
    overlay.appendChild(text);
    document.head.appendChild(style);
    document.body.appendChild(overlay);

    let remaining = REDIRECT_COUNTDOWN_SEC;
    const render = () => {
        text.textContent = `${messagePrefix}\n${remaining}秒後に制限されたページへ移動します。`;
    };
    render();

    const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(timer);
            window.location.href = PUBLIC_URL;
            return;
        }
        render();
    }, 1000);
}

// 認証OKならtrue、NGなら案内を表示してfalseを返す。
export async function ensureAuthorized() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
        showOverlayWithCountdown('文化祭会場のQRコードを読み取ってください。');
        return false;
    }

    let result = null;
    try {
        const res = await fetch(`${WORKER_BASE}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        result = await res.json();
    } catch {
        result = null;
    }

    if (!result || result.valid !== true) {
        showOverlayWithCountdown('このQRコードは無効です。\n文化祭会場に表示されている\n新しいQRコードを読み取ってください。');
        return false;
    }

    return true;
}

// 認証が必要な別ページ(例: /auto/ → /)へ遷移する際に、現在のURLの?tokenを引き継いで移動する。
export function redirectWithToken(path) {
    const token = new URLSearchParams(window.location.search).get('token');
    window.location.href = token ? `${path}?token=${encodeURIComponent(token)}` : path;
}
