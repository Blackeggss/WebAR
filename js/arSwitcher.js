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

// スイッチャーより手前に重なって表示され得る他のUI。座標だけで判定するとこれらの背後にある
// ARアイテムへタップが貫通してしまうため、pointerdown時にこれらの内部が押されていたら
// スイッチャー側の操作は一切開始しない(このUI自身の操作を優先させる)
const blockingOverlayEls = [
    document.getElementById('ar_upload_popover'),
    document.getElementById('gallery_overlay'),
    document.getElementById('camera_picker'),
    document.getElementById('motion_permission_overlay'),
].filter(Boolean);

function isPointerOnBlockingOverlay(target) {
    return blockingOverlayEls.some((el) => el.contains(target));
}

let orientation = 'horizontal'; // 'horizontal' | 'vertical'
let currentIndex = 1; // 初期選択 = base.png(「+」の次)
let currentPos = -currentIndex * STEP_SIZE;

let isDragging = false;
let dragPointerId = null;
let dragDownItem = null; // pointerdown時に実際に画面上で触れていた.ar_switcher_item(座標判定で決定)
let dragDownIsTrash = false; // dragDownItem内のゴミ箱ボタンを触れていたか
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

// トラックが慣性/選択アニメーション(CSSトランジション)の途中の時に読み取ると、今実際に
// 描画されている(中間の)位置を返す。style.transformが持つ「最終目標値」とは異なるため、
// 新しいドラッグをアニメーション再生中に始めた際、この値を使わずにtransitionだけ切ると
// 見た目が目標値へ一気にジャンプしてしまう(ジャンプ後にドラッグが始まる不具合)
function getCurrentVisualPos() {
    const matrix = getComputedStyle(trackEl).transform;
    if (!matrix || matrix === 'none') return currentPos;
    const match = matrix.match(/matrix\(([^)]+)\)/);
    if (!match) return currentPos;
    const parts = match[1].split(',').map((v) => parseFloat(v));
    return orientation === 'horizontal' ? parts[4] : parts[5];
}

// ---- 座標ベースのヒットテスト ----
// #ar_switcher_frame(56x56)はoverflow:visibleで、実際のARアイテムはその外側まではみ出して
// 表示されている。iOS Safari/Chromeでは、この「小さい親要素からoverflow:visibleではみ出した
// transformされた子要素」に対するpointerdownが、はみ出た部分では正しく発火しない(またはframeElまで
// 届かない)ことがあるため、frameElのpointerdownイベントだけに頼らず、document全体でpointerdownを
// 受け取ったうえで、実際に画面上のどこにARアイテムが描画されているか(getBoundingClientRect)を見て
// 判定する。これによりDOMのイベント発火・バブリングの信頼性に依存せず、見えている位置=触れる位置にできる
function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getVisualItemAtPoint(clientX, clientY) {
    const items = trackEl.children;
    for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (isPointInRect(clientX, clientY, rect)) return item;
    }
    return null;
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

    // button要素にしているのは、iOS Safariでoverflow:visibleにより枠外へはみ出たdiv/imgへの
    // タップ・ドラッグ開始が正しく認識されない問題への対策(「+」ボタンだけは枠外でも操作できていたため)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ar_switcher_item_btn';
    btn.setAttribute('aria-label', 'このARを選択');

    const inner = document.createElement('span');
    inner.className = 'ar_switcher_item_inner';

    const img = document.createElement('img');
    img.alt = '';
    img.src = getOrCreateThumbUrl(record);
    inner.appendChild(img);
    btn.appendChild(inner);
    item.appendChild(btn);
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

    // 開いたままだと、切り替わり前の向きを基準にした位置のまま取り残されてしまうため閉じる
    closeUploadPopover();

    orientation = newOrientation;
    switcherEl.setAttribute('data-orientation', newOrientation);
    switcherEl.setAttribute('data-side', side || '');
    let rotateAttr = 'none';
    if (rotateDeg === 90) rotateAttr = 'cw';
    else if (rotateDeg === -90) rotateAttr = 'ccw';
    else if (rotateDeg === 180 || rotateDeg === -180) rotateAttr = 'flip';
    switcherEl.setAttribute('data-rotate', rotateAttr);

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
const INERTIA_FACTOR = 150;
const SETTLE_TRANSITION = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
const TAP_MOVE_THRESHOLD = 8;
const TAP_TIME_THRESHOLD_MS = 350;

// frameEl単体ではなくdocument全体でpointerdownを受け取り、座標で判定する(理由は上記コメント参照)。
// ドラッグ開始の可否は「trackEl全体(項目同士の隙間も含む)に触れたか」で判定し、隙間を
// つまんでもドラッグが始まるようにする。個々のアイテム(getVisualItemAtPoint)は、タップ判定
// (どの項目を選択/削除するか)のためだけに別途使う(隙間をタップした場合はnullのままでよい)。
// 該当領域外(スイッチャーと無関係な場所への操作)の場合は何もせず抜け、他の操作を妨げない。
function onSwitcherPointerDown(e) {
    // ポップオーバー・ギャラリー等、スイッチャーより手前に重なる別のUIの操作中は、
    // 座標が偶然ARアイテムと重なっていてもスイッチャー側の操作を始めない(タップの貫通防止)
    if (isPointerOnBlockingOverlay(e.target)) return;

    const trackRect = trackEl.getBoundingClientRect();
    if (!isPointInRect(e.clientX, e.clientY, trackRect)) return;

    e.preventDefault(); // 画像上でのネイティブドラッグ開始・テキスト選択を防ぐ
    isDragging = true;
    dragPointerId = e.pointerId;
    dragDownItem = getVisualItemAtPoint(e.clientX, e.clientY); // 隙間の場合はnull(タップ判定でのみ使用)

    dragDownIsTrash = false;
    if (dragDownItem) {
        const trashBtn = dragDownItem.querySelector('.ar_switcher_trash_btn');
        dragDownIsTrash = !!(trashBtn && isPointInRect(e.clientX, e.clientY, trashBtn.getBoundingClientRect()));
    }

    // 前の慣性/選択アニメーションの再生中に新しいドラッグを始めた場合、見た目の位置(中間値)を
    // そのまま引き継ぐ(そうしないとtransition解除の瞬間に最終目標値へジャンプして見えてしまう)
    currentPos = getCurrentVisualPos();
    trackEl.style.transition = 'none'; // ドラッグ中は遅延なく指に追従
    setTransform(currentPos);

    const coord = getCoord(e);
    dragStartCoord = coord;
    dragStartPos = currentPos;
    dragStartTime = performance.now();
    lastCoord = coord;
    lastTime = dragStartTime;
    velocity = 0;
}

function onSwitcherPointerMove(e) {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    e.preventDefault(); // ドラッグ中にページがスクロール/バウンスしないようにする
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
}

function onSwitcherPointerUp(e) {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    isDragging = false;

    const dx = getCoord(e) - dragStartCoord;
    const dt = performance.now() - dragStartTime;
    const wasTap = Math.abs(dx) < TAP_MOVE_THRESHOLD && dt < TAP_TIME_THRESHOLD_MS;
    const tappedItem = dragDownItem;
    const tappedIsTrash = dragDownIsTrash;
    dragDownItem = null;
    dragDownIsTrash = false;

    if (wasTap && tappedItem) {
        if (tappedIsTrash) {
            setTransform(currentPos);
            deleteUploadedItem(tappedItem);
            return;
        }
        if (tappedItem.dataset.kind === 'add') {
            // 「+」がどこにあっても(枠に入っていなくても)白枠まで素早くスライドさせてから開く
            const addIndex = Array.from(trackEl.children).indexOf(tappedItem);
            if (addIndex !== -1) selectIndexWithAnimation(addIndex);
            else setTransform(currentPos);
            openUploadPopover();
            return;
        }
        // 上記以外の項目(枠に入っていない="peeking"中のものも含む)をタップした場合は、
        // その項目まで素早くスライドさせてそのままARとして選択する
        const index = Array.from(trackEl.children).indexOf(tappedItem);
        if (index !== -1) {
            selectIndexWithAnimation(index);
            return;
        }
    }

    finishDrag();
}

function onSwitcherPointerCancel(e) {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    isDragging = false;
    dragDownItem = null;
    dragDownIsTrash = false;
    finishDrag();
}

document.addEventListener('pointerdown', onSwitcherPointerDown, { passive: false });
document.addEventListener('pointermove', onSwitcherPointerMove, { passive: false });
document.addEventListener('pointerup', onSwitcherPointerUp);
document.addEventListener('pointercancel', onSwitcherPointerCancel);

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
    closePopoverIfNotOnAdd();
    notifySelection();
}

// 項目を直接タップした時、その項目まで素早くスライドさせて選択する(ドラッグ慣性の0.5sより短い、機敏な動き)
const TAP_SELECT_TRANSITION = 'transform 0.28s cubic-bezier(0.25, 1, 0.5, 1)';
function selectIndexWithAnimation(index) {
    currentIndex = Math.max(0, Math.min(index, totalSlides() - 1));
    currentPos = -currentIndex * STEP_SIZE;
    trackEl.style.transition = TAP_SELECT_TRANSITION;
    setTransform(currentPos);
    closePopoverIfNotOnAdd();
    notifySelection();
}

// スライドして「+」以外が白枠に入ったら、開いたままの「画像をアップロード」ポップオーバーを閉じる
function closePopoverIfNotOnAdd() {
    if (uploadPopover.hidden) return;
    const item = trackEl.children[currentIndex];
    if (!item || item.dataset.kind !== 'add') closeUploadPopover();
}

// ---- アップロード ----
let popoverOutsideHandler = null;
function openUploadPopover() {
    // 既に開いている場合は何もしない(「+」を連打すると外側クリック監視が何重にも登録され、
    // 最後に1つ閉じても残りが document に張り付いたままになる不具合があったため)
    if (!uploadPopover.hidden) return;

    const rect = frameEl.getBoundingClientRect();
    const popoverWidth = 200 + 24; // 幅200px + padding分の概算
    uploadPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth))}px`;
    uploadPopover.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - 120)}px`;
    uploadPopover.hidden = false;

    popoverOutsideHandler = (e) => {
        if (uploadPopover.contains(e.target) || frameEl.contains(e.target)) return;
        closeUploadPopover(true);
    };
    document.addEventListener('click', popoverOutsideHandler, true);
}

let popoverJustClosedAt = 0;
// fromOutsideClick: 外側クリック検知(またはカメラ映像タップ)で閉じた場合だけtrueにする。
// スライド操作で自動的に閉じた場合(closePopoverIfNotOnAdd)まで含めてしまうと、その直後の
// 無関係なカメラ映像タップがCANVAS_TAP_IGNORE_WINDOW_MS内で誤って無視されてしまうため区別している
function closeUploadPopover(fromOutsideClick) {
    if (uploadPopover.hidden) return;
    uploadPopover.hidden = true;
    if (fromOutsideClick) {
        // このクリックがポップオーバーを閉じただけなのか、カメラ映像タップとして扱うべきかを見分けるための印
        popoverJustClosedAt = performance.now();
    }
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
