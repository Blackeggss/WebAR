// 自動撮影フローの状態管理。ポーズルーレット→AR自動装着+カウントダウン連続撮影→
// グリッドレイアウト演出→サンクス→既存ギャラリー(/WebAR/)へ遷移までを制御する。
// (auto_soccer/ の選手カード作成機能を除いたバージョン)

import * as arEngine from './arEngine.js';
import { saveSession } from './db.js';
import { ensureAuthorized, redirectWithToken, WORKER_BASE } from '../../js/auth-gate.js';

if (!(await ensureAuthorized())) {
    throw new Error('WebAR: 認証されていないため起動を中止しました');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_DEFAULT_DOMAIN = '@higashiyama.ed.jp';

const video = document.getElementById('webcam');
const outputCanvas = document.getElementById('output_canvas');
const arLoadingEl = document.getElementById('ar_loading');
const flashOverlay = document.getElementById('flash_overlay');
const toastEl = document.getElementById('toast');
const motionPermissionOverlay = document.getElementById('motion_permission_overlay');

const screens = {
    start: document.getElementById('screen_start'),
    pose: document.getElementById('screen_pose'),
    ar_ready: document.getElementById('screen_ar_ready'),
    countdown: document.getElementById('screen_countdown'),
    preview: document.getElementById('screen_preview'),
    layout: document.getElementById('screen_layout'),
    thanks: document.getElementById('screen_thanks'),
};

const poseIntroLabel = document.getElementById('pose_intro_label');
const poseRouletteWrap = document.getElementById('pose_roulette_wrap');
const poseRouletteTrack = document.getElementById('pose_roulette_track');
const poseResultLabel = document.getElementById('pose_result_label');
const posePhoto = document.getElementById('pose_photo');
const countdownNumberEl = document.getElementById('countdown_number');
const previewImg = document.getElementById('preview_img');
const praiseLabel = document.getElementById('praise_label');
const layoutGrid = document.getElementById('layout_grid');
const layoutNextBtn = document.getElementById('layout_next_btn');
const startBtn = document.getElementById('start_btn');
const emailInput = document.getElementById('email_input');
const emailDomainSuffix = document.getElementById('email_domain_suffix');
const emailSendBtn = document.getElementById('email_send_btn');
const emailStatusMsg = document.getElementById('email_status_msg');
const emailSkipBtn = document.getElementById('email_skip_btn');

const POSES = [
    'ピース ✌️',
    '顎下ピース ✌️',
    '顔の横でハート 🫶',
    '虫歯ポーズ（頬に手をあてる） 😃',
    'ギャルピース ✌️',
    '指ハート 🫰',
];
const AR_MASKS = [
    'ar_fox.png', 'ar_soccer.png', 'ar_wolf.png', 'ar_cat.png', 'ar_dog.png',
    'ar_rabbit.png', 'ar_redpanda.png', 'ar_bear.png', 'ar_squirrel.png', 'ar_gura.png', 'ar_vermeer.png',
].map((f) => `../assets/auto/${f}`);
const FINAL_MASK = '../assets/auto/ar_soccer.png'; // 最後の1枚(ポーズ自由)はauto_soccer/と同じくAR固定
const PRAISE_TEXTS = ['最高！', 'バッチリ！', 'いいね！', 'ナイスショット！'];

let sessionType = 'portrait'; // 'portrait'(系統A・4枚) / 'landscape'(系統B・3枚)。1枚目撮影時に確定する
let posePool = [];
let maskPool = [];
const capturedShots = []; // { dataUrl }
const shotFamilies = []; // 各ショット撮影時(シャッターが切れた瞬間)の系統('A'|'B')。混在判定に使う

// ポーズ・ARの抽選は起動直後に済ませておく(この時点ではまだ画像を読み込まない)。
// 通常ショット用のARプールを作る: 最終カット専用のFINAL_MASKは重複して出さないよう除外する
function buildMaskPool() {
    const pool = AR_MASKS.filter((url) => url !== FINAL_MASK);
    return shuffleArray(pool);
}

function decideSessionPlan() {
    posePool = shuffleArray(POSES);
    maskPool = buildMaskPool();
}

function preloadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve(); // 先読みの失敗で起動を止めない(本番表示時に改めて読み込む)
        img.src = url;
    });
}

// このセッションで使う可能性がある分だけ(最大構成である縦4枚分の非最終3枚+最終カット)を先読みする。
// 5種類全部ではなく使う分だけに絞ることでダウンロード量を減らす。カメラ・モデルの帯域と取り合わないよう、
// それらの読み込みが終わった後に呼ぶ(boot()参照)。完了を待つ必要はないのでawaitしない
// (実際の撮影枚数は1枚目のシャッター時点の傾きで3枚/4枚のどちらかに決まるため、起動時点ではまだ
//  確定していない。最大構成分を先読みしておけば不足は起きない)
const MAX_NON_FINAL_SHOTS = 3;
function preloadSessionAssets() {
    for (let i = 0; i < MAX_NON_FINAL_SHOTS; i++) {
        const poseIndex = POSES.indexOf(posePool[i]) + 1;
        preloadImage(`../assets/pose/pose_${poseIndex}.jpg`);
        preloadImage(maskPool[i]);
    }
    preloadImage(FINAL_MASK);
}

function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
}

function hideAllScreens() {
    Object.values(screens).forEach((el) => { el.hidden = true; });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Fisher-Yates。ポーズ/ARが同じセッション内で重複しないよう、使う順番をあらかじめ決めておくのに使う
function shuffleArray(arr) {
    const result = arr.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

let toastTimer = null;
function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('toast-show'), 2200);
}

function flashEffect() {
    flashOverlay.classList.remove('flash-active');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('flash-active');
}

// 要素をY軸で1回転させる(auto_soccer/の選手カード完成演出で使っていた回転演出を流用)。
// 360度回転は見た目上0度と同じ位置に戻るので、素材はそのまま・ひとひねりだけ加える形になる
function spinElement(el) {
    return new Promise((resolve) => {
        el.classList.remove('spin-once');
        void el.offsetWidth;
        const onEnd = () => {
            el.removeEventListener('transitionend', onEnd);
            resolve();
        };
        el.addEventListener('transitionend', onEnd);
        el.classList.add('spin-once');
        setTimeout(resolve, 1200); // transitionendが発火しない環境向けの保険
    });
}

// ---- 端末の傾き・画面ロック状態から9パターンを判定 ----
// スマホ縦向きを0度とし、時計回りを正の角度として扱う(https://blackeggss.github.io/WebAR/と同じ規約)。
// 系統A(縦持ち想定・4枚): パターン1,2,7,8,9 / 系統B(横持ち想定・3枚): パターン3,4,5,6
// uiRotateDegはポーズ名・カウントダウン等の追加UI文字を、今の持ち方に合わせて読みやすい向きへ
// 回転させるための角度(保存写真・AR自体の向き補正とは別物で、対象も回転方向も異なる)
function classifyOrientationPattern() {
    const info = arEngine.getOrientationInfo();

    if (info.isUpsideDown) {
        if (info.lockedMode) return { pattern: 9, family: 'A', uiRotateDeg: 180 };
        return info.upsideDownDir === 1
            ? { pattern: 7, family: 'A', uiRotateDeg: -90 }
            : { pattern: 8, family: 'A', uiRotateDeg: 90 };
    }
    if (info.lockedMode) {
        if (info.lockedEarlyZone === 'ccw') return { pattern: 4, family: 'B', uiRotateDeg: 90 };
        if (info.lockedEarlyZone === 'cw') return { pattern: 6, family: 'B', uiRotateDeg: -90 };
        return { pattern: 2, family: 'A', uiRotateDeg: 0 };
    }
    if (info.rotationState === 'ccw') return { pattern: 3, family: 'B', uiRotateDeg: 0 };
    if (info.rotationState === 'cw') return { pattern: 5, family: 'B', uiRotateDeg: 0 };
    return { pattern: 1, family: 'A', uiRotateDeg: 0 };
}

// ポーズ名・カウントダウン等の追加UI文字の向きを、現在の傾きに合わせて継続的に追従させる。
// (すでに常時追跡済みの値を読むだけの軽い処理なので、短い間隔のポーリングでも重くならない)
let lastAppliedUiRotateDeg = null;
function syncUiRotation() {
    const { uiRotateDeg } = classifyOrientationPattern();
    if (uiRotateDeg === lastAppliedUiRotateDeg) return;
    lastAppliedUiRotateDeg = uiRotateDeg;
    document.documentElement.style.setProperty('--flow_ui_rotate', `${uiRotateDeg}deg`);
    // 「準備してー！」等の上部固定文言をCSS側(data-ui-rotate)で回転角に応じて再配置するための目印
    document.documentElement.setAttribute('data-ui-rotate', String(uiRotateDeg));
}

// ---- 起動 ----
async function boot() {
    decideSessionPlan(); // ポーズ・ARの抽選だけ先に済ませておく(この時点ではまだ画像を読み込まない)

    arLoadingEl.classList.add('ar_loading-show');
    // 1枚目のマスク画像はこの時点でURLが決まっているので、重いカメラ・AIモデルの読み込みと
    // 並行して取得を始める(initArEngine呼び出し内でThree.js初期化が同期的に終わるため、
    // マスク読み込みの完了が先でも安全)。これにより画像のダウンロード時間が実質タダになる
    const initPromise = arEngine.initArEngine(video, outputCanvas);
    const maskPromise = arEngine.setMaskUrl(maskPool[0]);
    try {
        await initPromise;
    } catch (err) {
        console.error('AR初期化に失敗しました: ', err);
        showToast('カメラを起動できませんでした');
        return;
    }
    // 1枚目で実際に使うARの読み込みが終わるまでは、AR読み込み中の表示を残しておく
    // (カメラ・モデルだけ準備できてもマスク画像が白いまま次に進めてしまわないようにするため)
    await maskPromise;
    arLoadingEl.classList.remove('ar_loading-show');

    // カメラ・AIモデルの読み込みが終わってから先読みを始める(帯域を取り合わないようにするため)
    preloadSessionAssets();

    if (arEngine.needsMotionPermission) {
        const started = await arEngine.tryStartSensorsAutomatically();
        if (!started) {
            await showTapToStart();
        }
    }

    syncUiRotation();
    setInterval(syncUiRotation, 200);

    showScreen('start');
    await waitForStartButton();

    runSequence();
}

function waitForStartButton() {
    return new Promise((resolve) => {
        startBtn.addEventListener('click', () => resolve(), { once: true });
    });
}

function showTapToStart() {
    return new Promise((resolve) => {
        motionPermissionOverlay.hidden = false;
        const onTap = async () => {
            motionPermissionOverlay.removeEventListener('click', onTap);
            await arEngine.requestPermissionThenStartSensors();
            motionPermissionOverlay.hidden = true;
            resolve();
        };
        motionPermissionOverlay.addEventListener('click', onTap, { once: true });
    });
}

// ---- ポーズルーレット ----
const ROULETTE_ITEM_HEIGHT = 64;
const ROULETTE_SPIN_LOOPS = 6;
const ROULETTE_SPIN_DURATION_MS = 3000; // auto/css/style.css の .roulette_track transition と合わせる
const POSE_RESULT_DISPLAY_MS = 2600; // ポーズ名+写真を表示しておく時間

function spinPoseRoulette(chosenPose) {
    return new Promise((resolve) => {
        poseRouletteWrap.hidden = false;
        poseRouletteTrack.style.transition = 'none';
        poseRouletteTrack.innerHTML = '';
        const sequence = [];
        for (let i = 0; i < ROULETTE_SPIN_LOOPS; i++) sequence.push(...POSES);
        sequence.push(chosenPose);
        sequence.forEach((pose) => {
            const item = document.createElement('div');
            item.className = 'roulette_item';
            item.textContent = pose;
            poseRouletteTrack.appendChild(item);
        });
        poseRouletteTrack.style.transform = 'translateY(0)';
        void poseRouletteTrack.offsetWidth;

        poseRouletteTrack.style.transition = '';
        const targetY = -(sequence.length - 1) * ROULETTE_ITEM_HEIGHT;
        requestAnimationFrame(() => {
            poseRouletteTrack.style.transform = `translateY(${targetY}px)`;
        });

        setTimeout(() => {
            poseIntroLabel.hidden = true;
            poseRouletteWrap.hidden = true;
            poseResultLabel.hidden = false;
            poseResultLabel.textContent = `ポーズ決定：${chosenPose}`;
            const poseIndex = POSES.indexOf(chosenPose) + 1;
            posePhoto.src = `../assets/pose/pose_${poseIndex}.jpg`;
            posePhoto.hidden = false;
            resolve();
        }, ROULETTE_SPIN_DURATION_MS + 100);
    });
}

async function runPoseStep(isFirst, isFinal, pose, maskUrl) {
    showScreen('pose');
    poseResultLabel.hidden = true;
    posePhoto.hidden = true;
    poseRouletteWrap.hidden = false;

    // ポーズを決めている演出の間に、次に使うARへ先に切り替えておく
// (読み込みの猶予時間も長くなるため、撮影までに間に合いやすくなる)
    arEngine.setMaskUrl(maskUrl);

    if (isFinal) {
        poseIntroLabel.hidden = true;
        poseResultLabel.hidden = false;
        poseResultLabel.textContent = 'ポーズ自由！\nこれが最後の1枚です！';
        poseRouletteWrap.hidden = true;
        await sleep(2000);
        return;
    }
    poseIntroLabel.hidden = false;
    poseIntroLabel.textContent = isFirst ? '最初のポーズ！' : '次のポーズ！';
    await spinPoseRoulette(pose);
    await sleep(POSE_RESULT_DISPLAY_MS);
}

// ---- AR装着準備 ----
// ARの切り替え自体はポーズ決め演出中(runPoseStep)で済ませてあるので、ここでは準備画面を表示するだけ
async function runArReadyStep() {
    showScreen('ar_ready');
    await sleep(1400);
}

// ---- カウントダウン+撮影 ----
async function runCountdownAndCapture(isFinal) {
    showScreen('countdown');
    // 最後の1枚(ポーズ自由)だけは、ポーズを考える時間を確保するため5秒(5→1を1秒ずつ)かける
    const numbers = isFinal ? [5, 4, 3, 2, 1] : [3, 2, 1];
    const stepMs = isFinal ? 1000 : 700;
    for (const n of numbers) {
        countdownNumberEl.textContent = String(n);
        countdownNumberEl.style.animation = 'none';
        void countdownNumberEl.offsetWidth;
        countdownNumberEl.style.animation = '';
        await sleep(stepMs);
    }
    // シャッターが切れる瞬間の傾き・ロック状態から、このショットの系統(A/B)を確定する
    const { family } = classifyOrientationPattern();
    flashEffect();
    const result = await arEngine.capturePhoto();
    await sleep(150);
    return { ...result, family };
}

async function runPreviewStep(dataUrl) {
    showScreen('preview');
    previewImg.src = dataUrl;
    praiseLabel.textContent = pickRandom(PRAISE_TEXTS);
    await sleep(4000);
}

// 1枚撮影する(ポーズ決め→AR準備→カウントダウン→撮影→プレビュー)。系統をshotFamiliesに記録する
async function runOneShot(isFirst, isFinal, poseIndexInPool) {
    const pose = isFinal ? null : posePool[poseIndexInPool];
    const maskUrl = isFinal ? FINAL_MASK : maskPool[poseIndexInPool];

    await runPoseStep(isFirst, isFinal, pose, maskUrl);
    await runArReadyStep();
    const { dataUrl, family } = await runCountdownAndCapture(isFinal);
    capturedShots.push({ dataUrl });
    shotFamilies.push(family);
    await runPreviewStep(dataUrl);
}

// ---- 撮影シーケンス全体 ----
// 撮影枚数(3枚/4枚)は1枚目のシャッターが切れた瞬間の傾き・ロック状態(系統A/B)だけで確定する
// (系統B=1枚目なら常に3枚で終了。2・3枚目で系統Aが混ざっても4枚には延長しない)。
// 最終カット(ポーズ自由)はauto_soccer/と同じくARをFINAL_MASKに固定する
async function runSequence() {
    capturedShots.length = 0;
    shotFamilies.length = 0;

    await runOneShot(true, false, 0);
    const totalShots = shotFamilies[0] === 'B' ? 3 : 4;
    sessionType = shotFamilies[0] === 'B' ? 'landscape' : 'portrait';

    await runOneShot(false, false, 1);

    const shot3IsFinal = totalShots === 3;
    await runOneShot(false, shot3IsFinal, 2);

    if (totalShots === 4) {
        await runOneShot(false, true, 3); // isFinalのためposeIndexInPoolは使われない
    }

    // 1枚目と系統が異なるショットが1つでもあれば「混在」とみなし、まとめて表示は行わずサンクスへ
    const mixedFamily = shotFamilies.some((f) => f !== shotFamilies[0]);
    if (mixedFamily) {
        await runThanksStep();
        return;
    }

    await runLayoutStep();
}

// ---- グリッドレイアウト演出 ----
// 結合後の画像は縦4枚・横3枚どちらも9:16になるようにし、セルは正方形の格子(角丸なし)で
// 隙間・重なりが出ないよう境界を整数座標で確定させてからクリップして描画する
const COMBINED_WIDTH = 720;
const COMBINED_HEIGHT = 1280; // 9:16

function combineImages(images, type) {
    return new Promise((resolve) => {
        const cols = type === 'portrait' ? 2 : 1;
        const rows = type === 'portrait' ? 2 : images.length;
        const canvas = document.createElement('canvas');
        canvas.width = COMBINED_WIDTH;
        canvas.height = COMBINED_HEIGHT;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const colBounds = Array.from({ length: cols + 1 }, (_, i) => Math.round((i * COMBINED_WIDTH) / cols));
        const rowBounds = Array.from({ length: rows + 1 }, (_, i) => Math.round((i * COMBINED_HEIGHT) / rows));

        let loaded = 0;
        images.forEach((src, i) => {
            const img = new Image();
            img.onload = () => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                const x = colBounds[col];
                const y = rowBounds[row];
                const cellW = colBounds[col + 1] - x;
                const cellH = rowBounds[row + 1] - y;
                const scale = Math.max(cellW / img.width, cellH / img.height);
                const dw = img.width * scale;
                const dh = img.height * scale;
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, cellW, cellH);
                ctx.clip(); // cover合わせではみ出す分が隣のセルへ描き込まれないようにする
                ctx.drawImage(img, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
                ctx.restore();
                loaded++;
                if (loaded === images.length) resolve(canvas.toDataURL('image/png'));
            };
            img.src = src;
        });
    });
}

let combinedImageDataUrl = null;

async function runLayoutStep() {
    // 撮影は全て完了したので、この先(グリッド演出〜サンクス)はライブのAR合成が不要になる。
// 最も重い顔検出の推論とカメラストリームをここで止めて、残りの操作中のCPU・バッテリー消費を減らす
    arEngine.shutdownCamera();

    showScreen('layout');
    layoutNextBtn.hidden = true;
    layoutGrid.classList.remove('spin-once');
    layoutGrid.innerHTML = '';
    const cols = sessionType === 'portrait' ? 2 : 1;
    layoutGrid.setAttribute('data-cols', String(cols));

    capturedShots.forEach((shot) => {
        const cell = document.createElement('div');
        cell.className = 'layout_grid_cell';
        const img = document.createElement('img');
        img.src = shot.dataUrl;
        img.alt = '';
        cell.appendChild(img);
        layoutGrid.appendChild(cell);
    });

    const cells = Array.from(layoutGrid.children);
    for (let i = 0; i < cells.length; i++) {
        await sleep(220);
        cells[i].classList.add('show');
    }
    await sleep(400);

    // 選手カードの「完成」演出で使っていた回転(ひとひねり)だけを、グリッド全体の仕上げとして流用する
    await spinElement(layoutGrid);
    layoutNextBtn.hidden = false;

    combinedImageDataUrl = await combineImages(capturedShots.map((s) => s.dataUrl), sessionType);
}

layoutNextBtn.addEventListener('click', () => {
    runThanksStep();
});

// ---- サンクス→保存→メール送信(任意)→ギャラリーへ遷移 ----
// auto/ と異なり、ここでは送信完了かスキップが選ばれるまで自動では戻らない
// (ユーザーがメールアドレスを入力・送信する猶予を奪わないため)。
async function runThanksStep() {
    showScreen('thanks');

    try {
        await saveSession({
            type: sessionType,
            individualImages: capturedShots.map((s) => s.dataUrl),
            combinedImage: combinedImageDataUrl,
            playerCardImage: null,
        });
    } catch (err) {
        console.error('セッションの保存に失敗しました: ', err);
    }

    setupEmailSendUI();
}

function buildFinalEmail(rawInput) {
    const value = rawInput.trim();
    if (!value) return '';
    return value.includes('@') ? value : `${value}${EMAIL_DEFAULT_DOMAIN}`;
}

function showEmailStatus(message, kind) {
    emailStatusMsg.textContent = message;
    emailStatusMsg.hidden = !message;
    emailStatusMsg.classList.remove('email_status_msg-error', 'email_status_msg-success');
    if (kind) emailStatusMsg.classList.add(`email_status_msg-${kind}`);
}

let emailSendUiBound = false;
function setupEmailSendUI() {
    emailInput.value = '';
    emailDomainSuffix.hidden = false;
    showEmailStatus('', null);
    emailSendBtn.disabled = false;
    emailSendBtn.textContent = '写真をメールで受け取る';

    if (emailSendUiBound) return; // リスナーの多重登録を防ぐ(このページ内では撮影セッションは1回のみだが念のため)
    emailSendUiBound = true;

    emailInput.addEventListener('input', () => {
        emailDomainSuffix.hidden = emailInput.value.includes('@');
    });

    emailSkipBtn.addEventListener('click', () => {
        arEngine.saveOrientationStateForOwnReload();
        redirectWithToken('../');
    });

    emailSendBtn.addEventListener('click', async () => {
        const finalEmail = buildFinalEmail(emailInput.value);
        if (!finalEmail || !EMAIL_RE.test(finalEmail)) {
            showEmailStatus('メールアドレスを正しく入力してください。', 'error');
            return;
        }

        emailSendBtn.disabled = true;
        emailSendBtn.textContent = '送信中...';
        emailSkipBtn.hidden = true; // 送信操作を始めたら、スキップしてのやり直しは一旦封じる
        showEmailStatus('', null);

        const token = new URLSearchParams(window.location.search).get('token');

        try {
            // WorkerはToken・メール形式・画像の有無といった即座に確認できる検証だけ行い、
            // 実際のBrevo送信(数秒かかりうる)は裏側で継続する設計のため、ここでは
            // Workerが受理した時点(res.ok)で成功とみなしてよい(詳細はworker/src/index.js参照)。
            const res = await fetch(`${WORKER_BASE}/send-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token,
                    email: finalEmail,
                    images: {
                        combined: combinedImageDataUrl,
                        individual: capturedShots.map((s) => s.dataUrl),
                    },
                }),
            });
            const result = await res.json().catch(() => null);

            if (!res.ok || !result || result.success !== true) {
                throw new Error('send_failed');
            }

            showEmailStatus('写真を送信しました！\nありがとうございました！', 'success');
            emailSendBtn.hidden = true;
            await sleep(5000);
            arEngine.saveOrientationStateForOwnReload(); // 回転判定結果を次の読み込みへ引き継ぎ、初回判定のやり直しによる誤判定を防ぐ
            redirectWithToken('./'); // ギャラリー(/WebAR/)ではなく、次の人のために/school/自体へ戻す(IndexedDB保存は上のsaveSessionのまま)
        } catch (err) {
            console.error('メール送信に失敗しました: ', err);
            showEmailStatus('写真を送信できませんでした。\nメールアドレスを確認して、\nもう一度お試しください。', 'error');
            emailSendBtn.disabled = false;
            emailSendBtn.textContent = '写真をメールで受け取る';
            emailSkipBtn.hidden = false;
        }
    });
}

hideAllScreens();
boot();
