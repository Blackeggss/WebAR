// 撮影済み写真のIndexedDB永続化とギャラリービューア。
// 起動処理(カメラ・AR初期化)を遅延させないよう、DBオープンやサムネイル読み込みは
// initGalleryDeferred() 経由でアイドル時にだけ実行する。ボタン等のイベント登録自体は
// 軽量なのでモジュール読み込み時に済ませておき、常に反応できるようにしている。

const DB_NAME = 'webar_gallery_db';
const DB_VERSION = 1;
const PHOTOS_STORE = 'photos'; // { id(auto), createdAt, fileName, blob(フル解像度) }
const THUMBS_STORE = 'thumbs'; // { id(photosと同じid), createdAt, fileName, thumbBlob(縮小版) }
const THUMB_MAX_SIZE = 160;

const galleryBtn = document.getElementById('gallery_btn');
const galleryBtnThumb = document.getElementById('gallery_btn_thumb');
const galleryOverlay = document.getElementById('gallery_overlay');
const galleryStage = document.getElementById('gallery_stage');
const galleryMainImg = document.getElementById('gallery_main_img');
const galleryDateToast = document.getElementById('gallery_date_toast');
const galleryDateLine = document.getElementById('gallery_date_line');
const galleryTimeLine = document.getElementById('gallery_time_line');
const galleryDateBadgeDate = document.getElementById('gallery_date_badge_date');
const galleryDateBadgeTime = document.getElementById('gallery_date_badge_time');
const galleryThumbStrip = document.getElementById('gallery_thumb_strip');
const galleryDownloadBtn = document.getElementById('gallery_download_btn');
const galleryDeleteBtn = document.getElementById('gallery_delete_btn');
const galleryCloseBtn = document.getElementById('gallery_close_btn');
const galleryPrevArrowBtn = document.getElementById('gallery_prev_arrow_btn');
const galleryNextArrowBtn = document.getElementById('gallery_next_arrow_btn');
const sharedToastEl = document.getElementById('toast');

// メモリ上のサムネイル一覧(古い→新しい順)。フル解像度画像はDBから都度取得する。
let thumbList = [];
let currentIndex = -1;
let thumbUrlCache = new Map(); // id -> object URL
let mainImgObjectUrl = null;
let loadToken = 0;

let dbPromise = null;
let thumbListLoadPromise = null;

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
            if (!db.objectStoreNames.contains(PHOTOS_STORE)) {
                db.createObjectStore(PHOTOS_STORE, { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains(THUMBS_STORE)) {
                const thumbs = db.createObjectStore(THUMBS_STORE, { keyPath: 'id' });
                thumbs.createIndex('createdAt', 'createdAt');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function dbAddPhoto(createdAt, fileName, fullBlob, thumbBlob) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction([PHOTOS_STORE, THUMBS_STORE], 'readwrite');
        const addReq = tx.objectStore(PHOTOS_STORE).add({ createdAt, fileName, blob: fullBlob });
        addReq.onsuccess = () => {
            const id = addReq.result;
            tx.objectStore(THUMBS_STORE).add({ id, createdAt, fileName, thumbBlob });
        };
        tx.oncomplete = () => resolve(addReq.result);
        tx.onerror = () => reject(tx.error);
    }));
}

function dbDeletePhoto(id) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction([PHOTOS_STORE, THUMBS_STORE], 'readwrite');
        tx.objectStore(PHOTOS_STORE).delete(id);
        tx.objectStore(THUMBS_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function dbGetAllThumbs() {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(THUMBS_STORE, 'readonly');
        const req = tx.objectStore(THUMBS_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

function dbGetPhotoFull(id) {
    return getDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTOS_STORE, 'readonly');
        const req = tx.objectStore(PHOTOS_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    }));
}

// ---- 共有トースト(#toast)の簡易表示。カメラ側のトーストと表示ロジックは独立させている ----
let sharedToastTimer = null;
function showLocalToast(message) {
    if (!sharedToastEl) return;
    sharedToastEl.textContent = message;
    sharedToastEl.classList.add('toast-show');
    clearTimeout(sharedToastTimer);
    sharedToastTimer = setTimeout(() => sharedToastEl.classList.remove('toast-show'), 2200);
}

// ---- 日時表示: スマホ縦は常時表示バッジ、スマホ横/PCは画面最上部の一時トースト ----
let dateToastTimer = null;
function updateDateDisplays(createdAtMs) {
    const d = new Date(createdAtMs);
    const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`;
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    galleryDateBadgeDate.textContent = dateStr;
    galleryDateBadgeTime.textContent = timeStr;

    galleryDateLine.textContent = dateStr;
    galleryTimeLine.textContent = timeStr;
    galleryDateToast.classList.add('show');
    clearTimeout(dateToastTimer);
    dateToastTimer = setTimeout(() => galleryDateToast.classList.remove('show'), 2200);
}

function getOrCreateThumbUrl(meta) {
    let url = thumbUrlCache.get(meta.id);
    if (!url) {
        url = URL.createObjectURL(meta.thumbBlob);
        thumbUrlCache.set(meta.id, url);
    }
    return url;
}

function revokeThumbUrl(id) {
    const url = thumbUrlCache.get(id);
    if (url) {
        URL.revokeObjectURL(url);
        thumbUrlCache.delete(id);
    }
}

function updateGalleryButtonThumb() {
    if (thumbList.length === 0) {
        galleryBtn.classList.remove('has-photo');
        galleryBtnThumb.removeAttribute('src');
        return;
    }
    const latest = thumbList[thumbList.length - 1];
    galleryBtnThumb.src = getOrCreateThumbUrl(latest);
    galleryBtn.classList.add('has-photo');
}

function renderThumbStrip() {
    galleryThumbStrip.innerHTML = '';
    thumbList.forEach((meta, i) => {
        const btn = document.createElement('button');
        btn.className = 'gallery_thumb_item';
        btn.type = 'button';
        btn.setAttribute('aria-label', '撮影した写真を表示');
        if (i === currentIndex) btn.classList.add('selected');
        const img = document.createElement('img');
        img.src = getOrCreateThumbUrl(meta);
        img.alt = '';
        btn.appendChild(img);
        btn.addEventListener('click', () => {
            if (i === currentIndex) return;
            showPhotoAtIndex(i, i > currentIndex ? 1 : -1);
        });
        galleryThumbStrip.appendChild(btn);
    });
    scrollSelectedThumbIntoView();
}

function updateThumbStripSelection() {
    Array.from(galleryThumbStrip.children).forEach((el, i) => {
        el.classList.toggle('selected', i === currentIndex);
    });
    scrollSelectedThumbIntoView();
}

function scrollSelectedThumbIntoView() {
    const el = galleryThumbStrip.children[currentIndex];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function updateNavArrowState() {
    galleryPrevArrowBtn.disabled = currentIndex <= 0;
    galleryNextArrowBtn.disabled = currentIndex >= thumbList.length - 1;
}

// direction: 1=次(新しい方、右からスライドイン) / -1=前(古い方、左からスライドイン) / 0=アニメーションなし
async function loadFullImageForIndex(index, direction) {
    const meta = thumbList[index];
    if (!meta) return;
    const myToken = ++loadToken;
    const record = await dbGetPhotoFull(meta.id).catch(() => null);
    if (myToken !== loadToken || !record) return;
    const url = URL.createObjectURL(record.blob);
    const prevUrl = mainImgObjectUrl;

    if (direction !== 0) {
        galleryMainImg.style.transition = 'none';
        galleryMainImg.classList.remove('gallery_slide_from_right', 'gallery_slide_from_left');
        galleryMainImg.classList.add(direction > 0 ? 'gallery_slide_from_right' : 'gallery_slide_from_left');
        galleryMainImg.src = url;
        void galleryMainImg.offsetWidth; // 強制リフローで開始位置を確定させる
        galleryMainImg.style.transition = '';
        requestAnimationFrame(() => {
            galleryMainImg.classList.remove('gallery_slide_from_right', 'gallery_slide_from_left');
        });
    } else {
        galleryMainImg.src = url;
    }

    mainImgObjectUrl = url;
    if (prevUrl) URL.revokeObjectURL(prevUrl);
}

function showPhotoAtIndex(index, direction = 0) {
    if (index < 0 || index >= thumbList.length) return;
    currentIndex = index;
    resetDeleteConfirm();
    loadFullImageForIndex(index, direction);
    updateThumbStripSelection();
    updateNavArrowState();
    updateDateDisplays(thumbList[index].createdAt);
}

function showNextPhoto() {
    if (currentIndex < thumbList.length - 1) showPhotoAtIndex(currentIndex + 1, 1);
}

function showPrevPhoto() {
    if (currentIndex > 0) showPhotoAtIndex(currentIndex - 1, -1);
}

function toggleImmersive() {
    galleryOverlay.classList.toggle('immersive');
}

async function ensureThumbListLoaded() {
    if (thumbListLoadPromise) return thumbListLoadPromise;
    thumbListLoadPromise = (async () => {
        try {
            const records = await dbGetAllThumbs();
            records.sort((a, b) => a.createdAt - b.createdAt);
            thumbList = records;
            updateGalleryButtonThumb();
        } catch (err) {
            console.error('ギャラリーの読み込みに失敗しました: ', err);
        }
    })();
    return thumbListLoadPromise;
}

async function openGalleryViewer() {
    await ensureThumbListLoaded();
    if (thumbList.length === 0) {
        showLocalToast('まだ撮影した写真がありません');
        return;
    }
    galleryOverlay.hidden = false;
    galleryOverlay.classList.remove('immersive');
    renderThumbStrip();
    showPhotoAtIndex(thumbList.length - 1);
}

function closeGalleryViewer() {
    galleryOverlay.hidden = true;
    galleryOverlay.classList.remove('immersive');
    resetDeleteConfirm();
}

// ---- 削除確認 ----
let deleteConfirmTimer = null;
function resetDeleteConfirm() {
    clearTimeout(deleteConfirmTimer);
    galleryDeleteBtn.classList.remove('confirm');
}

function onDeleteBtnClick() {
    if (!galleryDeleteBtn.classList.contains('confirm')) {
        galleryDeleteBtn.classList.add('confirm');
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = setTimeout(resetDeleteConfirm, 3000);
        return;
    }
    resetDeleteConfirm();
    deleteCurrentPhoto();
}

async function deleteCurrentPhoto() {
    const meta = thumbList[currentIndex];
    if (!meta) return;
    try {
        await dbDeletePhoto(meta.id);
    } catch (err) {
        console.error('写真の削除に失敗しました: ', err);
        showLocalToast('削除に失敗しました');
        return;
    }
    revokeThumbUrl(meta.id);
    thumbList.splice(currentIndex, 1);
    updateGalleryButtonThumb();
    if (thumbList.length === 0) {
        closeGalleryViewer();
        return;
    }
    currentIndex = Math.min(currentIndex, thumbList.length - 1);
    renderThumbStrip();
    showPhotoAtIndex(currentIndex);
}

function triggerBlobDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 写真フォルダへの保存を促すため、可能な場合は共有シート(Web Share API)を優先する
async function downloadCurrentPhoto() {
    const meta = thumbList[currentIndex];
    if (!meta) return;
    const record = await dbGetPhotoFull(meta.id).catch(() => null);
    if (!record) {
        showLocalToast('保存に失敗しました');
        return;
    }

    const file = new File([record.blob], meta.fileName, { type: record.blob.type || 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file] });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
        }
    }

    triggerBlobDownload(record.blob, meta.fileName);
    showLocalToast('ダウンロードしました');
}

// ---- サムネイル生成 ----
function loadBitmapOrImage(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });
}

function makeThumbBlob(source) {
    const srcW = source.width || source.naturalWidth;
    const srcH = source.height || source.naturalHeight;
    const scale = Math.min(1, THUMB_MAX_SIZE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
}

// アプリ本体から、撮影完了(共有/ダウンロード等の既存処理が終わった後)の最後に呼ばれる。
// 失敗してもカメラ機能自体には影響させない。
export async function capturePhotoForGallery(blob, fileName, createdAtMs) {
    try {
        await ensureThumbListLoaded();
        const source = await loadBitmapOrImage(blob);
        const thumbBlob = await makeThumbBlob(source);
        if (source.close) source.close();
        const id = await dbAddPhoto(createdAtMs, fileName, blob, thumbBlob);
        thumbList.push({ id, createdAt: createdAtMs, fileName, thumbBlob });
        // 連続撮影時に非同期処理の完了順がずれても古い→新しいの並びを保つ
        thumbList.sort((a, b) => a.createdAt - b.createdAt);
        updateGalleryButtonThumb();
        if (!galleryOverlay.hidden) {
            renderThumbStrip();
            updateNavArrowState();
        }
    } catch (err) {
        console.error('写真のギャラリー保存に失敗しました: ', err);
    }
}

// アイドル時にDBを開いて既存の写真一覧を読み込む(起動速度に影響させないための遅延初期化)
export function initGalleryDeferred() {
    const run = () => { ensureThumbListLoaded(); };
    if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 4000 });
    } else {
        setTimeout(run, 1500);
    }
}

// ---- イベント登録(軽量なので即時に行い、ボタンは常に反応できるようにする) ----
galleryBtn.addEventListener('click', openGalleryViewer);
galleryCloseBtn.addEventListener('click', closeGalleryViewer);
galleryDownloadBtn.addEventListener('click', downloadCurrentPhoto);
galleryDeleteBtn.addEventListener('click', onDeleteBtnClick);
galleryPrevArrowBtn.addEventListener('click', showPrevPhoto);
galleryNextArrowBtn.addEventListener('click', showNextPhoto);

// ---- 画像エリアのタップ(没入モード切替)・スワイプ(前後の写真へ) ----
const SWIPE_DISTANCE_THRESHOLD = 40;
const TAP_MOVE_THRESHOLD = 10;
const TAP_TIME_THRESHOLD_MS = 400;

let dragActive = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartT = 0;
let dragPointerId = null;

galleryStage.addEventListener('pointerdown', (e) => {
    if (thumbList.length === 0) return;
    dragActive = true;
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartT = performance.now();
    try { galleryStage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

galleryStage.addEventListener('pointerup', (e) => {
    if (!dragActive || e.pointerId !== dragPointerId) return;
    dragActive = false;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const dt = performance.now() - dragStartT;

    if (Math.abs(dx) >= SWIPE_DISTANCE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) showNextPhoto();
        else showPrevPhoto();
    } else if (Math.abs(dx) < TAP_MOVE_THRESHOLD && Math.abs(dy) < TAP_MOVE_THRESHOLD && dt < TAP_TIME_THRESHOLD_MS) {
        toggleImmersive();
    }
});

galleryStage.addEventListener('pointercancel', () => {
    dragActive = false;
});
