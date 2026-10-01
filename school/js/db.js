// 撮影セッション(個別写真+グリッド画像+選手カード画像)を、企画書のスキーマ通りに
// IndexedDB "WebARPhotoGalleryDB" / "photos" ストアへ保存する。既存ルート側の
// webar_gallery_db(単発写真用)とは別のDBであり、js/gallery.js側がこちらも読み込んで
// 同じギャラリービューアに表示する。

const DB_NAME = 'WebARPhotoGalleryDB';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

let dbPromise = null;

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
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

// individualImages/combinedImage/playerCardImage は全てBase64文字列(dataURL)で保存する
export async function saveSession({ type, individualImages, combinedImage, playerCardImage }) {
    const db = await getDB();
    const record = {
        createdAt: Date.now(),
        type,
        individualImages,
        combinedImage,
        playerCardImage,
    };
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).add(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
