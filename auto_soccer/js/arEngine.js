// ルートの js/app.js から、カメラ起動・端末回転補正・MediaPipe顔トラッキング・Three.jsマスク合成の
// コアロジックを移植したもの。自動撮影フロー専用のため、手動UI(ARスイッチャー・カメラ切替・ギャラリー)は
// 持たず、flow.js から呼び出すAPI(initArEngine/setMaskUrl/capturePhoto等)だけを公開する。
// ルート版と同じく最大4人までの複数人トラッキングに対応する。

import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8";

let video, outputCanvas, ctx;
const arCanvas = document.createElement('canvas');
const rotatedVideoCanvas = document.createElement('canvas');
const rotatedVideoCtx = rotatedVideoCanvas.getContext('2d', { alpha: false });

let faceLandmarker;
let runningMode = "VIDEO";
let vfcLoopStarted = false;
let rafLoopRunning = false;
let currentFacingMode = 'user';
let currentStream = null;
let rawVideoWidth = 0;
let rawVideoHeight = 0;

// マスクサイズ・位置(app.jsと同じ値)
const MASK_WIDTH = 1024 / 480 * 20;
const MASK_HEIGHT = 1024 / 630 * 25;
const MASK_OFFSET = new THREE.Vector3(0, 2.3, 0);

const VIRTUAL_CAMERA_VERTICAL_FOV = 63;
const NEAR = 1;
const FAR = 10000;

const HIDE_YAW_THRESHOLD_DEG = 60;
const HIDE_PITCH_THRESHOLD_DEG = 60;

const POSITION_RESPONSIVENESS = 18;
const ROTATION_RESPONSIVENESS = 18;
const SCALE_RESPONSIVENESS = 18;

// 最大人数・トラッキングの検出しきい値(app.jsと同じ値)
const MAX_FACES = 4;
const TRACKING_MAX_MATCH_DISTANCE = 220;

let scene, camera, renderer, maskMaterial;
let maskMeshes = [];
const maskTextureLoader = new THREE.TextureLoader();
let maskTextureRequestToken = 0;

const _matrix = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _maskOffsetScratch = new THREE.Vector3();
const _upsideDownAxis = new THREE.Vector3(0, 0, 1);
const _upsideDownCorrectionQuat = new THREE.Quaternion();
let lastTimestampSec = 0;
let maskVisible = false;

const _detPos = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());
const _detQuat = Array.from({ length: MAX_FACES }, () => new THREE.Quaternion());
const _detScale = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());

const slotActive = new Array(MAX_FACES).fill(false);
const _assignedSlotOfDetection = new Array(MAX_FACES).fill(-1);
const _slotUsedThisFrame = new Array(MAX_FACES).fill(false);
const _nextSlotActive = new Array(MAX_FACES).fill(false);
const _candidatePairPool = Array.from({ length: MAX_FACES * MAX_FACES }, () => ({ i: 0, j: 0, dist: 0 }));
const _candidatePairs = [];

// 直近の検出結果から求めた、映像内での顔(複数人分)の矩形一覧(0〜1に正規化、保存写真の座標系)。
// カード作成画面の顔クロップに使う
let lastFaceRectsNormalized = [];

function initThree() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(VIRTUAL_CAMERA_VERTICAL_FOV, 1, NEAR, FAR);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    renderer = new THREE.WebGLRenderer({ canvas: arCanvas, alpha: true, antialias: false });
    renderer.setPixelRatio(1);

    arCanvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        console.error('WebGLコンテキストが失われました。再読み込みします。');
        setTimeout(() => window.location.reload(), 800);
    }, false);

    const geometry = new THREE.PlaneGeometry(MASK_WIDTH, MASK_HEIGHT);
    maskMaterial = new THREE.MeshBasicMaterial({
        map: null,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    for (let i = 0; i < MAX_FACES; i++) {
        const mesh = new THREE.Mesh(geometry, maskMaterial);
        mesh.visible = false;
        scene.add(mesh);
        maskMeshes.push(mesh);
    }
}

// テクスチャの読み込み完了(または失敗)を待てるようPromiseを返す。呼び出し側の大半は
// 完了を待たずファイア&フォーゲットで使うが、初回だけは読み込み完了までAR読み込み中の
// 表示を残したいため、flow.js側でこの戻り値をawaitしている
export function setMaskUrl(url) {
    return new Promise((resolve) => {
        if (!url) {
            const previousTexture = maskMaterial.map;
            maskMaterial.map = null;
            maskMaterial.needsUpdate = true;
            if (previousTexture) previousTexture.dispose();
            resolve();
            return;
        }
        const myToken = ++maskTextureRequestToken;
        maskTextureLoader.load(url, (texture) => {
            if (myToken !== maskTextureRequestToken) {
                texture.dispose();
                resolve();
                return;
            }
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = false;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            const previousTexture = maskMaterial.map;
            maskMaterial.map = texture;
            maskMaterial.needsUpdate = true;
            if (previousTexture) previousTexture.dispose();
            resolve();
        }, undefined, (err) => {
            console.error('ARマスクのテクスチャ読み込みに失敗しました: ', err);
            resolve(); // 失敗しても起動を止めない
        });
    });
}

async function initializeFaceLandmarker() {
    initThree();
    const modelPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
        );
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                delegate: "GPU"
            },
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
            runningMode: runningMode,
            numFaces: 1
        });
    })();

    const cameraPromise = startCamera();
    await Promise.all([modelPromise, cameraPromise]);
}

const isMobile = matchMedia('(pointer: coarse)').matches;
const landscapeMql = matchMedia('(orientation: landscape)');

function getVideoConstraints() {
    if (!isMobile) {
        return { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } };
    }
    return { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } };
}

function getOutputCanvasSize(dispWidth, dispHeight) {
    if (!isMobile) {
        return { width: dispWidth, height: dispHeight };
    }
    const isLandscape = landscapeMql.matches;
    const targetRatio = isLandscape ? (4 / 3) : (3 / 4);
    const currentRatio = dispWidth / dispHeight;
    if (currentRatio > targetRatio) {
        const height = dispHeight;
        const width = Math.round(height * targetRatio);
        return { width, height };
    } else {
        const width = dispWidth;
        const height = Math.round(width / targetRatio);
        return { width, height };
    }
}

// ---- 端末回転判定(app.jsから移植、ARスイッチャー向けの分岐だけ削除) ----
const ROLL_SIGN = 1;
const GAMMA_SIGN = 1;
const DETECTION_ROTATION_SIGN = 1;

const ZONE_BOUNDARY_1 = 45;
const HYSTERESIS = 5;
const ZONE_BOUNDARY_WRAP_HOLD = 135;
const ROTATE_ENTER_ANGLE = 60;
const ROTATE_EXIT_ANGLE = 40;
const UPSIDE_DOWN_BOUNDARY = 135;

let rotationState = 'none';
let upsideDownDir = 0;
let isUpsideDown = false;
let lockedEarlyZone = 'none';
let lockedMode = false;
let orientationCheckDone = false;
let lockCheckPendingSinceMs = null;
const ORIENTATION_LOCK_CHECK_ANGLE = ROTATE_ENTER_ANGLE;
const ORIENTATION_LOCK_GRACE_MS = 500;

let rollAvailable = false;
let latestRollDeg = 0;
let gammaAvailable = false;
let latestGamma = 0;

function updateUpsideDownState(angleDeg) {
    if (upsideDownDir === 1) {
        const stillIn = angleDeg >= UPSIDE_DOWN_BOUNDARY - HYSTERESIS || angleDeg <= -UPSIDE_DOWN_BOUNDARY;
        if (!stillIn) upsideDownDir = 0;
    } else if (upsideDownDir === -1) {
        const stillIn = angleDeg <= -(UPSIDE_DOWN_BOUNDARY - HYSTERESIS) || angleDeg >= UPSIDE_DOWN_BOUNDARY;
        if (!stillIn) upsideDownDir = 0;
    } else if (angleDeg >= UPSIDE_DOWN_BOUNDARY + HYSTERESIS) {
        upsideDownDir = 1;
    } else if (angleDeg <= -(UPSIDE_DOWN_BOUNDARY + HYSTERESIS)) {
        upsideDownDir = -1;
    }
    isUpsideDown = upsideDownDir !== 0;
}

function updateLockedEarlyZone(angleDeg) {
    if (lockedEarlyZone === 'cw') {
        if (angleDeg < ZONE_BOUNDARY_1 - HYSTERESIS) lockedEarlyZone = 'none';
    } else if (lockedEarlyZone === 'ccw') {
        if (angleDeg > -(ZONE_BOUNDARY_1 - HYSTERESIS)) lockedEarlyZone = 'none';
    } else if (angleDeg > ZONE_BOUNDARY_1 + HYSTERESIS) {
        lockedEarlyZone = 'cw';
    } else if (angleDeg < -(ZONE_BOUNDARY_1 + HYSTERESIS)) {
        lockedEarlyZone = 'ccw';
    }
}

function getDetectionRotationRad() {
    if (lockedMode) {
        if (isUpsideDown) return Math.PI;
        if (lockedEarlyZone === 'cw') return -Math.PI / 2;
        if (lockedEarlyZone === 'ccw') return Math.PI / 2;
        return 0;
    }
    return isUpsideDown ? (-upsideDownDir * DETECTION_ROTATION_SIGN * (Math.PI / 2)) : 0;
}

function getScreenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
    return 0;
}

function classifyAngle(angleDeg, previous) {
    if (previous === 'cw') {
        const inHoldZone = angleDeg > ROTATE_EXIT_ANGLE || angleDeg <= -ZONE_BOUNDARY_WRAP_HOLD;
        return inHoldZone ? 'cw' : 'none';
    }
    if (previous === 'ccw') {
        const inHoldZone = angleDeg < -ROTATE_EXIT_ANGLE || angleDeg >= ZONE_BOUNDARY_WRAP_HOLD;
        return inHoldZone ? 'ccw' : 'none';
    }
    if (angleDeg >= ROTATE_ENTER_ANGLE) return 'cw';
    if (angleDeg <= -ROTATE_ENTER_ANGLE) return 'ccw';
    return 'none';
}

function computeRotationState() {
    if (rollAvailable) return classifyAngle(latestRollDeg, rotationState);
    if (gammaAvailable) return classifyAngle(latestGamma * GAMMA_SIGN, rotationState);
    const angle = getScreenAngle();
    if (angle === 270) return 'cw';
    if (angle === 90) return 'ccw';
    return 'none';
}

function updateOutputCanvasSize() {
    if (!rawVideoWidth || !rawVideoHeight) return;
    const { width, height } = getOutputCanvasSize(rawVideoWidth, rawVideoHeight);
    outputCanvas.width = width;
    outputCanvas.height = height;
}

function finishOrientationCheck(locked) {
    if (orientationCheckDone) return;
    orientationCheckDone = true;
    lockedMode = locked;
    if (locked && rotationState !== 'none') {
        rotationState = 'none';
        updateOutputCanvasSize();
    }
}

function runOrientationCheck() {
    if (orientationCheckDone || !rollAvailable) return;
    if (Math.abs(latestRollDeg) < ORIENTATION_LOCK_CHECK_ANGLE) return;

    if (landscapeMql.matches) {
        rotationState = computeRotationState();
        updateOutputCanvasSize();
        finishOrientationCheck(false);
        return;
    }
    if (lockCheckPendingSinceMs === null) {
        lockCheckPendingSinceMs = Date.now();
        return;
    }
    if (Date.now() - lockCheckPendingSinceMs >= ORIENTATION_LOCK_GRACE_MS) {
        finishOrientationCheck(true);
    }
}

function applyRotationState() {
    if (!isMobile) {
        if (rotationState !== 'none') {
            rotationState = 'none';
            updateOutputCanvasSize();
        }
        return;
    }
    const candidate = computeRotationState();
    if (candidate === rotationState) return;
    rotationState = candidate;
    updateOutputCanvasSize();
}

function syncVideoDimensions() {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return;
    if (videoWidth === rawVideoWidth && videoHeight === rawVideoHeight) return;

    rawVideoWidth = videoWidth;
    rawVideoHeight = videoHeight;
    updateOutputCanvasSize();

    arCanvas.width = videoWidth;
    arCanvas.height = videoHeight;
    renderer.setSize(videoWidth, videoHeight, false);
    camera.aspect = videoWidth / videoHeight;
    camera.updateProjectionMatrix();
}

function startCamera() {
    const videoConstraints = getVideoConstraints();
    const previousStream = currentStream;

    return navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
        .then((stream) => {
            currentStream = stream;
            video.srcObject = stream;
            video.play().catch(() => {});
            return new Promise((resolve) => {
                video.addEventListener("loadeddata", () => {
                    syncVideoDimensions();
                    startFrameLoop();
                    resolve();
                }, { once: true });
            });
        })
        .then(() => {
            if (previousStream && previousStream !== currentStream) {
                previousStream.getTracks().forEach((track) => track.stop());
            }
        })
        .catch((err) => {
            console.error("カメラの起動に失敗しました: ", err);
            throw err;
        });
}

function resyncCameraForOrientation() {
    const track = currentStream && currentStream.getVideoTracks()[0];
    if (!track) return;
    track.applyConstraints(getVideoConstraints()).catch(() => {
        startCamera().catch(() => {});
    });
}

let orientationResyncDebounceTimer = null;
function scheduleOrientationResync() {
    clearTimeout(orientationResyncDebounceTimer);
    orientationResyncDebounceTimer = setTimeout(resyncCameraForOrientation, 100);
}

let rotationDebounceTimer = null;
function scheduleRotationUpdate() {
    clearTimeout(rotationDebounceTimer);
    rotationDebounceTimer = setTimeout(() => {
        if (!orientationCheckDone || lockedMode) return;
        applyRotationState();
    }, 150);
}

let smoothedAx = 0;
let smoothedAy = 1;
const ROLL_SMOOTHING = 0.15;

function handleDeviceMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || typeof acc.x !== 'number' || typeof acc.y !== 'number') return;
    smoothedAx += (acc.x - smoothedAx) * ROLL_SMOOTHING;
    smoothedAy += (acc.y - smoothedAy) * ROLL_SMOOTHING;
    if (Math.hypot(smoothedAx, smoothedAy) < 2) return;
    rollAvailable = true;
    latestRollDeg = Math.atan2(smoothedAx * ROLL_SIGN, -smoothedAy) * 180 / Math.PI;
    updateUpsideDownState(latestRollDeg);
    updateLockedEarlyZone(latestRollDeg);

    if (!orientationCheckDone) {
        runOrientationCheck();
        return;
    }
    if (lockedMode) return;
    applyRotationState();
}

function handleDeviceOrientation(event) {
    if (rollAvailable || typeof event.gamma !== 'number') return;
    gammaAvailable = true;
    latestGamma = event.gamma;
    if (!orientationCheckDone) return;
    if (lockedMode) return;
    applyRotationState();
}

function startRotationSensors() {
    if (typeof DeviceMotionEvent !== 'undefined') {
        window.addEventListener('devicemotion', handleDeviceMotion);
    }
    if (typeof DeviceOrientationEvent !== 'undefined') {
        window.addEventListener('deviceorientation', handleDeviceOrientation);
    }
}

function requestMotionPermissions() {
    const requests = [];
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        requests.push(DeviceMotionEvent.requestPermission());
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        requests.push(DeviceOrientationEvent.requestPermission());
    }
    return Promise.all(requests);
}

export const needsMotionPermission =
    (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') ||
    (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function');

export function requestPermissionThenStartSensors() {
    return requestMotionPermissions()
        .then((results) => {
            if (results.length > 0 && results.every((r) => r === 'granted')) {
                startRotationSensors();
            }
        })
        .catch((err) => {
            console.error("モーション許可の取得に失敗しました: ", err);
        });
}

// カメラ許可確定後に呼ぶ。iOSは初回のみタップ必須のため、まず無タップで試し、ダメなら呼び出し側で
// タップ誘導UIを出してもらう(true=タップ誘導が必要)
export async function tryStartSensorsAutomatically() {
    if (!needsMotionPermission) {
        startRotationSensors();
        return true;
    }
    try {
        const results = await requestMotionPermissions();
        if (results.length > 0 && results.every((r) => r === 'granted')) {
            startRotationSensors();
            return true;
        }
    } catch (err) { /* ignore, フォールバックへ */ }
    return false;
}

if (isMobile) {
    if (screen.orientation && screen.orientation.addEventListener) {
        screen.orientation.addEventListener('change', scheduleRotationUpdate);
    } else {
        window.addEventListener('orientationchange', scheduleRotationUpdate);
    }
    landscapeMql.addEventListener('change', () => {
        scheduleOrientationResync();
        scheduleRotationUpdate();
    });
}

// ---- 検出・合成 ----
// 撮影が全て終わった後(カード作成〜サンクス画面)はライブのAR合成が不要になるため、
// flow.js から shutdownCamera() を呼んで検出ループとカメラストリームを止め、
// 最も重い処理(顔検出の推論)とカメラのCPU/バッテリー消費を早めに止められるようにする
let loopActive = true;

export function shutdownCamera() {
    loopActive = false;
    if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
        currentStream = null;
    }
}

function startFrameLoop() {
    if (video.requestVideoFrameCallback) {
        if (!vfcLoopStarted) {
            vfcLoopStarted = true;
            video.requestVideoFrameCallback(onVideoFrame);
        }
    } else if (!rafLoopRunning) {
        rafLoopRunning = true;
        window.requestAnimationFrame(predictLoopFallback);
    }
}

let lastFedTimestampMs = -1;
function nextMonotonicTimestampMs() {
    let t = performance.now();
    if (t <= lastFedTimestampMs) t = lastFedTimestampMs + 1;
    lastFedTimestampMs = t;
    return t;
}

let currentDetectionContainScale = 1;
let currentDetectionRotateRad = 0;

function renderFrame(timestampMs) {
    if (faceLandmarker) {
        let detectionSource = video;
        currentDetectionRotateRad = getDetectionRotationRad();
        currentDetectionContainScale = 1;
        if (currentDetectionRotateRad !== 0) {
            if (rotatedVideoCanvas.width !== rawVideoWidth || rotatedVideoCanvas.height !== rawVideoHeight) {
                rotatedVideoCanvas.width = rawVideoWidth;
                rotatedVideoCanvas.height = rawVideoHeight;
            }
            const isQuarterTurn = Math.abs(currentDetectionRotateRad) === Math.PI / 2;
            if (isQuarterTurn) {
                const rotatedContentWidth = rawVideoHeight;
                const rotatedContentHeight = rawVideoWidth;
                currentDetectionContainScale = Math.min(
                    rawVideoWidth / rotatedContentWidth,
                    rawVideoHeight / rotatedContentHeight
                );
            }
            rotatedVideoCtx.save();
            rotatedVideoCtx.clearRect(0, 0, rawVideoWidth, rawVideoHeight);
            rotatedVideoCtx.translate(rawVideoWidth / 2, rawVideoHeight / 2);
            rotatedVideoCtx.rotate(currentDetectionRotateRad);
            rotatedVideoCtx.scale(currentDetectionContainScale, currentDetectionContainScale);
            rotatedVideoCtx.drawImage(video, -rawVideoWidth / 2, -rawVideoHeight / 2);
            rotatedVideoCtx.restore();
            detectionSource = rotatedVideoCanvas;
        }
        const results = faceLandmarker.detectForVideo(detectionSource, timestampMs);
        applyResults(results, timestampMs);
    }
    renderer.render(scene, camera);
    renderComposite(outputCanvas.width, outputCanvas.height);
}

function onVideoFrame() {
    if (!loopActive) return; // shutdownCamera()後は次のフレームを予約せずループを止める
    try {
        renderFrame(nextMonotonicTimestampMs());
    } catch (err) {
        console.error("フレーム描画中にエラーが発生しました: ", err);
    }
    video.requestVideoFrameCallback(onVideoFrame);
}

let lastVideoTime = -1;
function predictLoopFallback() {
    if (!loopActive) return;
    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        try {
            renderFrame(nextMonotonicTimestampMs());
        } catch (err) {
            console.error("フレーム描画中にエラーが発生しました: ", err);
        }
    }
    window.requestAnimationFrame(predictLoopFallback);
}

// 複数人+トラッキング(app.jsのapplyResultsと同じアルゴリズム。GC対策で使い回しのスクラッチに書き込む)
function applyResults(results, timestampMs) {
    const matrices = results.facialTransformationMatrixes;

    const nowSec = timestampMs / 1000;
    const dt = lastTimestampSec ? Math.max(0, nowSec - lastTimestampSec) : 1 / 60;
    lastTimestampSec = nowSec;

    const posT = 1 - Math.exp(-POSITION_RESPONSIVENESS * dt);
    const rotT = 1 - Math.exp(-ROTATION_RESPONSIVENESS * dt);
    const scaleT = 1 - Math.exp(-SCALE_RESPONSIVENESS * dt);

    const faceCount = matrices ? Math.min(matrices.length, maskMeshes.length) : 0;

    if (currentDetectionRotateRad !== 0) {
        _upsideDownCorrectionQuat.setFromAxisAngle(_upsideDownAxis, currentDetectionRotateRad);
    }

    for (let i = 0; i < faceCount; i++) {
        _matrix.fromArray(matrices[i].data);
        _matrix.decompose(_detPos[i], _detQuat[i], _detScale[i]);
        if (currentDetectionRotateRad !== 0) {
            _detPos[i].applyQuaternion(_upsideDownCorrectionQuat);
            _detQuat[i].premultiply(_upsideDownCorrectionQuat);
            _detPos[i].z *= currentDetectionContainScale;
        }
    }

    for (let i = 0; i < faceCount; i++) _assignedSlotOfDetection[i] = -1;
    for (let j = 0; j < maskMeshes.length; j++) _slotUsedThisFrame[j] = false;

    _candidatePairs.length = 0;
    let poolIndex = 0;
    for (let i = 0; i < faceCount; i++) {
        for (let j = 0; j < maskMeshes.length; j++) {
            if (!slotActive[j]) continue;
            const dist = _detPos[i].distanceTo(maskMeshes[j].position);
            if (dist <= TRACKING_MAX_MATCH_DISTANCE) {
                const pair = _candidatePairPool[poolIndex++];
                pair.i = i;
                pair.j = j;
                pair.dist = dist;
                _candidatePairs.push(pair);
            }
        }
    }
    _candidatePairs.sort((a, b) => a.dist - b.dist);

    for (const pair of _candidatePairs) {
        if (_assignedSlotOfDetection[pair.i] !== -1) continue;
        if (_slotUsedThisFrame[pair.j]) continue;
        _assignedSlotOfDetection[pair.i] = pair.j;
        _slotUsedThisFrame[pair.j] = true;
    }

    for (let i = 0; i < faceCount; i++) {
        if (_assignedSlotOfDetection[i] !== -1) continue;
        const freeSlot = _slotUsedThisFrame.indexOf(false);
        if (freeSlot === -1) continue;
        _assignedSlotOfDetection[i] = freeSlot;
        _slotUsedThisFrame[freeSlot] = true;
    }

    for (let j = 0; j < maskMeshes.length; j++) _nextSlotActive[j] = false;

    for (let i = 0; i < faceCount; i++) {
        const slot = _assignedSlotOfDetection[i];
        if (slot === -1) continue;

        const mesh = maskMeshes[slot];
        const targetPos = _detPos[i];
        const targetQuat = _detQuat[i];
        const targetScale = _detScale[i];

        _euler.setFromQuaternion(targetQuat, 'YXZ');
        const yawDeg = THREE.MathUtils.radToDeg(_euler.y);
        const pitchDeg = THREE.MathUtils.radToDeg(_euler.x);

        const facingAway =
            Math.abs(yawDeg) > HIDE_YAW_THRESHOLD_DEG ||
            Math.abs(pitchDeg) > HIDE_PITCH_THRESHOLD_DEG;

        _nextSlotActive[slot] = true;

        if (facingAway) {
            mesh.visible = false;
            mesh.position.lerp(targetPos, posT);
            continue;
        }

        mesh.visible = true;

        if (MASK_OFFSET.lengthSq() > 0) {
            _maskOffsetScratch.copy(MASK_OFFSET).applyQuaternion(targetQuat);
            targetPos.add(_maskOffsetScratch);
        }

        mesh.position.lerp(targetPos, posT);
        mesh.quaternion.slerp(targetQuat, rotT);
        mesh.scale.lerp(targetScale, scaleT);
    }

    for (let j = 0; j < maskMeshes.length; j++) {
        if (!_nextSlotActive[j]) {
            maskMeshes[j].visible = false;
        }
        slotActive[j] = _nextSlotActive[j];
    }

    updateFaceRectsFromMeshes();
}

const _projected = new THREE.Vector3();
function computeFaceRectFromPosition(worldPos) {
    _projected.copy(worldPos).project(camera);
    // NDC(-1..1)→raw video正規化座標(0..1, 左上原点)。この時点ではミラー・クロップ・保存用回転は未反映
    const cxRaw = (_projected.x * 0.5 + 0.5);
    const cyRaw = (1 - (_projected.y * 0.5 + 0.5));
    // 顔の直径は経験的にraw video高さの約34%とする
    return mapRawPointToPhotoRect(cxRaw, cyRaw, 0.34);
}

// 現在表示中(=顔がこちらを向いている)の全マスクから、カード用の顔クロップ矩形一覧を作る
function updateFaceRectsFromMeshes() {
    const rects = [];
    for (let j = 0; j < maskMeshes.length; j++) {
        if (!maskMeshes[j].visible) continue;
        const rect = computeFaceRectFromPosition(maskMeshes[j].position);
        if (rect) rects.push(rect);
    }
    lastFaceRectsNormalized = rects;
    maskVisible = rects.length > 0;
}

// applyResultsで得た「raw video内での顔の正規化座標」を、実際に保存される写真(getPhotoCanvasの出力)の
// 正規化座標に変換する。renderComposite(中央クロップ+ミラー)とgetPhotoCanvas(端末回転補正)の座標変換を
// そのまま1点に対して適用しているだけ(処理内容自体はどちらも上の関数と対応させてある)
function mapRawPointToPhotoRect(cxRawNorm, cyRawNorm, sizeRawNorm) {
    if (!rawVideoWidth || !rawVideoHeight || !outputCanvas.width || !outputCanvas.height) return null;

    const x = cxRawNorm * rawVideoWidth;
    const y = cyRawNorm * rawVideoHeight;

    const w = outputCanvas.width;
    const h = outputCanvas.height;
    const canvasRatio = w / h;
    const videoRatio = rawVideoWidth / rawVideoHeight;
    let sx, sy, sWidth, sHeight;
    if (videoRatio > canvasRatio) {
        sHeight = rawVideoHeight;
        sWidth = sHeight * canvasRatio;
        sx = (rawVideoWidth - sWidth) / 2;
        sy = 0;
    } else {
        sWidth = rawVideoWidth;
        sHeight = sWidth / canvasRatio;
        sx = 0;
        sy = (rawVideoHeight - sHeight) / 2;
    }
    const scale = w / sWidth; // アスペクト一致のためx/yとも同じ倍率

    let px = (x - sx) * scale;
    let py = (y - sy) * scale;
    if (currentFacingMode === 'user') px = w - px; // renderCompositeのミラーと同じ反転

    const sizePx = sizeRawNorm * rawVideoHeight * scale;

    const rotateRad = getPhotoRotationRad();
    if (rotateRad === 0) {
        return { x: px / w, y: py / h, size: sizePx / Math.min(w, h) };
    }

    const isQuarterTurn = Math.abs(rotateRad) === Math.PI / 2;
    const rotatedW = isQuarterTurn ? h : w;
    const rotatedH = isQuarterTurn ? w : h;
    const dx = px - w / 2;
    const dy = py - h / 2;
    const cos = Math.cos(rotateRad);
    const sin = Math.sin(rotateRad);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const finalX = rx + rotatedW / 2;
    const finalY = ry + rotatedH / 2;
    return { x: finalX / rotatedW, y: finalY / rotatedH, size: sizePx / Math.min(rotatedW, rotatedH) };
}

function renderComposite(w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    const canvasRatio = w / h;
    const videoRatio = rawVideoWidth / rawVideoHeight;
    let sx, sy, sWidth, sHeight;
    if (videoRatio > canvasRatio) {
        sHeight = rawVideoHeight;
        sWidth = sHeight * canvasRatio;
        sx = (rawVideoWidth - sWidth) / 2;
        sy = 0;
    } else {
        sWidth = rawVideoWidth;
        sHeight = sWidth / canvasRatio;
        sx = 0;
        sy = (rawVideoHeight - sHeight) / 2;
    }

    if (currentFacingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, w, h);
    ctx.drawImage(arCanvas, sx, sy, sWidth, sHeight, 0, 0, w, h);
    ctx.restore();
}

// ---- 保存用回転補正・撮影 ----
function getPhotoRotationRad() {
    if (lockedMode) {
        if (isUpsideDown) return Math.PI;
        if (lockedEarlyZone === 'cw') return Math.PI / 2;
        if (lockedEarlyZone === 'ccw') return -Math.PI / 2;
        return 0;
    }
    if (isUpsideDown) return -Math.PI / 2;
    return 0;
}

function getPhotoCanvas() {
    const rotateRad = getPhotoRotationRad();
    if (rotateRad === 0) return outputCanvas;

    const isQuarterTurn = Math.abs(rotateRad) === Math.PI / 2;
    const rotated = document.createElement('canvas');
    rotated.width = isQuarterTurn ? outputCanvas.height : outputCanvas.width;
    rotated.height = isQuarterTurn ? outputCanvas.width : outputCanvas.height;
    const rctx = rotated.getContext('2d');
    rctx.translate(rotated.width / 2, rotated.height / 2);
    rctx.rotate(rotateRad);
    rctx.drawImage(outputCanvas, -outputCanvas.width / 2, -outputCanvas.height / 2);
    return rotated;
}

export async function capturePhoto() {
    const photoCanvas = getPhotoCanvas();
    const blob = await new Promise((resolve) => photoCanvas.toBlob(resolve, 'image/png', 1.0));
    const dataUrl = photoCanvas.toDataURL('image/png');
    return { blob, dataUrl, faceRectsNormalized: lastFaceRectsNormalized };
}

export function isMaskVisible() {
    return maskVisible;
}

export function initArEngine(videoEl, canvasEl) {
    video = videoEl;
    outputCanvas = canvasEl;
    ctx = outputCanvas.getContext('2d', { alpha: false });
    video.addEventListener('resize', syncVideoDimensions);
    return initializeFaceLandmarker();
}
