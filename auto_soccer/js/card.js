// 日本代表風スポーツカード×文化祭プロフィールの選手カード(DOM組み立て・フリップ演出・紙吹雪・
// 保存/ダウンロード用PNGラスタライズ)。表示用DOMとCanvas2Dラスタライズで同じレイアウトを描く。
// 総合値・ポジションはカード生成時に1回だけ決定し、以後の入力変更では再抽選しない(flow.js側で管理)。

const POSITIONS = ['GK', 'CB', 'SB', 'DMF', 'CMF', 'OMF', 'RMF', 'LMF', 'RWF', 'LWF', 'CF'];

export const SKILL_OPTIONS = [
    '二度寝マスター', 'ギリギリ登校', 'テスト前覚醒', '無駄な記憶力', '無駄知識マスター',
    '勉強しか勝たん', 'ノート職人', '整理整頓マスター', '忘れ物常習犯', '暗記特化型',
    '夜型人間', 'コミュ力おばけ', 'ノリと勢い', 'こだわり強め',
];

export function randomRating() {
    return Math.floor(Math.random() * 8) + 92; // 92〜99(既存プログラムと同じくポジティブな範囲)
}

export function randomPosition() {
    return POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
}

function infoCellMarkup(role, label) {
    return `
        <div class="info-cell">
            <span class="info-label">${label}</span>
            <strong data-role="${role}"></strong>
        </div>
    `;
}

// DOM構造・クラス名はtest/index.html・test/style.cssの参照デザインを流用したもの。
// [data-role]属性だけは既存のauto/js/flow.js(スマホでの入力欄埋め込み処理)がそのまま使えるよう維持している
export function createCardElement() {
    const el = document.createElement('div');
    el.className = 'player-card';
    el.innerHTML = `
        <div class="card__texture"></div>
        <div class="card__shine"></div>
        <header class="card__top">
            <div class="rating">
                <strong data-role="rating">87</strong>
                <span data-role="position">FW</span>
            </div>
            <div class="japan-mark">
                <span class="japan-mark__circle"></span>
                <div>
                    <b>JAPAN</b>
                    <small>NATIONAL TEAM STYLE</small>
                </div>
            </div>
        </header>
        <div class="card__photo-frame"><img data-role="photo" alt=""></div>
        <section class="card__info">
            ${infoCellMarkup('nickname', 'ニックネーム / チームネーム')}
            ${infoCellMarkup('gradeClass', '学年 / クラス')}
            ${infoCellMarkup('animal', 'なりたい動物')}
            ${infoCellMarkup('skill', 'スキル')}
        </section>
        <footer class="card__footer">
            <span>FOOTBALL CARD</span>
            <i></i>
            <span>JAPAN STYLE</span>
        </footer>
    `;
    return el;
}

// data-role="..."の値スロットへテキストを反映する(スマホ表示ではこのスロットの中身をinput/selectに
// 差し替えて直接編集できるようにするため、textContentで上書きする前に埋め込み済みでないか見る)
function setValueSlot(cardEl, role, text) {
    const slot = cardEl.querySelector(`[data-role="${role}"]`);
    if (!slot || slot.querySelector('input, select')) return; // 埋め込み中はDOM操作を横取りしない
    slot.textContent = text;
}

export function updateCardElement(cardEl, data) {
    cardEl.querySelector('[data-role="rating"]').textContent = data.rating;
    cardEl.querySelector('[data-role="position"]').textContent = data.position;
    setValueSlot(cardEl, 'nickname', data.nickname || 'PLAYER');
    setValueSlot(cardEl, 'gradeClass', data.gradeClass || '-');
    setValueSlot(cardEl, 'animal', data.animal || '-');
    setValueSlot(cardEl, 'skill', data.skill || SKILL_OPTIONS[0]);
    const photoImg = cardEl.querySelector('[data-role="photo"]');
    if (data.photoDataUrl) photoImg.src = data.photoDataUrl;
}

export function flipAndReveal(cardEl) {
    return new Promise((resolve) => {
        cardEl.classList.remove('flipped');
        void cardEl.offsetWidth;
        const onEnd = () => {
            cardEl.removeEventListener('transitionend', onEnd);
            resolve();
        };
        cardEl.addEventListener('transitionend', onEnd);
        cardEl.classList.add('flipped');
        setTimeout(resolve, 1200); // transitionendが発火しない環境向けの保険
    });
}

// ---- 紙吹雪(Canvas2D、外部ライブラリなし)。カードの配色(ネイビー/ゴールド/レッド/ホワイト)に合わせる ----
export function launchConfetti(canvasEl, durationMs = 2400) {
    const ctx = canvasEl.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
        canvasEl.width = canvasEl.clientWidth * dpr;
        canvasEl.height = canvasEl.clientHeight * dpr;
    };
    resize();

    const colors = ['#D4AF37', '#C8102E', '#FFFFFF', '#0A1A33'];
    const particles = Array.from({ length: 90 }, () => ({
        x: Math.random() * canvasEl.width,
        y: -20 - Math.random() * canvasEl.height * 0.5,
        size: 4 + Math.random() * 6,
        speedY: 2 + Math.random() * 3,
        speedX: (Math.random() - 0.5) * 2,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.2,
        color: colors[Math.floor(Math.random() * colors.length)],
    }));

    const start = performance.now();
    let rafId;
    function tick(now) {
        const elapsed = now - start;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        particles.forEach((p) => {
            p.x += p.speedX * dpr;
            p.y += p.speedY * dpr;
            p.rotation += p.rotationSpeed;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
        });
        if (elapsed < durationMs) {
            rafId = requestAnimationFrame(tick);
        } else {
            ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        }
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
}

// ---- 保存/ダウンロード用のPNGラスタライズ ----
// 以前はSVG(foreignObject)経由でカードのDOMをそのまま画像化していたが、ChromeやSafariは
// foreignObjectを含むSVG画像をcanvasに描画すると(内容が同一オリジンのみでも)そのcanvasを
// 「汚染(tainted)」扱いにし、以降のtoDataURL()がSecurityErrorで失敗する仕様になっている。
// このエラーがcatchされて画像がnullのまま保存され、選手カードだけギャラリーに出ない不具合の
// 原因になっていたため、通常のCanvas2D描画(プリミティブ+同一オリジンのdata URL画像のみ)に戻す。
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// auto/css/style.cssの.player-card::before/::afterと同じ位置・回転・box-shadowの重なりを再現する。
// box-shadowのオフセット(px)はCSS側が編集画面での実表示サイズ(だいたい300px幅)を基準にした値なので、
// 保存画像側の解像度(width)にあわせて同じ比率でスケールする
function drawStrokeGroup(ctx, cx, cy, w, h, angleDeg, radius, layers, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((angleDeg * Math.PI) / 180);
    layers.forEach(({ dx, dy, color }) => {
        ctx.save();
        ctx.translate(dx * scale, dy * scale);
        drawRoundRect(ctx, -w / 2, -h / 2, w, h, radius);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
    });
    ctx.restore();
}

// rowTop/rowHで渡された行の「上寄り」にラベル+値を収める(以前は行の下端をはみ出していたため)。
// 編集画面は(親の.screenから継承した)text-align:centerのため、xはセルの中心を渡す
function drawLabelValue(ctx, cx, rowTop, rowH, label, value, widthPx) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#d8bd67';
    ctx.font = `800 ${Math.round(widthPx * 0.023)}px -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`;
    ctx.fillText(label, cx, rowTop + rowH * 0.38);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${Math.round(widthPx * 0.044)}px -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`;
    ctx.fillText(value, cx, rowTop + rowH * 0.74);
}

// auto/css/style.css の .player-card と同じ配色・レイアウト比率(2×2の情報グリッド)で描画する
export async function rasterizeCard(data, width = 720) {
    const height = Math.round(width * 4 / 3); // カード比率3:4
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const r = Math.round(width * 0.03);
    const pad = width * 0.05;

    drawRoundRect(ctx, 0, 0, width, height, r);
    ctx.clip();

    ctx.fillStyle = '#07152f';
    ctx.fillRect(0, 0, width, height);

    // 編集画面(.player-card::before/::after)と同じ位置・太さ・重なりのブラシストローク
    const strokeScale = width / 300; // CSSのbox-shadowオフセット(px)は約300px幅の表示を基準にした値
    const strokeRadius = 2 * strokeScale;

    drawStrokeGroup(
        ctx,
        width * 0.12, height * 0.77,
        width * 0.72, height * 0.08,
        -27, strokeRadius,
        [
            { dx: 0, dy: 0, color: 'rgba(255,255,255,0.88)' },
            { dx: 8, dy: 20, color: 'rgba(255,255,255,0.16)' },
            { dx: 0, dy: 42, color: 'rgba(200,16,46,0.88)' },
        ],
        strokeScale
    );
    drawStrokeGroup(
        ctx,
        width * 0.91, height * 0.855,
        width * 0.58, height * 0.05,
        -27, strokeRadius,
        [
            { dx: 0, dy: 0, color: 'rgba(200,16,46,0.78)' },
            { dx: -12, dy: -22, color: 'rgba(255,255,255,0.72)' },
            { dx: -18, dy: 18, color: 'rgba(255,255,255,0.1)' },
        ],
        strokeScale
    );

    // 総合値・ポジション(左上)
    const topY = height * 0.03;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4f4f1';
    ctx.font = `900 ${Math.round(width * 0.17)}px Impact, "Arial Black", sans-serif`;
    ctx.fillText(String(data.rating), pad, topY + width * 0.13);
    ctx.font = `900 ${Math.round(width * 0.05)}px -apple-system, sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(data.position, pad + width * 0.005, topY + width * 0.2);

    // JAPANマーク(右上、日の丸を連想させる赤丸+ワードマーク。実ロゴは使わない)
    const markRightX = width - pad;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${Math.round(width * 0.06)}px -apple-system, sans-serif`;
    ctx.fillText('JAPAN', markRightX, topY + width * 0.065);
    ctx.fillStyle = '#d7c47e';
    ctx.font = `700 ${Math.round(width * 0.021)}px -apple-system, sans-serif`;
    ctx.fillText('NATIONAL TEAM STYLE', markRightX, topY + width * 0.095);

    const circleR = width * 0.034;
    const circleCx = markRightX - ctx.measureText('NATIONAL TEAM STYLE').width - circleR - width * 0.022;
    ctx.beginPath();
    ctx.arc(circleCx, topY + width * 0.058, circleR, 0, Math.PI * 2);
    ctx.fillStyle = '#d91631';
    ctx.fill();
    ctx.lineWidth = width * 0.006;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();

    // 写真(4:3、白+ゴールドの二重フレーム)
    const photoW = width - pad * 2;
    const photoH = photoW * 3 / 4;
    const photoX = pad;
    const photoY = height * 0.2; // ポジション文字とはかぶらない範囲でできるだけ間を詰める
    if (data.photoDataUrl) {
        try {
            const img = await loadImage(data.photoDataUrl);
            ctx.save();
            ctx.beginPath();
            ctx.rect(photoX, photoY, photoW, photoH);
            ctx.clip();
            const scale = Math.max(photoW / img.width, photoH / img.height);
            const dw = img.width * scale;
            const dh = img.height * scale;
            ctx.drawImage(img, photoX + (photoW - dw) / 2, photoY + (photoH - dh) / 2, dw, dh);
            ctx.restore();
        } catch (err) {
            console.error('カード写真の描画に失敗しました: ', err);
        }
    }
    ctx.lineWidth = Math.max(2, width * 0.005);
    ctx.strokeStyle = 'rgba(255,255,255,0.86)';
    ctx.strokeRect(photoX, photoY, photoW, photoH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(212,175,55,0.65)';
    const outlineOffset = width * 0.008;
    ctx.strokeRect(photoX + outlineOffset, photoY + outlineOffset, photoW - outlineOffset * 2, photoH - outlineOffset * 2);

    // 情報エリア(上左NICKNAME/上右GRADE・下左ANIMAL/下右SKILLの2×2グリッド)
    // フッター(FOOTBALL CARD / JAPAN STYLE)とかぶらないよう、全体を上に詰めてある
    const infoTop = photoY + photoH + height * 0.022;
    const rowH = height * 0.088;
    const infoBottom = infoTop + rowH * 2;
    const midX = photoX + photoW / 2;

    // .info-cellの濃紺のほぼ不透明な背景を再現する(これがないと背後のブラシストロークが
    // 文字にかぶって読みづらくなる)
    ctx.fillStyle = 'rgba(7,21,47,0.96)';
    ctx.fillRect(photoX, infoTop, photoW, rowH * 2);

    ctx.strokeStyle = 'rgba(212,175,55,0.58)';
    ctx.lineWidth = 1;
    for (let row = 0; row <= 2; row++) {
        const y = infoTop + rowH * row;
        ctx.beginPath(); ctx.moveTo(photoX, y); ctx.lineTo(photoX + photoW, y); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(midX, infoTop); ctx.lineTo(midX, infoBottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(photoX, infoTop); ctx.lineTo(photoX, infoBottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(photoX + photoW, infoTop); ctx.lineTo(photoX + photoW, infoBottom); ctx.stroke();

    const leftColCx = photoX + photoW / 4;
    const rightColCx = midX + photoW / 4;
    drawLabelValue(ctx, leftColCx, infoTop, rowH, 'ニックネーム / チームネーム', data.nickname || 'PLAYER', width);
    drawLabelValue(ctx, rightColCx, infoTop, rowH, '学年 / クラス', data.gradeClass || '-', width);
    drawLabelValue(ctx, leftColCx, infoTop + rowH, rowH, 'なりたい動物', data.animal || '-', width);
    drawLabelValue(ctx, rightColCx, infoTop + rowH, rowH, 'スキル', data.skill || SKILL_OPTIONS[0], width);

    // 下部フッター(タグライン+区切り線)
    const footerY = height * 0.965;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d7bd68';
    ctx.font = `800 ${Math.round(width * 0.02)}px -apple-system, sans-serif`;
    ctx.fillText('FOOTBALL CARD', pad, footerY);
    const leftTextW = ctx.measureText('FOOTBALL CARD').width;
    ctx.textAlign = 'right';
    ctx.fillText('JAPAN STYLE', width - pad, footerY);
    const rightTextW = ctx.measureText('JAPAN STYLE').width;
    ctx.strokeStyle = 'rgba(212,175,55,0.45)';
    ctx.beginPath();
    ctx.moveTo(pad + leftTextW + width * 0.02, footerY - width * 0.006);
    ctx.lineTo(width - pad - rightTextW - width * 0.02, footerY - width * 0.006);
    ctx.stroke();

    // ごく控えめな全体の光沢(1本のみ、常時アニメーションはしない静止画なのでこれで十分)
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const gloss = ctx.createLinearGradient(0, 0, width, height * 0.6);
    gloss.addColorStop(0.42, 'rgba(255,255,255,0)');
    gloss.addColorStop(0.5, 'rgba(255,255,255,0.07)');
    gloss.addColorStop(0.58, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // 外周の細い枠線(最後に重ねて描く)
    ctx.strokeStyle = '#9f7c24';
    ctx.lineWidth = Math.max(2, width * 0.0028);
    drawRoundRect(ctx, ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth, r);
    ctx.stroke();

    return canvas.toDataURL('image/png');
}
