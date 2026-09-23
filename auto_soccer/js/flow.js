// 自動撮影フローの状態管理(企画書2〜3.6節)。ポーズルーレット→AR自動装着+カウントダウン連続撮影→
// グリッドレイアウト演出→選手カード作成→完成演出→サンクス→既存ギャラリー(/WebAR/)へ遷移までを制御する。

import * as arEngine from './arEngine.js';
import * as card from './card.js';
import { saveSession } from './db.js';

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
    card_builder: document.getElementById('screen_card_builder'),
    card_reveal: document.getElementById('screen_card_reveal'),
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
const cardBuilderSlot = document.getElementById('card_builder_slot');
const cardRevealSlot = document.getElementById('card_reveal_slot');
const cardFormSidebar = document.getElementById('card_form_sidebar');
const inputNickname = document.getElementById('input_nickname');
const inputGradeClass = document.getElementById('input_grade_class');
const inputAnimal = document.getElementById('input_animal');
const inputSkill = document.getElementById('input_skill');
const cardCompleteBtn = document.getElementById('card_complete_btn');
const confettiCanvas = document.getElementById('confetti_canvas');
const revealNextBtn = document.getElementById('reveal_next_btn');
const startBtn = document.getElementById('start_btn');
const isMobileLayout = matchMedia('(pointer: coarse)').matches;
const portraitMql = matchMedia('(orientation: portrait)');

const POSES = [
    'ダブルピース ✌️✌️',
    'ガッツポーズ 💪',
    '顔の横でハート 🫶',
    '虫歯ポーズ（頬に手をあてる） 😃',
    'とびきりの笑顔 😊',
    '指ハート 🫰',
];
const AR_MASKS = [
    'ar_fox.png', 'ar_soccer.png', 'ar_momonga.png', 'ar_myakumyaku_1.png', 'ar_myakumyaku_2.png',
    'ar_rabbit.png', 'ar_redpanda.png', 'ar_seiren.png', 'ar_squirrel.png', 'ar_usagi.png', 'ar_vermeer.png',
].map((f) => `../assets/auto/${f}`);
const FINAL_MASK = '../assets/auto/ar_soccer.png';
const PRAISE_TEXTS = ['最高！', 'バッチリ！', 'いいね！', 'ナイスショット！'];

let shotCount = 4; // 縦4枚 / 横・PC3枚
let sessionType = 'portrait';
let posePool = [];
let maskPool = [];
const capturedShots = []; // { dataUrl, faceRectsNormalized }

// 端末の向きだけで決まる縦/横は起動直後にわかるので、ポーズ・ARの抽選もここで済ませておく。
// こうすることで「どの画像が必要か」が早期に確定し、カメラ/モデルの読み込みと並行して
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
    arLoadingEl.classList.remove('ar_loading-show');

    // 「タップして開始」を押す前から、1枚目で実際に使うARを装着しておく(専用のプレースホルダー
    // 画像は使わない)。ここで早めに読み込み始めることで、開始画面が出る頃には表示が間に合いやすくなる
    arEngine.setMaskUrl(maskPool[0]);

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
        poseResultLabel.textContent = 'ポーズ自由！\nこれが最後の1枚です！\n*この写真がカードになります';
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
    // sessionType/shotCount/posePool/maskPoolはboot()内のdecideSessionPlan()で決定済み
    capturedShots.length = 0;

    for (let i = 0; i < shotCount; i++) {
        const isFirst = i === 0;
        const isFinal = i === shotCount - 1;
        const pose = isFinal ? null : posePool[i];
        const maskUrl = isFinal ? FINAL_MASK : maskPool[i];

        await runPoseStep(isFirst, isFinal, pose, maskUrl);
        await runArReadyStep();
        const { dataUrl, faceRectsNormalized } = await runCountdownAndCapture(isFinal);
        capturedShots.push({ dataUrl, faceRectsNormalized });
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
    // 撮影は全て完了したので、この先(グリッド演出〜カード作成〜サンクス)はライブのAR合成が
    // 不要になる。最も重い顔検出の推論とカメラストリームをここで止めて、残りの操作中の
    // CPU・バッテリー消費を減らす
    arEngine.shutdownCamera();

    showScreen('layout');
    layoutNextBtn.hidden = true;
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
    layoutNextBtn.hidden = false;

    combinedImageDataUrl = await combineImages(capturedShots.map((s) => s.dataUrl), sessionType);
}

layoutNextBtn.addEventListener('click', () => {
    runCardBuilderStep();
});

// ---- 選手カード作成 ----
let cardEl = null;
let cardData = null;

// スペシャルスキルの選択肢を一度だけ<select>に流し込む
card.SKILL_OPTIONS.forEach((skill) => {
    const opt = document.createElement('option');
    opt.value = skill;
    opt.textContent = skill;
    inputSkill.appendChild(opt);
});

// PC/横画面用フォームの「元の置き場所」(スマホ埋め込みモードから戻す時の復帰先)を最初に覚えておく
const sidebarFieldContainers = {
    nickname: inputNickname.parentElement,
    gradeClass: inputGradeClass.parentElement,
    animal: inputAnimal.parentElement,
    skill: inputSkill.parentElement,
};
const cardFieldInputs = {
    nickname: inputNickname,
    gradeClass: inputGradeClass,
    animal: inputAnimal,
    skill: inputSkill,
};

// 横長セッションはそのまま中央クロップで4:3化、縦長セッションは検出した顔(複数人可)の縦方向中心を
// 基準に写真の全幅を使って4:3の横長帯を切り出す(顔にズームインする処理は行わない)
function preparePhotoForCard(dataUrl, faceRects) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const w = img.width;
            const h = img.height;
            const targetRatio = 4 / 3;
            let sx, sy, sw, sh;
            if (w / h >= targetRatio) {
                sh = h;
                sw = h * targetRatio;
                sx = (w - sw) / 2;
                sy = 0;
            } else {
                sw = w;
                sh = w / targetRatio;
                let cy = h / 2;
                if (faceRects && faceRects.length > 0) {
                    const ys = faceRects.map((r) => r.y * h);
                    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
                }
                sx = 0;
                sy = Math.max(0, Math.min(cy - sh / 2, h - sh));
            }
            const canvas = document.createElement('canvas');
            canvas.width = 800;
            canvas.height = 600;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
        };
        img.src = dataUrl;
    });
}

// スマホ縦画面: 入力欄をカード内の該当スロットへ埋め込む / PC・横画面: サイドバーへ戻す
// (同じinput/select要素をDOM移動するだけなので、値やイベントリスナーはそのまま保持される)
function applyCardFormLayout() {
    if (!cardEl) return;
    const embed = isMobileLayout && portraitMql.matches;
    cardFormSidebar.hidden = embed;
    Object.entries(cardFieldInputs).forEach(([role, input]) => {
        const target = embed ? cardEl.querySelector(`[data-role="${role}"]`) : sidebarFieldContainers[role];
        if (!target || input.parentElement === target) return;
        if (embed) target.textContent = '';
        target.appendChild(input);
    });
}

let cardLayoutResizeTimer = null;
function scheduleCardFormLayout() {
    clearTimeout(cardLayoutResizeTimer);
    cardLayoutResizeTimer = setTimeout(applyCardFormLayout, 150);
}
window.addEventListener('resize', scheduleCardFormLayout);
window.addEventListener('orientationchange', scheduleCardFormLayout);

async function runCardBuilderStep() {
    const lastShot = capturedShots[capturedShots.length - 1];
    const photoDataUrl = await preparePhotoForCard(lastShot.dataUrl, lastShot.faceRectsNormalized);

    // 総合値・ポジションはここで1回だけ決定し、以後の入力変更では再抽選しない
    cardData = {
        rating: card.randomRating(),
        position: card.randomPosition(),
        nickname: 'いつメンFC',
        gradeClass: '2年12組',
        animal: '柴犬',
        skill: card.SKILL_OPTIONS[0],
        photoDataUrl,
    };
    inputNickname.value = cardData.nickname;
    inputGradeClass.value = cardData.gradeClass;
    inputAnimal.value = cardData.animal;
    inputSkill.value = cardData.skill;

    cardEl = card.createCardElement();
    card.updateCardElement(cardEl, cardData);
    cardBuilderSlot.innerHTML = '';
    cardBuilderSlot.appendChild(cardEl);

    applyCardFormLayout();
    showScreen('card_builder');
}

function bindCardFieldInput(input, role, eventName) {
    input.addEventListener(eventName, () => {
        if (!cardEl) return;
        cardData[role] = input.value;
        card.updateCardElement(cardEl, cardData);
    });
}
bindCardFieldInput(inputNickname, 'nickname', 'input');
bindCardFieldInput(inputGradeClass, 'gradeClass', 'input');
bindCardFieldInput(inputAnimal, 'animal', 'input');
bindCardFieldInput(inputSkill, 'skill', 'change');

cardCompleteBtn.addEventListener('click', async () => {
    await runCardRevealStep();
});

// ---- カード完成演出 ----
// 入力欄は役目を終えたので、確定した値のプレーンテキストに戻してからカードを移動する
function finalizeCardFields() {
    Object.keys(cardFieldInputs).forEach((role) => {
        const slot = cardEl.querySelector(`[data-role="${role}"]`);
        const input = slot && slot.querySelector('input, select');
        if (input) slot.removeChild(input);
    });
    card.updateCardElement(cardEl, cardData);
    cardFormSidebar.hidden = true;
}

async function runCardRevealStep() {
    finalizeCardFields();
    showScreen('card_reveal');
    revealNextBtn.hidden = true;
    cardRevealSlot.innerHTML = '';
    cardRevealSlot.appendChild(cardEl);

    const stopConfetti = card.launchConfetti(confettiCanvas, 2600);
    await card.flipAndReveal(cardEl);
    await sleep(1200);
    revealNextBtn.hidden = false;
    setTimeout(() => stopConfetti && stopConfetti(), 2600);
}

revealNextBtn.addEventListener('click', () => {
    runThanksStep();
});

// ---- サンクス→保存→ギャラリーへ遷移 ----
async function runThanksStep() {
    showScreen('thanks');

    try {
        const playerCardImage = await card.rasterizeCard(cardData);
        await saveSession({
            type: sessionType,
            individualImages: capturedShots.map((s) => s.dataUrl),
            combinedImage: combinedImageDataUrl,
            playerCardImage,
        });
    } catch (err) {
        console.error('セッションの保存に失敗しました: ', err);
    }

    await sleep(1500);
    window.location.href = '../';
}

hideAllScreens();
boot();
