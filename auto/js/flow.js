// 自動撮影フローの状態管理。ポーズルーレット→AR自動装着+カウントダウン連続撮影→
// グリッドレイアウト演出→サンクス→既存ギャラリー(/WebAR/)へ遷移までを制御する。
// (auto_soccer/ の選手カード作成機能を除いたバージョン)

import * as arEngine from './arEngine.js';
import { saveSession } from './db.js';
import { ensureAuthorized } from '../../js/auth-gate.js';

if (!(await ensureAuthorized())) {
    throw new Error('WebAR: 認証されていないため起動を中止しました');
}

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

const POSES = [
    'ピース ✌️',
    '顎下ピース ✌️',
    '顔の横でハート 🫶',
    '虫歯ポーズ（頬に手をあてる） 😃',
    'ギャルピース ✌️',
    '指ハート 🫰',
];
const AR_MASKS = [
    'ar_fox.png', 'ar_soccer.png', 'ar_momonga.png', 'ar_myakumyaku_1.png', 'ar_myakumyaku_2.png',
    'ar_rabbit.png', 'ar_redpanda.png', 'ar_seiren.png', 'ar_squirrel.png', 'ar_usagi.png', 'ar_vermeer.png',
].map((f) => `../assets/auto/${f}`);
const FINAL_MASK = '../assets/auto/ar_soccer.png'; // 最後の1枚(ポーズ自由)はauto_soccer/と同じくAR固定
const PRAISE_TEXTS = ['最高！', 'バッチリ！', 'いいね！', 'ナイスショット！'];

let shotCount = 4; // 縦4枚 / 横・PC3枚
let sessionType = 'portrait';
let posePool = [];
let maskPool = [];
const capturedShots = []; // { dataUrl }

// 端末の向きだけで決まる縦/横は起動直後にわかるので、ポーズ・ARの抽選もここで済ませておく。
// こうすることで「どの画像が必要か」が早期に確定し、カメラ/モデルの読み込みが終わった後に
// 必要な分だけ先読み(preloadSessionAssets)できるようにする
// 通常ショット用のARプールを作る: 最終カット専用のFINAL_MASKは重複して出さないよう除外し、
// ar_myakumyaku_1/2は似た2種類なのでどちらか一方だけをこのセッションで使うようにする
function buildMaskPool() {
    let pool = AR_MASKS.filter((url) => url !== FINAL_MASK);
    const myaku1 = pool.find((url) => url.endsWith('ar_myakumyaku_1.png'));
    const myaku2 = pool.find((url) => url.endsWith('ar_myakumyaku_2.png'));
    if (myaku1 && myaku2) {
        const dropped = Math.random() < 0.5 ? myaku1 : myaku2;
        pool = pool.filter((url) => url !== dropped);
    }
    return shuffleArray(pool);
}

function decideSessionPlan() {
    sessionType = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
    shotCount = sessionType === 'portrait' ? 4 : 3;
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

// このセッションで実際に使う分だけ(最終カット含め縦4枚/横3枚)を先読みする。5種類全部ではなく
// 使う分だけに絞ることでダウンロード量を減らす。カメラ・モデルの帯域と取り合わないよう、
// それらの読み込みが終わった後に呼ぶ(boot()参照)。完了を待つ必要はないのでawaitしない
function preloadSessionAssets() {
    for (let i = 0; i < shotCount - 1; i++) {
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

// ---- 起動 ----
async function boot() {
    decideSessionPlan(); // ポーズ・ARの抽選だけ先に済ませておく(この時点ではまだ画像を読み込まない)

    arLoadingEl.classList.add('ar_loading-show');
    try {
        await arEngine.initArEngine(video, outputCanvas);
    } catch (err) {
        console.error('AR初期化に失敗しました: ', err);
        showToast('カメラを起動できませんでした');
        return;
    }
    // 1枚目で実際に使うARの読み込みが終わるまでは、AR読み込み中の表示を残しておく
    // (カメラ・モデルだけ準備できてもマスク画像が白いまま次に進めてしまわないようにするため)
    await arEngine.setMaskUrl(maskPool[0]);
    arLoadingEl.classList.remove('ar_loading-show');

    // カメラ・AIモデルの読み込みが終わってから先読みを始める(帯域を取り合わないようにするため)
    preloadSessionAssets();

    if (arEngine.needsMotionPermission) {
        const started = await arEngine.tryStartSensorsAutomatically();
        if (!started) {
            await showTapToStart();
        }
    }

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
    flashEffect();
    const result = await arEngine.capturePhoto();
    await sleep(150);
    return result;
}

async function runPreviewStep(dataUrl) {
    showScreen('preview');
    previewImg.src = dataUrl;
    praiseLabel.textContent = pickRandom(PRAISE_TEXTS);
    await sleep(4000);
}

// ---- 撮影シーケンス全体 ----
async function runSequence() {
    // sessionType/shotCount/posePool/maskPoolはboot()内のdecideSessionPlan()で決定済み。
    // 最終カット(ポーズ自由)はauto_soccer/と同じくARをFINAL_MASKに固定する
    capturedShots.length = 0;

    for (let i = 0; i < shotCount; i++) {
        const isFirst = i === 0;
        const isFinal = i === shotCount - 1;
        const pose = isFinal ? null : posePool[i];
        const maskUrl = isFinal ? FINAL_MASK : maskPool[i];

        await runPoseStep(isFirst, isFinal, pose, maskUrl);
        await runArReadyStep();
        const { dataUrl } = await runCountdownAndCapture(isFinal);
        capturedShots.push({ dataUrl });
        await runPreviewStep(dataUrl);
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

// ---- サンクス→保存→ギャラリーへ遷移 ----
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

    await sleep(1500);
    window.location.href = '../';
}

hideAllScreens();
boot();
