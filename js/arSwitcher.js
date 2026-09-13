// 複数のARマスクを指ドラッグ+慣性でめくって切り替えるカバーフロー風UI。
// 見た目・物理演算(ラバーバンド抵抗・速度の低域通過フィルタ・慣性による着地予測)はs.htmlの
// 実装をできるだけ変えずに移植し、向き(横並び/縦並び・左右・裏返し時の回転)だけを
// app.js側の端末回転状態に応じて後付けしている。
//
// アップロード画像の保存(IndexedDB)は起動速度に影響させないよう、initArSwitcherDeferred()
// 経由でアイドル時にだけ読み込む。ボタン等のイベント登録自体は軽量なので即時に行う。

const DB_NAME = 'webar_ar_masks_db';
const DB_VERSION = 1;
const MASKS_STORE = 'masks'; // { id(auto), createdAt, blob(1024x1024フル), thumbBlob(縮小版) }

const ITEM_SIZE = 56;
const GAP_SIZE = 10;
const STEP_SIZE = ITEM_SIZE + GAP_SIZE; // 項目は正方形固定なので向きが変わっても共通

const switcherEl = document.getElementById('ar_switcher');
const frameEl = document.getElementById('ar_switcher_frame');
const trackEl = document.getElementById('ar_switcher_track');
const uploadPopover = document.getElementById('ar_upload_popover');
const uploadBtn = document.getElementById('ar_upload_btn');
const uploadInput = document.getElementById('ar_upload_input');
const outputCanvas = document.getElementById('output_canvas');
const sharedToastEl = document.getElementById('toast');

let orientation = 'horizontal'; // 'horizontal' | 'vertical'
let currentIndex = 1; // 初期選択 = base.png(「+」の次)
let currentPos = -currentIndex * STEP_SIZE;

let isDragging = false;
let dragPointerId = null;
let dragDownTarget = null;
let dragStartCoord = 0;
let dragStartPos = 0;
let dragStartTime = 0;
let lastCoord = 0;
let lastTime = 0;
let velocity = 0;

let onMaskChangeCallback = null;
let dbPromise = null;
let masksLoadPromise = null;
let fullUrlCache = new Map(); // id -> object URL(フルサイズ、AR用)
let thumbUrlCache = new Map(); // id -> object URL(サムネイル用)

function totalSlides() {
    return trackEl.children.length;
}

function getCoord(e) {
    return orientation === 'horizontal' ? e.clientX : e.clientY;
}

function setTransform(pos) {
    trackEl.style.transform = orientation === 'horizontal' ? `translateX(${pos}px)` : `translateY(${pos}px)`;
}

// ---- 共有トースト(#toast)の簡易表示。ギャラリー側と表示ロジックは独立させている ----
let sharedToastTimer = null;
function showLocalToast(message) {
    if (!sharedToastEl) return;
    sharedToastEl.textContent = message;
    sharedToastEl.classList.add('toast-show');
    clearTimeout(sharedToastTimer);
    sharedToastTimer = setTimeout(() => sharedToastEl.classList.remove('toast-show'), 2200);
}

// ---- IndexedDB(アップロードしたARマスクの保存) ----
function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB is not supported'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(MASKS_STORE)) {
                const store = db.createObjectStore(MASKS_STORE, { keyPath: 'id', autoIncrement: true });
                store.createIndex('createdAt', 'createdAt');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function dbAddMask(createdAt, blob, thumbBlob) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(MASKS_STORE, 'readwrite');
        const req = tx.objectStore(MASKS_STORE).add({ createdAt, blob, thumbBlob });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
}

function dbDeleteMask(id) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(MASKS_STORE, 'readwrite');
        tx.objectStore(MASKS_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function dbGetAllMasks() {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(MASKS_STORE, 'readonly');
        const req = tx.objectStore(MASKS_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

function dbGetMask(id) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(MASKS_STORE, 'readonly');
        const req = tx.objectStore(MASKS_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    }));
}

function ensureMasksLoaded() {
    if (masksLoadPromise) return masksLoadPromise;
    masksLoadPromise = (async () => {
        try {
            const records = await dbGetAllMasks();
            records.sort((a, b) => a.createdAt - b.createdAt);
            records.forEach((record) => appendUploadedItem(record));
        } catch (err) {
            console.error('ARマスクの読み込みに失敗しました: ', err);
        }
    })();
    return masksLoadPromise;
}

// アイドル時にDBを開いて既存のアップロード済みマスクを読み込む(起動速度に影響させないための遅延初期化)
export function initArSwitcherDeferred() {
    const run = () => { ensureMasksLoaded(); };
    if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 4000 });
    } else {
        setTimeout(run, 1500);
    }
}

// ---- DOM構築 ----
function createTrashIcon() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ar_switcher_trash_btn';
    btn.setAttribute('aria-label', 'このARを削除');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M4 7h16"/>'
        + '<path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>'
        + '<path d="M6 7l1 12.5A2 2 0 0 0 9 21h6a2 2 0 0 0 2-2.5L18 7"/>'
        + '</svg>';
    return btn;
}

function getOrCreateThumbUrl(record) {
    let url = thumbUrlCache.get(record.id);
    if (!url) {
        url = URL.createObjectURL(record.thumbBlob);
        thumbUrlCache.set(record.id, url);
    }
    return url;
}

function appendUploadedItem(record) {
    const item = document.createElement('div');
    item.className = 'ar_switcher_item';
    item.dataset.kind = 'mask';
    item.dataset.maskId = `upload:${record.id}`;

    const inner = document.createElement('div');
    inner.className = 'ar_switcher_item_inner';

    const img = document.createElement('img');
    img.alt = '';
    img.src = getOrCreateThumbUrl(record);
    inner.appendChild(img);
    item.appendChild(inner);
    item.appendChild(createTrashIcon());

    trackEl.appendChild(item);
}

async function getOrCreateFullUrl(id) {
    let url = fullUrlCache.get(id);
    if (url) return url;
    const record = await dbGetMask(id);
    if (!record) return null;
    url = URL.createObjectURL(record.blob);
    fullUrlCache.set(id, url);
    return url;
}

// ---- 選択の反映(「+」の位置ではARを切り替えない) ----
async function notifySelection() {
    const item = trackEl.children[currentIndex];
    if (!item || item.dataset.kind !== 'mask') return;
    const maskId = item.dataset.maskId;
    let url = null;
    if (maskId.startsWith('builtin:')) {
        url = `assets/${maskId.slice('builtin:'.length)}.png`;
    } else {
        const id = Number(maskId.slice('upload:'.length));
        url = await getOrCreateFullUrl(id);
    }
    if (url && onMaskChangeCallback) onMaskChangeCallback(url);
}

// app.js側からARマスク切り替え時に呼ばれるコールバックを登録する。登録時点の選択(初期状態はbase.png)を即通知する
export function setOnMaskChange(callback) {
    onMaskChangeCallback = callback;
    notifySelection();
}

// ---- 向き(横並び/縦並び・左右・裏返し回転)の切り替え。app.jsが端末回転状態に応じて呼ぶ ----
let lastAppliedLayoutKey = '';
export function setArSwitcherLayout({ orientation: newOrientation, side, rotateDeg }) {
    const key = `${newOrientation}|${side || ''}|${rotateDeg || 0}`;
    if (key === lastAppliedLayoutKey) return;
    lastAppliedLayoutKey = key;

    // 向き(-45~45/-45~-135/45~135/裏返し)が切り替わったら、タップで消していても再表示する。
    // 既に表示中の場合は何も変わらない(消えている時だけ意味のある操作になる)
    switcherEl.classList.remove('ar_switcher-hidden');

    orientation = newOrientation;
    switcherEl.setAttribute('data-orientation', newOrientation);
    switcherEl.setAttribute('data-side', side || '');
    switcherEl.setAttribute('data-rotate', rotateDeg === 90 ? 'cw' : (rotateDeg === -90 ? 'ccw' : 'none'));

    // 軸(横/縦)が切り替わった際、現在位置をアニメーションなしで新しい軸に即反映する
    trackEl.style.transition = 'none';
    currentPos = -currentIndex * STEP_SIZE;
    setTransform(currentPos);
    void trackEl.offsetWidth; // 強制リフローで位置を確定させてからtransitionを戻す
    trackEl.style.transition = '';
}

// ---- ドラッグ+慣性(s.htmlの物理演算を移植。軸(x/y)だけ可変にしている) ----
const RUBBER_BAND_FACTOR = 0.3;
const VELOCITY_LOW_PASS_OLD = 0.4;
const VELOCITY_LOW_PASS_NEW = 0.6;
const VELOCITY_THRESHOLD = 0.25;
const INERTIA_FACTOR = 200;
const SETTLE_TRANSITION = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
const TAP_MOVE_THRESHOLD = 8;
const TAP_TIME_THRESHOLD_MS = 350;

frameEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // 画像上でのネイティブドラッグ開始・テキスト選択を防ぐ(放置すると次回以降のドラッグが反応しなくなる)
    isDragging = true;
    dragPointerId = e.pointerId;
    dragDownTarget = e.target;
    trackEl.style.transition = 'none'; // ドラッグ中は遅延なく指に追従

    const coord = getCoord(e);
    dragStartCoord = coord;
    dragStartPos = currentPos;
    dragStartTime = performance.now();
    lastCoord = coord;
    lastTime = dragStartTime;
    velocity = 0;
    try { frameEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

frameEl.addEventListener('pointermove', (e) => {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    const coord = getCoord(e);
    const delta = coord - dragStartCoord;
    currentPos = dragStartPos + delta;

    // 両端でのラバーバンド(引っ張り抵抗)効果
    const minPos = -(totalSlides() - 1) * STEP_SIZE;
    const maxPos = 0;
    if (currentPos > maxPos) currentPos = currentPos * RUBBER_BAND_FACTOR;
    else if (currentPos < minPos) currentPos = minPos + (currentPos - minPos) * RUBBER_BAND_FACTOR;

    setTransform(currentPos);

    // 瞬時速度の測定(px/ms)。変化が急すぎないよう簡易ローパスフィルタを通す
    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
        const newVelocity = (coord - lastCoord) / dt;
        velocity = velocity * VELOCITY_LOW_PASS_OLD + newVelocity * VELOCITY_LOW_PASS_NEW;
        lastCoord = coord;
        lastTime = now;
    }
});

frameEl.addEventListener('pointerup', (e) => {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    isDragging = false;

    const dx = getCoord(e) - dragStartCoord;
    const dt = performance.now() - dragStartTime;
    const wasTap = Math.abs(dx) < TAP_MOVE_THRESHOLD && dt < TAP_TIME_THRESHOLD_MS;

    if (wasTap && dragDownTarget && dragDownTarget.closest('#ar_switcher_add_btn')) {
        setTransform(currentPos);
        openUploadPopover();
        return;
    }
    if (wasTap && dragDownTarget && dragDownTarget.closest('.ar_switcher_trash_btn')) {
        const item = dragDownTarget.closest('.ar_switcher_item');
        setTransform(currentPos);
        if (item) deleteUploadedItem(item);
        return;
    }
    // 上記以外の項目(枠に入っていない="peeking"中のものも含む)をタップした場合は、
    // その項目まで素早くスライドさせてそのままARとして選択する
    if (wasTap && dragDownTarget) {
        const tappedItem = dragDownTarget.closest('.ar_switcher_item');
        if (tappedItem) {
            const index = Array.from(trackEl.children).indexOf(tappedItem);
            if (index !== -1) {
                selectIndexWithAnimation(index);
                return;
            }
        }
    }

    finishDrag();
});

frameEl.addEventListener('pointercancel', () => {
    if (!isDragging) return;
    isDragging = false;
    finishDrag();
});

function finishDrag() {
    let targetIndex = currentIndex;

    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
        // 【複数枚の慣性スライド処理】速度に応じた移動距離(予測値)から目標インデックスを決定
        const predictedDistance = velocity * INERTIA_FACTOR;
        const projectedPos = currentPos + predictedDistance;
        targetIndex = Math.round(-projectedPos / STEP_SIZE);
        // フリックしたのに同じ位置にとどまらないよう、最低1枚は動かす補正
        if (targetIndex === currentIndex) {
            targetIndex = velocity < 0 ? currentIndex + 1 : currentIndex - 1;
        }
    } else {
        // 【ゆっくり動かした場合】現在枠に一番近い項目に吸着する
        targetIndex = Math.round(-currentPos / STEP_SIZE);
    }

    targetIndex = Math.max(0, Math.min(targetIndex, totalSlides() - 1));
    currentIndex = targetIndex;
    currentPos = -currentIndex * STEP_SIZE;

    trackEl.style.transition = SETTLE_TRANSITION;
    setTransform(currentPos);
    notifySelection();
}

// 項目を直接タップした時、その項目まで素早くスライドさせて選択する(ドラッグ慣性の0.5sより短い、機敏な動き)
const TAP_SELECT_TRANSITION = 'transform 0.28s cubic-bezier(0.25, 1, 0.5, 1)';
function selectIndexWithAnimation(index) {
    currentIndex = Math.max(0, Math.min(index, totalSlides() - 1));
    currentPos = -currentIndex * STEP_SIZE;
    trackEl.style.transition = TAP_SELECT_TRANSITION;
    setTransform(currentPos);
    notifySelection();
}

// ---- アップロード ----
let popoverOutsideHandler = null;
function openUploadPopover() {
    const rect = frameEl.getBoundingClientRect();
    const popoverWidth = 200 + 24; // 幅200px + padding分の概算
    uploadPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth))}px`;
    uploadPopover.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - 120)}px`;
    uploadPopover.hidden = false;

    popoverOutsideHandler = (e) => {
        if (uploadPopover.contains(e.target) || frameEl.contains(e.target)) return;
        closeUploadPopover();
    };
    document.addEventListener('click', popoverOutsideHandler, true);
}

let popoverJustClosedAt = 0;
function closeUploadPopover() {
    if (uploadPopover.hidden) return;
    uploadPopover.hidden = true;
    // このクリックがポップオーバーを閉じただけなのか、カメラ映像タップとして扱うべきかを見分けるための印
    popoverJustClosedAt = performance.now();
    if (popoverOutsideHandler) {
        document.removeEventListener('click', popoverOutsideHandler, true);
        popoverOutsideHandler = null;
    }
}

uploadBtn.addEventListener('click', () => {
    uploadInput.click();
});

uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files && uploadInput.files[0];
    uploadInput.value = '';
    closeUploadPopover();
    if (!file) return;
    try {
        await processAndStoreUpload(file);
    } catch (err) {
        console.error('ARマスクのアップロードに失敗しました: ', err);
        showLocalToast('アップロードに失敗しました');
    }
});

function loadBitmapOrImage(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });
}

function drawToSquareCanvas(source, size) {
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    // 正方形・透過画像であることを前提に、そのまま1024×1024へリサイズする(切り抜きはしない)
    canvas.getContext('2d').drawImage(source, 0, 0, w, h, 0, 0, size, size);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function processAndStoreUpload(file) {
    const source = await loadBitmapOrImage(file);
    const fullBlob = await drawToSquareCanvas(source, 1024);
    const thumbBlob = await drawToSquareCanvas(source, 120);
    if (source.close) source.close();

    await ensureMasksLoaded();
    const createdAt = Date.now();
    const id = await dbAddMask(createdAt, fullBlob, thumbBlob);
    appendUploadedItem({ id, createdAt, thumbBlob });
    showLocalToast('ARを追加しました');
}

async function deleteUploadedItem(itemEl) {
    const maskId = itemEl.dataset.maskId;
    const id = Number(maskId.slice('upload:'.length));
    const deletedDomIndex = Array.from(trackEl.children).indexOf(itemEl);
    const wasActive = deletedDomIndex === currentIndex;

    try {
        await dbDeleteMask(id);
    } catch (err) {
        console.error('ARマスクの削除に失敗しました: ', err);
        showLocalToast('削除に失敗しました');
        return;
    }

    const fullUrl = fullUrlCache.get(id);
    if (fullUrl) { URL.revokeObjectURL(fullUrl); fullUrlCache.delete(id); }
    const thumbUrl = thumbUrlCache.get(id);
    if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrlCache.delete(id); }

    itemEl.remove();

    if (deletedDomIndex < currentIndex) {
        currentIndex -= 1;
    }
    currentIndex = Math.min(currentIndex, totalSlides() - 1);

    if (wasActive) {
        currentIndex = 1; // 使用中のARを消した場合はbase.pngへ戻す
    }
    currentPos = -currentIndex * STEP_SIZE;

    trackEl.style.transition = SETTLE_TRANSITION;
    setTransform(currentPos);
    if (wasActive) notifySelection();
}

// ---- カメラ映像部分タップでの表示切り替え ----
// アップロードのポップオーバーが開いている状態でのタップは、外側クリック検知(popoverOutsideHandler)が
// 先に(キャプチャフェーズで)ポップオーバーだけを閉じるので、続くこのクリックでは切り替えを行わない
const CANVAS_TAP_IGNORE_WINDOW_MS = 50;
outputCanvas.addEventListener('click', () => {
    if (performance.now() - popoverJustClosedAt < CANVAS_TAP_IGNORE_WINDOW_MS) return;
    switcherEl.classList.toggle('ar_switcher-hidden');
});
