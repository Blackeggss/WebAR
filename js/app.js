import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8";

const video = document.getElementById('webcam');
const outputCanvas = document.getElementById('output_canvas');
const ctx = outputCanvas.getContext('2d', { alpha: false });
const arCanvas = document.createElement('canvas');
const shutterBtn = document.getElementById('shutter_btn');
const switchCameraBtn = document.getElementById('switch_camera_btn');
const cameraPicker = document.getElementById('camera_picker');
const cameraPickerList = document.getElementById('camera_picker_list');
const flashOverlay = document.getElementById('flash_overlay');
const toastEl = document.getElementById('toast');
const arLoadingEl = document.getElementById('ar_loading');
let faceLandmarker;
let runningMode = "VIDEO";
let vfcLoopStarted = false;
let rafLoopRunning = false;
let currentFacingMode = 'user';
let currentStream = null;
let selectedDeviceId = null;
let needsRotationCorrection = false;
let rawVideoWidth = 0;
let rawVideoHeight = 0;
const ROTATION_CORRECTION_DEG = 90;

// マスクサイズ
const MASK_WIDTH = 1024 / 480 * 20;
const MASK_HEIGHT = 1024 / 630 * 25;

// マスク中心位置調整
const MASK_OFFSET = new THREE.Vector3(0, 2.3, 0);

// 仮想カメラの垂直画角
const VIRTUAL_CAMERA_VERTICAL_FOV = 63;
const NEAR = 1;
const FAR = 10000;

// マスクを隠す角度
const HIDE_YAW_THRESHOLD_DEG = 60;
const HIDE_PITCH_THRESHOLD_DEG = 60;

// 最大人数
const MAX_FACES = 4;

// トラッキングの検出
const TRACKING_MAX_MATCH_DISTANCE = 220;

// 追従の速さ
const POSITION_RESPONSIVENESS = 18;
const ROTATION_RESPONSIVENESS = 18;
const SCALE_RESPONSIVENESS = 18;

// Three.js
let scene, camera, renderer;
let maskMeshes = [];

const _matrix = new THREE.Matrix4();
const _euler = new THREE.Euler();
let lastTimestampSec = 0;

const _detPos = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());
const _detQuat = Array.from({ length: MAX_FACES }, () => new THREE.Quaternion());
const _detScale = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());

let slotActive = new Array(MAX_FACES).fill(false);

// 3D空間の初期化
function initThree() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(VIRTUAL_CAMERA_VERTICAL_FOV, 1, NEAR, FAR);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    renderer = new THREE.WebGLRenderer({ canvas: arCanvas, alpha: true, antialias: false });
    renderer.setPixelRatio(1);

    // モバイル用
    arCanvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        console.error('WebGLコンテキストが失われました。再読み込みします。');
        showToast('映像を再初期化しています…');
        setTimeout(() => window.location.reload(), 800);
    }, false);

    const textureLoader = new THREE.TextureLoader();
    const maskTexture = textureLoader.load('assets/base.png');
    maskTexture.colorSpace = THREE.SRGBColorSpace;
    maskTexture.generateMipmaps = false;
    maskTexture.minFilter = THREE.LinearFilter;
    maskTexture.magFilter = THREE.LinearFilter;

    const geometry = new THREE.PlaneGeometry(MASK_WIDTH, MASK_HEIGHT);
    const material = new THREE.MeshBasicMaterial({
        map: maskTexture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    for (let i = 0; i < MAX_FACES; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        scene.add(mesh);
        maskMeshes.push(mesh);
    }
}

// MediaPipe Tasks API
let modelReady = false;

function showArLoading() {
    if (modelReady) return;
    arLoadingEl.classList.add('ar_loading-show');
}

function hideArLoading() {
    modelReady = true;
    arLoadingEl.classList.remove('ar_loading-show');
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
            numFaces: MAX_FACES
        });
        hideArLoading();
    })();

    const cameraPromise = startCamera();
    await Promise.all([modelPromise, cameraPromise]);
}

const isMobile = matchMedia('(pointer: coarse)').matches;
const landscapeMql = matchMedia('(orientation: landscape)');

function getVideoConstraints() {
    if (!isMobile) {
        const base = { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } };
        return selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId }, ...base }
            : { facingMode: currentFacingMode, ...base };
    }
    return landscapeMql.matches
        ? { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } }
        : { facingMode: currentFacingMode, width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } };
}
function getOutputCanvasSize(dispWidth, dispHeight) {
    if (!isMobile) {
        return { width: dispWidth, height: dispHeight };
    }

    const targetRatio = landscapeMql.matches ? 4 / 3 : 3 / 4;
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
                const videoWidth = video.videoWidth;
                const videoHeight = video.videoHeight;
                const expectedPortrait = isMobile && !landscapeMql.matches;
                const actualPortrait = videoHeight >= videoWidth;
                needsRotationCorrection = expectedPortrait !== actualPortrait;

                rawVideoWidth = videoWidth;
                rawVideoHeight = videoHeight;

                const dispWidth = needsRotationCorrection ? videoHeight : videoWidth;
                const dispHeight = needsRotationCorrection ? videoWidth : videoHeight;
                const { width: canvasWidth, height: canvasHeight } = getOutputCanvasSize(dispWidth, dispHeight);

                outputCanvas.width = canvasWidth;
                outputCanvas.height = canvasHeight;

                arCanvas.width = videoWidth;
                arCanvas.height = videoHeight;
                renderer.setSize(videoWidth, videoHeight, false);

                camera.aspect = videoWidth / videoHeight;
                camera.updateProjectionMatrix();
                startFrameLoop();
                showArLoading();
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

let orientationDebounceTimer = null;
let orientationRestartInProgress = false;
let orientationRestartQueued = false;

function runOrientationRestart() {
    if (orientationRestartInProgress) {
        orientationRestartQueued = true;
        return;
    }
    orientationRestartInProgress = true;
    startCamera()
        .catch((err) => console.error("向き変更に伴うカメラ再起動に失敗しました: ", err))
        .finally(() => {
            orientationRestartInProgress = false;
            if (orientationRestartQueued) {
                orientationRestartQueued = false;
                runOrientationRestart();
            }
        });
}

if (isMobile) {
    landscapeMql.addEventListener('change', () => {
        clearTimeout(orientationDebounceTimer);
        orientationDebounceTimer = setTimeout(runOrientationRestart, 200);
    });
}

// カメラ切り替えボタン
async function switchCamera() {
    if (!isMobile) {
        toggleCameraPicker();
        return;
    }

    switchCameraBtn.disabled = true;
    const previousFacingMode = currentFacingMode;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

    try {
        await startCamera();
    } catch (err) {
        currentFacingMode = previousFacingMode;
        showToast('カメラを切り替えられませんでした');
        try {
            await startCamera();
        } catch (err2) {
            console.error("カメラの復帰にも失敗しました: ", err2);
        }
    } finally {
        switchCameraBtn.disabled = false;
    }
}

switchCameraBtn.addEventListener('click', switchCamera);

// PC用カメラ選択
function toggleCameraPicker() {
    if (!cameraPicker.hidden) {
        closeCameraPicker();
    } else {
        openCameraPicker();
    }
}

async function openCameraPicker() {
    let devices;
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
        console.error("カメラ一覧の取得に失敗しました: ", err);
        showToast('カメラ一覧を取得できませんでした');
        return;
    }

    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    if (videoInputs.length === 0) {
        showToast('利用できるカメラが見つかりませんでした');
        return;
    }

    cameraPickerList.innerHTML = '';
    videoInputs.forEach((device, index) => {
        const li = document.createElement('li');
        li.textContent = device.label || `カメラ ${index + 1}`;
        if (device.deviceId === selectedDeviceId) {
            li.classList.add('selected');
        }
        li.addEventListener('click', () => selectCamera(device.deviceId));
        cameraPickerList.appendChild(li);
    });

    const rect = switchCameraBtn.getBoundingClientRect();
    cameraPicker.style.right = `${window.innerWidth - rect.left + 12}px`;
    cameraPicker.style.top = `${rect.top}px`;

    cameraPicker.hidden = false;
    document.addEventListener('click', handleCameraPickerOutsideClick, true);
}

function closeCameraPicker() {
    cameraPicker.hidden = true;
    document.removeEventListener('click', handleCameraPickerOutsideClick, true);
}

function handleCameraPickerOutsideClick(event) {
    if (cameraPicker.contains(event.target) || switchCameraBtn.contains(event.target)) {
        return;
    }
    closeCameraPicker();
}

async function selectCamera(deviceId) {
    if (deviceId === selectedDeviceId) {
        closeCameraPicker();
        return;
    }
    const previousDeviceId = selectedDeviceId;
    selectedDeviceId = deviceId;
    closeCameraPicker();

    try {
        await startCamera();
    } catch (err) {
        selectedDeviceId = previousDeviceId;
        showToast('カメラを切り替えられませんでした');
        try {
            await startCamera();
        } catch (err2) {
            console.error("カメラの復帰にも失敗しました: ", err2);
        }
    }
}

// 検出・合成

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

// タイムスタンプエラーの回避
let lastFedTimestampMs = -1;
function nextMonotonicTimestampMs() {
    let t = performance.now();
    if (t <= lastFedTimestampMs) {
        t = lastFedTimestampMs + 1;
    }
    lastFedTimestampMs = t;
    return t;
}

function renderFrame(timestampMs) {
    if (faceLandmarker) {
        const results = faceLandmarker.detectForVideo(video, timestampMs);
        applyResults(results, timestampMs);
    }
    renderer.render(scene, camera);
    renderComposite(outputCanvas.width, outputCanvas.height, timestampMs / 1000);
}

function onVideoFrame(_now, metadata) {
    try {
        renderFrame(nextMonotonicTimestampMs());
    } catch (err) {
        console.error("フレーム描画中にエラーが発生しました: ", err);
    }
    video.requestVideoFrameCallback(onVideoFrame);
}

let lastVideoTime = -1;
function predictLoopFallback() {
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

// 複数人＋トラッキング
function applyResults(results, timestampMs) {
    const matrices = results.facialTransformationMatrixes;

    const nowSec = timestampMs / 1000;
    const dt = lastTimestampSec ? Math.max(0, nowSec - lastTimestampSec) : 1 / 60;
    lastTimestampSec = nowSec;

    const posT = 1 - Math.exp(-POSITION_RESPONSIVENESS * dt);
    const rotT = 1 - Math.exp(-ROTATION_RESPONSIVENESS * dt);
    const scaleT = 1 - Math.exp(-SCALE_RESPONSIVENESS * dt);

    const faceCount = matrices ? Math.min(matrices.length, maskMeshes.length) : 0;

    for (let i = 0; i < faceCount; i++) {
        _matrix.fromArray(matrices[i].data);
        _matrix.decompose(_detPos[i], _detQuat[i], _detScale[i]);
    }

    const assignedSlotOfDetection = new Array(faceCount).fill(-1);
    const slotUsedThisFrame = new Array(maskMeshes.length).fill(false);

    const candidatePairs = [];
    for (let i = 0; i < faceCount; i++) {
        for (let j = 0; j < maskMeshes.length; j++) {
            if (!slotActive[j]) continue;
            const dist = _detPos[i].distanceTo(maskMeshes[j].position);
            if (dist <= TRACKING_MAX_MATCH_DISTANCE) {
                candidatePairs.push({ i, j, dist });
            }
        }
    }
    candidatePairs.sort((a, b) => a.dist - b.dist);

    for (const pair of candidatePairs) {
        if (assignedSlotOfDetection[pair.i] !== -1) continue;
        if (slotUsedThisFrame[pair.j]) continue;
        assignedSlotOfDetection[pair.i] = pair.j;
        slotUsedThisFrame[pair.j] = true;
    }

    for (let i = 0; i < faceCount; i++) {
        if (assignedSlotOfDetection[i] !== -1) continue;
        const freeSlot = slotUsedThisFrame.indexOf(false);
        if (freeSlot === -1) continue;
        assignedSlotOfDetection[i] = freeSlot;
        slotUsedThisFrame[freeSlot] = true;
    }

    const nextSlotActive = new Array(maskMeshes.length).fill(false);

    for (let i = 0; i < faceCount; i++) {
        const slot = assignedSlotOfDetection[i];
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

        nextSlotActive[slot] = true;

        if (facingAway) {
            mesh.visible = false;
            mesh.position.lerp(targetPos, posT);
            continue;
        }

        mesh.visible = true;

        if (MASK_OFFSET.lengthSq() > 0) {
            targetPos.add(MASK_OFFSET.clone().applyQuaternion(targetQuat));
        }

        mesh.position.lerp(targetPos, posT);
        mesh.quaternion.slerp(targetQuat, rotT);
        mesh.scale.lerp(targetScale, scaleT);
    }

    for (let j = 0; j < maskMeshes.length; j++) {
        if (!nextSlotActive[j]) {
            maskMeshes[j].visible = false;
        }
    }
    slotActive = nextSlotActive;
}

// 合成描画
function renderComposite(w, h, timeSec) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    if (needsRotationCorrection) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate((ROTATION_CORRECTION_DEG * Math.PI) / 180);
        ctx.translate(-rawVideoWidth / 2, -rawVideoHeight / 2);
    }
    if (currentFacingMode === 'user') {
        ctx.translate(rawVideoWidth, 0);
        ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0, rawVideoWidth, rawVideoHeight);
    ctx.drawImage(arCanvas, 0, 0, rawVideoWidth, rawVideoHeight);
    ctx.restore();
}

// シャッター
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

async function takePhoto() {
    flashEffect();

    const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, 'image/png', 1.0));
    if (!blob) {
        showToast('撮影に失敗しました');
        return;
    }

    const fileName = `photo_${Date.now()}.png`;
    const file = new File([blob], fileName, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file] });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                return;
            }
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('ダウンロードしました');
}

shutterBtn.addEventListener('click', takePhoto);

// 実行
initializeFaceLandmarker();