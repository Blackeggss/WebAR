// 撮影済み写真のIndexedDB永続化とギャラリービューア。
// 起動処理(カメラ・AR初期化)を遅延させないよう、DBオープンやサムネイル読み込みは
// initGalleryDeferred() 経由でアイドル時にだけ実行する。ボタン等のイベント登録自体は
// 軽量なのでモジュール読み込み時に済ませておき、常に反応できるようにしている。

const DB_NAME = 'webar_gallery_db';
const DB_VERSION = 1;
const PHOTOS_STORE = 'photos'; // { id(auto), createdAt, fileName, blob(フル解像度) }
const THUMBS_STORE = 'thumbs'; // { id(photosと同じid), createdAt, fileName, thumbBlob(縮小版) }
const THUMB_MAX_SIZE = 160;

// /auto/ (企画書の自動撮影フロー)が保存するセッション記録用の別DB。1レコード=1回の撮影セッションで、
// 個別写真(3〜4枚)・グリッド結合画像・選手カード画像をBase64(dataURL)のまま保持する。
// このギャラリーでは1レコードを「個別写真×N＋グリッド画像＋カード画像」の複数スライドに展開して表示する。
const SESSION_DB_NAME = 'WebARPhotoGalleryDB';
const SESSION_DB_VERSION = 1;
const SESSION_STORE_NAME = 'photos'; // { id(auto), createdAt, type, individualImages[], combinedImage, playerCardImage }

const galleryBtn = document.getElementById('gallery_btn');
const galleryBtnThumb = document.getElementById('gallery_btn_thumb');
const galleryOverlay = document.getElementById('gallery_overlay');
const galleryStage = document.getElementById('gallery_stage');
const galleryTrack = document.getElementById('gallery_track');
const galleryDateToast = document.getElementById('gallery_date_toast');
const galleryDateLine = document.getElementById('gallery_date_line');
const galleryTimeLine = document.getElementById('gallery_time_line');
const galleryDateBadgeDate = document.getElementById('gallery_date_badge_date');
const galleryDateBadgeTime = document.getElementById('gallery_date_badge_time');
const galleryThumbStrip = document.getElementById('gallery_thumb_strip');
const galleryDownloadBtn = document.getElementById('gallery_download_btn');
const galleryDeleteBtn = document.getElementById('gallery_delete_btn');
const galleryCloseBtn = document.getElementById('gallery_close_btn');
const galleryFirstVisitTip = document.getElementById('gallery_first_visit_tip');
const galleryBtnFirstVisitTip = document.getElementById('gallery_btn_first_visit_tip');
const galleryPrevArrowBtn = document.getElementById('gallery_prev_arrow_btn');
const galleryNextArrowBtn = document.getElementById('gallery_next_arrow_btn');
const sharedToastEl = document.getElementById('toast');

// メモリ上のサムネイル一覧(古い→新しい順)。フル解像度画像はDBから都度取得する。
let thumbList = [];
let currentIndex = -1;
let thumbUrlCache = new Map(); // id -> object URL(サムネイル用)
let fullUrlCache = new Map(); // id -> object URL(フル解像度、表示中の前後3枚だけキャッシュ)

// トラックの3枚のスライド要素を役割固定にせず使い回す。[0]=prev,[1]=current,[2]=nextの「役割」を保ちながら、
// 隣接した写真への移動時はDOM要素そのものをローテーションさせ、常に画面外側のスロットだけ非同期で差し替える
// (中央に表示中のスロットの中身を非同期処理中に書き換えないことで、切り替え時のチラつき・誤表示を防ぐ)
const gallerySlideStates = Array.from(galleryTrack.children).map((el) => ({
    el,
    img: el.querySelector('img'),
    index: undefined, // このスロットが表示しているthumbList上のインデックス(undefined=未設定, null=範囲外で空)
    token: 0,
}));

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

// ---- セッションDB(WebARPhotoGalleryDB/photos)。/auto/js/db.js が書き込む側で、ここでは読み取り・更新・削除のみ行う ----
let sessionDbPromise = null;
function getSessionDB() {
    if (sessionDbPromise) return sessionDbPromise;
    sessionDbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB is not supported'));
            return;
        }
        const req = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
                db.createObjectStore(SESSION_STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return sessionDbPromise;
}

function dbGetAllSessions() {
    return getSessionDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readonly');
        const req = tx.objectStore(SESSION_STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

function dbGetSessionRecord(id) {
    return getSessionDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readonly');
        const req = tx.objectStore(SESSION_STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    }));
}

function dbPutSessionRecord(record) {
    return getSessionDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readwrite');
        tx.objectStore(SESSION_STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function dbDeleteSessionRecord(id) {
    return getSessionDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readwrite');
        tx.objectStore(SESSION_STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((res) => res.blob());
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
    let url = thumbUrlCache.get(meta.uid);
    if (!url) {
        url = URL.createObjectURL(meta.thumbBlob);
        thumbUrlCache.set(meta.uid, url);
    }
    return url;
}

function revokeThumbUrl(uid) {
    const url = thumbUrlCache.get(uid);
    if (url) {
        URL.revokeObjectURL(url);
        thumbUrlCache.delete(uid);
    }
}

// ---- 単発写真(legacy)/セッション画像(session)どちらのmetaでも扱えるようにする共通ディスパッチ ----
async function getFullBlobForMeta(meta) {
    if (meta.kind === 'session') {
        const record = await dbGetSessionRecord(meta.sessionId);
        if (!record) return null;
        const dataUrl = meta.subType === 'individual' ? (record.individualImages || [])[meta.subIndex]
            : meta.subType === 'combined' ? record.combinedImage
            : record.playerCardImage;
        if (!dataUrl) return null;
        return dataUrlToBlob(dataUrl);
    }
    const record = await dbGetPhotoFull(meta.legacyId);
    return record ? record.blob : null;
}

// セッション内の1枚を削除する。残り0枚になったらレコードごと削除する
async function deleteMetaEntry(meta) {
    if (meta.kind !== 'session') {
        await dbDeletePhoto(meta.legacyId);
        return;
    }
    const record = await dbGetSessionRecord(meta.sessionId);
    if (!record) return;
    if (meta.subType === 'individual') {
        record.individualImages = (record.individualImages || []);
        record.individualImages.splice(meta.subIndex, 1);
    } else if (meta.subType === 'combined') {
        record.combinedImage = null;
    } else if (meta.subType === 'card') {
        record.playerCardImage = null;
    }
    const isEmpty = (!record.individualImages || record.individualImages.length === 0)
        && !record.combinedImage && !record.playerCardImage;
    if (isEmpty) {
        await dbDeleteSessionRecord(meta.sessionId);
    } else {
        await dbPutSessionRecord(record);
    }
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

// セッションレコード群を、このギャラリーが扱える「1枚=1meta」の形に展開する
// (個別写真×N＋グリッド画像＋選手カード画像を、それぞれ独立したスライドにする)
async function buildSessionSubMetas(records) {
    const metas = [];
    for (const record of records) {
        const individualCount = (record.individualImages || []).length;
        const entries = [];
        (record.individualImages || []).forEach((dataUrl, idx) => {
            entries.push({ subType: 'individual', subIndex: idx, dataUrl, fileName: `session_${record.id}_shot${idx + 1}.png` });
        });
        if (record.combinedImage) {
            entries.push({ subType: 'combined', subIndex: individualCount, dataUrl: record.combinedImage, fileName: `session_${record.id}_grid.png` });
        }
        if (record.playerCardImage) {
            entries.push({ subType: 'card', subIndex: individualCount + 1, dataUrl: record.playerCardImage, fileName: `session_${record.id}_card.png` });
        }
        for (const entry of entries) {
            try {
                const img = await loadImageFromDataUrl(entry.dataUrl);
                const thumbBlob = await makeThumbBlob(img);
                metas.push({
                    kind: 'session',
                    uid: `session:${record.id}:${entry.subType}:${entry.subIndex}`,
                    sessionId: record.id,
                    subType: entry.subType,
                    subIndex: entry.subIndex,
                    createdAt: record.createdAt,
                    fileName: entry.fileName,
                    thumbBlob,
                    sortKey: record.createdAt * 1000 + entry.subIndex,
                });
            } catch (err) {
                console.error('セッション画像の読み込みに失敗しました: ', err);
            }
        }
    }
    return metas;
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
        btn.addEventListener('click', () => animateToIndex(i));
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

// ---- トラック(前/現在/次の3枚)。指の動きにそのまま追従させ、指を離したらiPhone風のイージングでスナップする ----
function stageWidth() {
    return galleryStage.clientWidth || 1;
}

function setTrackTransform(px) {
    // translate3dでGPU合成レイヤーに乗せ、ドラッグ・スナップ双方の描画を滑らかにする
    galleryTrack.style.transform = `translate3d(${px}px, 0, 0)`;
}

let baseTranslate = 0; // 現在の写真が中央に来る位置(px、常に -stageWidth())
let currentTranslate = 0;

// 写真の切り替えアニメーション(コミット処理)が進行中かどうか。true の間は新しい操作を受け付けない。
// 高速連続操作でコミット処理が重なると、ロール固定のスロット入れ替えロジックが状態を壊してカクつきや
// 黒画面のちらつきの原因になっていたため、切り替え中は次の操作をブロックして確実に1件ずつ処理する
let isNavigating = false;

// ドラッグ中の連続更新はrequestAnimationFrameへ束ね、1フレームに複数回styleを書き換えないようにする
let pendingTransformPx = null;
let transformRafId = null;
function scheduleTrackTransform(px) {
    pendingTransformPx = px;
    if (transformRafId !== null) return;
    transformRafId = requestAnimationFrame(() => {
        transformRafId = null;
        if (pendingTransformPx !== null) setTrackTransform(pendingTransformPx);
    });
}
function cancelScheduledTransform() {
    if (transformRafId !== null) {
        cancelAnimationFrame(transformRafId);
        transformRafId = null;
    }
    pendingTransformPx = null;
}

// トラックの位置を「現在の写真が中央」の状態へアニメーションなしで即座に戻す
function settleTrackInstant() {
    cancelScheduledTransform();
    galleryTrack.style.transition = 'none';
    baseTranslate = -stageWidth();
    currentTranslate = baseTranslate;
    setTrackTransform(currentTranslate);
    void galleryTrack.offsetWidth; // 強制リフローで位置を確定させてからtransitionを戻す
    galleryTrack.style.transition = '';
}

function setSlideImgSrc(imgEl, url) {
    if (url) imgEl.src = url;
    else imgEl.removeAttribute('src');
}

async function ensureFullUrlCached(meta) {
    if (fullUrlCache.has(meta.uid)) return;
    const blob = await getFullBlobForMeta(meta).catch(() => null);
    if (!blob || fullUrlCache.has(meta.uid)) return;
    fullUrlCache.set(meta.uid, URL.createObjectURL(blob));
}

// 使われなくなったフル解像度キャッシュ(現在どのスロットからも参照されていないもの)を解放する
function evictUnusedFullUrlCache() {
    const wantUids = new Set();
    gallerySlideStates.forEach((slot) => {
        const meta = thumbList[slot.index];
        if (meta) wantUids.add(meta.uid);
    });
    for (const uid of Array.from(fullUrlCache.keys())) {
        if (!wantUids.has(uid)) {
            URL.revokeObjectURL(fullUrlCache.get(uid));
            fullUrlCache.delete(uid);
        }
    }
}

// 1つのスロットにthumbList上のindex(範囲外はnull扱い)の内容を割り当てる。非同期取得中に別の内容へ
// 差し替えられていたら(token不一致)結果を捨てる
async function setSlotContent(slot, index) {
    slot.index = index;
    const myToken = ++slot.token;
    const meta = (typeof index === 'number' && index >= 0 && index < thumbList.length) ? thumbList[index] : null;
    if (!meta) {
        setSlideImgSrc(slot.img, null);
        return;
    }
    await ensureFullUrlCached(meta);
    if (myToken !== slot.token) return;
    setSlideImgSrc(slot.img, fullUrlCache.get(meta.uid));
}

// DOM順をgallerySlideStates配列の並び順に揃える(ローテーションで崩れた順序を正規化する)
function normalizeSlideDomOrder() {
    gallerySlideStates.forEach((slot) => galleryTrack.appendChild(slot.el));
}

// アニメーションなしで指定の写真を中心にした3枚構成へ丸ごと再構築する(初回表示・削除後・遠い写真へのジャンプ用)
async function rebuildSlideWindow(index) {
    normalizeSlideDomOrder();
    const targets = [index - 1, index, index + 1];
    await Promise.all(gallerySlideStates.map((slot, i) => setSlotContent(slot, targets[i])));
    evictUnusedFullUrlCache();
}

// 現在位置は変えずに、各スロットが指すべき写真が変わっていれば(新規撮影で"次"が出現した等)差分だけ更新する
function refreshSlideWindowInPlace() {
    const targets = [currentIndex - 1, currentIndex, currentIndex + 1];
    gallerySlideStates.forEach((slot, i) => {
        if (slot.index !== targets[i]) setSlotContent(slot, targets[i]);
    });
    evictUnusedFullUrlCache();
}

// アニメーションなしでその写真へ切り替える(初回表示・削除後の再同期用)
async function openToIndex(index) {
    if (index < 0 || index >= thumbList.length) return;
    currentIndex = index;
    resetDeleteConfirm();
    await rebuildSlideWindow(index);
    settleTrackInstant();
    updateThumbStripSelection();
    updateNavArrowState();
    updateDateDisplays(thumbList[currentIndex].createdAt);
}

// 指を離した後、隣の写真へトラックごとスライドさせてから中央位置に確定させる。
// 外れる側のスロットだけを画面外で新しい内容に差し替えるので、非同期取得中でも中央の表示は乱れない
function commitAdjacentMove(targetIndex, dir) {
    isNavigating = true;
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        galleryTrack.removeEventListener('transitionend', finish);

        currentIndex = targetIndex;
        resetDeleteConfirm();

        if (dir < 0) {
            // 次へ: 先頭(prev)のスロットが外れるので、末尾へ回して新しい"次"にする
            const recycled = gallerySlideStates.shift();
            gallerySlideStates.push(recycled);
            galleryTrack.appendChild(recycled.el);
            setSlotContent(recycled, targetIndex + 1);
        } else {
            // 前へ: 末尾(next)のスロットが外れるので、先頭へ回して新しい"前"にする
            const recycled = gallerySlideStates.pop();
            gallerySlideStates.unshift(recycled);
            galleryTrack.insertBefore(recycled.el, galleryTrack.firstChild);
            setSlotContent(recycled, targetIndex - 1);
        }
        evictUnusedFullUrlCache();
        settleTrackInstant();
        updateThumbStripSelection();
        updateNavArrowState();
        updateDateDisplays(thumbList[currentIndex].createdAt);
        isNavigating = false;
    };
    galleryTrack.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 210); // transitionendが発火しない環境向けの保険
}

// 隣接していない写真(サムネイルクリックで離れた写真を選んだ場合)はクロスフェードで切り替える
function crossfadeToIndex(targetIndex) {
    isNavigating = true;
    galleryTrack.classList.remove('dragging');
    galleryTrack.style.opacity = '0';
    setTimeout(async () => {
        currentIndex = targetIndex;
        resetDeleteConfirm();
        await rebuildSlideWindow(targetIndex);
        settleTrackInstant();
        galleryTrack.style.opacity = '1';
        updateThumbStripSelection();
        updateNavArrowState();
        updateDateDisplays(thumbList[currentIndex].createdAt);
        isNavigating = false;
    }, 75);
}

// スワイプ・矢印ボタン・サムネイルクリックの共通の切り替え口。アニメーション付きで写真を切り替える
function animateToIndex(targetIndex) {
    if (isNavigating) return; // 前の切り替えアニメーションが終わるまで新しい操作は受け付けない
    if (targetIndex < 0 || targetIndex >= thumbList.length || targetIndex === currentIndex) return;
    if (Math.abs(targetIndex - currentIndex) === 1) {
        const dir = targetIndex > currentIndex ? -1 : 1; // 次の写真は左へ、前の写真は右へスライドさせる
        galleryTrack.classList.remove('dragging');
        setTrackTransform(baseTranslate + dir * stageWidth());
        commitAdjacentMove(targetIndex, dir);
    } else {
        crossfadeToIndex(targetIndex);
    }
}

function showNextPhoto() {
    animateToIndex(currentIndex + 1);
}

function showPrevPhoto() {
    animateToIndex(currentIndex - 1);
}

function toggleImmersive() {
    galleryOverlay.classList.toggle('immersive');
}

// 画面回転直後はresizeイベントが実際のレイアウト確定前に複数回発火することがあるため、
// 少し待ってから位置を再計算する(スマホを横→縦に回転した際にトラックの位置がズレる不具合の対策)
let galleryOrientationDebounceTimer = null;
function scheduleGalleryResettle() {
    clearTimeout(galleryOrientationDebounceTimer);
    galleryOrientationDebounceTimer = setTimeout(() => {
        if (galleryOverlay.hidden) return;
        settleTrackInstant();
    }, 150);
}
window.addEventListener('resize', scheduleGalleryResettle);
window.addEventListener('orientationchange', scheduleGalleryResettle);
if (window.screen && screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', scheduleGalleryResettle);
}

async function ensureThumbListLoaded() {
    if (thumbListLoadPromise) return thumbListLoadPromise;
    thumbListLoadPromise = (async () => {
        try {
            const legacyRecords = await dbGetAllThumbs();
            const legacyMetas = legacyRecords.map((r) => ({
                kind: 'legacy',
                uid: `legacy:${r.id}`,
                legacyId: r.id,
                createdAt: r.createdAt,
                fileName: r.fileName,
                thumbBlob: r.thumbBlob,
                sortKey: r.createdAt * 1000,
            }));

            let sessionMetas = [];
            try {
                const sessionRecords = await dbGetAllSessions();
                sessionMetas = await buildSessionSubMetas(sessionRecords);
            } catch (err) {
                console.error('セッション写真の読み込みに失敗しました: ', err);
            }

            thumbList = [...legacyMetas, ...sessionMetas].sort((a, b) => a.sortKey - b.sortKey);
            updateGalleryButtonThumb();
            // 直接この画面に来た時・auto/auto_soccerから撮影後に戻ってきた時のどちらでも、
            // 撮った写真が既にある(=丸いサムネイルが表示されている)なら案内を出す
            if (thumbList.length > 0) {
                showTipBubble(galleryBtnFirstVisitTip, GALLERY_BTN_VISITED_KEY);
            }
        } catch (err) {
            console.error('ギャラリーの読み込みに失敗しました: ', err);
        }
    })();
    return thumbListLoadPromise;
}

async function openGalleryViewer() {
    hideTipBubble(galleryBtnFirstVisitTip); // ギャラリーボタンの案内は用が済んだので消す
    await ensureThumbListLoaded();
    if (thumbList.length === 0) {
        showLocalToast('まだ撮影した写真がありません');
        return;
    }
    galleryOverlay.hidden = false;
    galleryOverlay.classList.remove('immersive');
    renderThumbStrip();
    await openToIndex(thumbList.length - 1);
    showTipBubble(galleryFirstVisitTip, GALLERY_VISITED_KEY);
}

// 企画書3.6節: 初回だけ案内の吹き出しを出す(ダウンロードボタン用・ギャラリーボタン用で共通の仕組み)
const GALLERY_VISITED_KEY = 'gallery_visited';
const GALLERY_BTN_VISITED_KEY = 'gallery_btn_tip_shown';
const tipHideTimers = new WeakMap();

function showTipBubble(el, storageKey) {
    if (!el) return;
    let alreadyShown = true;
    try {
        alreadyShown = !!localStorage.getItem(storageKey);
    } catch (err) {
        return; // localStorage不可(プライベートモード等)の場合は出さない
    }
    if (alreadyShown) return;

    el.style.setProperty('--tip-shift', '0px');
    el.hidden = false;
    requestAnimationFrame(() => {
        el.classList.add('show');
        // 中央寄せだけだと、ボタンが画面端に近い(スマホ縦画面など)場合にはみ出すことがあるため、
        // 実際の表示位置を測って画面内に収まるよう必要な分だけ補正する
        requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect();
            const margin = 8;
            let shift = 0;
            if (rect.left < margin) shift = margin - rect.left;
            else if (rect.right > window.innerWidth - margin) shift = (window.innerWidth - margin) - rect.right;
            if (shift !== 0) el.style.setProperty('--tip-shift', `${shift}px`);
        });
    });
    clearTimeout(tipHideTimers.get(el));
    tipHideTimers.set(el, setTimeout(() => hideTipBubble(el), 4000));
    try {
        localStorage.setItem(storageKey, '1');
    } catch (err) { /* ignore */ }
}

function hideTipBubble(el) {
    if (!el || el.hidden) return;
    el.classList.remove('show');
    clearTimeout(tipHideTimers.get(el));
    tipHideTimers.set(el, setTimeout(() => { el.hidden = true; }, 250));
}

function closeGalleryViewer() {
    galleryOverlay.hidden = true;
    galleryOverlay.classList.remove('immersive');
    resetDeleteConfirm();
    hideTipBubble(galleryFirstVisitTip);
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
        await deleteMetaEntry(meta);
    } catch (err) {
        console.error('写真の削除に失敗しました: ', err);
        showLocalToast('削除に失敗しました');
        return;
    }
    revokeThumbUrl(meta.uid);

    if (meta.kind === 'session') {
        // セッション内の1枚を消すと残りのsubIndexがズレるため、同じセッション分は作り直す
        const sessionId = meta.sessionId;
        for (let i = thumbList.length - 1; i >= 0; i--) {
            if (thumbList[i].kind === 'session' && thumbList[i].sessionId === sessionId) {
                revokeThumbUrl(thumbList[i].uid);
                thumbList.splice(i, 1);
            }
        }
        const record = await dbGetSessionRecord(sessionId).catch(() => null);
        if (record) {
            const freshMetas = await buildSessionSubMetas([record]);
            thumbList.push(...freshMetas);
            thumbList.sort((a, b) => a.sortKey - b.sortKey);
        }
    } else {
        thumbList.splice(currentIndex, 1);
    }

    updateGalleryButtonThumb();
    if (thumbList.length === 0) {
        closeGalleryViewer();
        return;
    }
    currentIndex = Math.min(currentIndex, thumbList.length - 1);
    renderThumbStrip();
    await openToIndex(currentIndex);
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
    const blob = await getFullBlobForMeta(meta).catch(() => null);
    if (!blob) {
        showLocalToast('保存に失敗しました');
        return;
    }

    const file = new File([blob], meta.fileName, { type: blob.type || 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file] });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
        }
    }

    triggerBlobDownload(blob, meta.fileName);
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
        thumbList.push({
            kind: 'legacy',
            uid: `legacy:${id}`,
            legacyId: id,
            createdAt: createdAtMs,
            fileName,
            thumbBlob,
            sortKey: createdAtMs * 1000,
        });
        // 連続撮影時に非同期処理の完了順がずれても古い→新しいの並びを保つ
        thumbList.sort((a, b) => a.sortKey - b.sortKey);
        updateGalleryButtonThumb();
        // 写真が0枚の状態でこのページに来て、その場で1枚目を撮った場合にもここで案内を出す
        // (showTipBubbleは表示済みなら何もしないので、複数回呼んでも安全)
        showTipBubble(galleryBtnFirstVisitTip, GALLERY_BTN_VISITED_KEY);
        if (!galleryOverlay.hidden) {
            renderThumbStrip();
            updateNavArrowState();
            refreshSlideWindowInPlace();
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
galleryDownloadBtn.addEventListener('click', () => { hideTipBubble(galleryFirstVisitTip); downloadCurrentPhoto(); });
galleryDeleteBtn.addEventListener('click', onDeleteBtnClick);
galleryPrevArrowBtn.addEventListener('click', showPrevPhoto);
galleryNextArrowBtn.addEventListener('click', showNextPhoto);

// ---- 画像エリアのタップ(没入モード切替)・ドラッグ(指の動きにそのまま追従するスワイプ) ----
const TAP_MOVE_THRESHOLD = 10;
const TAP_TIME_THRESHOLD_MS = 400;
const AXIS_LOCK_THRESHOLD = 6; // 横スワイプか縦操作(タップ等)かを見極めるまでの遊び
const EDGE_RESISTANCE = 0.3; // 端の写真をさらにその方向へ引っ張った時の抵抗(iPhone風のラバーバンド)
const SWIPE_COMMIT_RATIO = 0.5; // ゆっくりドラッグした場合、画面の半分を超えたら次/前の写真に切り替える(速いフリックは別ロジック)
const FAST_FLICK_VELOCITY = 0.5; // px/ms(≈時速500px/s)。これを超える速さの指離しは距離が短くても切り替える
const VELOCITY_WINDOW_MS = 80; // 速度計算に使う直近の時間窓

let isDragging = false;
let dragPointerId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragStartT = 0;
let dragAxis = null; // 'x' | 'y' | null
let moveHistory = []; // 直近の { x, t } 履歴(速度計算用)

function pushMoveHistory(x, t) {
    moveHistory.push({ x, t });
    while (moveHistory.length > 2 && t - moveHistory[0].t > VELOCITY_WINDOW_MS) moveHistory.shift();
}

function computeFlickVelocity() {
    if (moveHistory.length < 2) return 0;
    const first = moveHistory[0];
    const last = moveHistory[moveHistory.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.x - first.x) / dt; // px/ms(右方向が正)
}

galleryStage.addEventListener('pointerdown', (e) => {
    if (thumbList.length === 0) return;
    if (isNavigating) return; // 前の切り替えアニメーションが終わるまで新しいドラッグは開始させない
    e.preventDefault(); // 画像上でのネイティブドラッグ開始・テキスト選択を防ぐ(自前のスワイプと競合するため)
    isDragging = true;
    dragAxis = null;
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartT = performance.now();
    moveHistory = [{ x: e.clientX, t: dragStartT }];
    galleryTrack.classList.add('dragging');
    try { galleryStage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

galleryStage.addEventListener('pointermove', (e) => {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (dragAxis === null) {
        if (Math.abs(dx) < AXIS_LOCK_THRESHOLD && Math.abs(dy) < AXIS_LOCK_THRESHOLD) return;
        dragAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (dragAxis === 'y') return;

    pushMoveHistory(e.clientX, performance.now());

    let move = baseTranslate + dx;
    const atStart = currentIndex <= 0;
    const atEnd = currentIndex >= thumbList.length - 1;
    if (atStart && dx > 0) move = baseTranslate + dx * EDGE_RESISTANCE;
    else if (atEnd && dx < 0) move = baseTranslate + dx * EDGE_RESISTANCE;
    currentTranslate = move;
    scheduleTrackTransform(currentTranslate);
});

galleryStage.addEventListener('pointerup', (e) => {
    if (!isDragging || e.pointerId !== dragPointerId) return;
    isDragging = false;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const dt = performance.now() - dragStartT;
    const wasHorizontalDrag = dragAxis === 'x';
    dragAxis = null;
    cancelScheduledTransform();
    galleryTrack.classList.remove('dragging');

    if (!wasHorizontalDrag) {
        setTrackTransform(baseTranslate);
        if (Math.abs(dx) < TAP_MOVE_THRESHOLD && Math.abs(dy) < TAP_MOVE_THRESHOLD && dt < TAP_TIME_THRESHOLD_MS) {
            toggleImmersive();
        }
        return;
    }

    const movedBy = currentTranslate - baseTranslate;
    const distanceThreshold = stageWidth() * SWIPE_COMMIT_RATIO;
    const velocity = computeFlickVelocity();
    // 距離のしきい値を超えたか、勢いよく指を離した(フリック)場合は切り替える
    const isFastFlick = Math.abs(dx) > TAP_MOVE_THRESHOLD && Math.abs(velocity) > FAST_FLICK_VELOCITY;

    let targetIndex = currentIndex;
    if ((movedBy < -distanceThreshold || (isFastFlick && velocity < 0)) && currentIndex < thumbList.length - 1) {
        targetIndex = currentIndex + 1;
    } else if ((movedBy > distanceThreshold || (isFastFlick && velocity > 0)) && currentIndex > 0) {
        targetIndex = currentIndex - 1;
    }

    if (targetIndex !== currentIndex) {
        const dir = targetIndex > currentIndex ? -1 : 1;
        setTrackTransform(baseTranslate + dir * stageWidth());
        commitAdjacentMove(targetIndex, dir);
    } else {
        setTrackTransform(baseTranslate); // しきい値未満: 元の位置へスナップバック
    }
});

galleryStage.addEventListener('pointercancel', () => {
    if (!isDragging) return;
    isDragging = false;
    dragAxis = null;
    cancelScheduledTransform();
    galleryTrack.classList.remove('dragging');
    setTrackTransform(baseTranslate);
});
