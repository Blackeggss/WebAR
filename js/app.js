import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8";

const video = document.getElementById('webcam');
const outputCanvas = document.getElementById('output_canvas');
const ctx = outputCanvas.getContext('2d');
const arCanvas = document.createElement('canvas');
const shutterBtn = document.getElementById('shutter_btn');
const switchCameraBtn = document.getElementById('switch_camera_btn');
const cameraPicker = document.getElementById('camera_picker');
const cameraPickerList = document.getElementById('camera_picker_list');
const flashOverlay = document.getElementById('flash_overlay');
const toastEl = document.getElementById('toast');

let faceLandmarker;
let runningMode = "VIDEO";
let currentFacingMode = 'user';
let currentStream = null;
let selectedDeviceId = null;

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

// 大きい玉
const ORB_COUNT = 16;                 // 玉の数
const ORB_MIN_SIZE_RATIO = 0.055;     // 最小サイズの比率
const ORB_MAX_SIZE_RATIO = 0.16;      // 最大サイズの比率
const ORB_MAX_ALPHA = 0.5;            // 一番明るい時の不透明度
const ORB_MIN_ALPHA_RATIO = 0.35;     // 最大値に対する下限の比率
const ORB_DRIFT_SPEED_MIN = 0.006;    // 秒速の割合
const ORB_DRIFT_SPEED_MAX = 0.016;
const ORB_TWINKLE_SPEED_MIN = 0.15;   // 明滅の速さ
const ORB_TWINKLE_SPEED_MAX = 0.4;
const ORB_TURN_SPEED = 0.6;           // 漂う方向が変化する速さ

// 小さい玉
const STAR_COUNT = 140;
const STAR_Z_NEAR = 40;     // 最近距離
const STAR_Z_FAR = 900;     // 出現場所
const STAR_FOCAL = 300;     // 奥行
const STAR_BASE_SPEED = 130;  // 流れる速さ
const STAR_BASE_SIZE = 5.5;   // サイズ
const STAR_MAX_ALPHA = 0.55;  // 一番明るい時の不透明度

// 放射点の位置。
// 0〜1 (0,0)=左上 (1,1)=右下
const STAR_ORIGIN_X_RATIO = 0.78;
const STAR_ORIGIN_Y_RATIO = 0.22;

// 白グロー
const GLOW_BASE_ALPHA = 0.1;
const GLOW_PULSE_AMPLITUDE = 0.05;
const GLOW_PULSE_SPEED = 0.6; // 1秒あたりの脈動速度

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
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    camera = new THREE.PerspectiveCamera(VIRTUAL_CAMERA_VERTICAL_FOV, 1, NEAR, FAR);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);

    renderer = new THREE.WebGLRenderer({ canvas: arCanvas, alpha: true, antialias: true });
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
async function initializeFaceLandmarker() {
    initThree();

    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: runningMode,
        numFaces: MAX_FACES
    });

    startCamera();
}

const isMobile = matchMedia('(pointer: coarse)').matches;
const landscapeMql = matchMedia('(orientation: landscape)');

function getVideoConstraints() {
    if (!isMobile) {
        const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
        return selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId }, ...base }
            : { facingMode: currentFacingMode, ...base };
    }
    return landscapeMql.matches
        ? { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: currentFacingMode, width: { ideal: 1080 }, height: { ideal: 1920 } };
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
                outputCanvas.width = videoWidth;
                outputCanvas.height = videoHeight;

                arCanvas.width = videoWidth;
                arCanvas.height = videoHeight;
                renderer.setSize(videoWidth, videoHeight, false);

                camera.aspect = videoWidth / videoHeight;
                camera.updateProjectionMatrix();
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
let rafLoopRunning = false;

function startFrameLoop() {
    if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(onVideoFrame);
    } else if (!rafLoopRunning) {
        rafLoopRunning = true;
        window.requestAnimationFrame(predictLoopFallback);
    }
}

function renderFrame(timestampMs) {
    const results = faceLandmarker.detectForVideo(video, timestampMs);
    applyResults(results, timestampMs);
    renderer.render(scene, camera);
    renderComposite(outputCanvas.width, outputCanvas.height, timestampMs / 1000);
}

function onVideoFrame(_now, metadata) {
    try {
        renderFrame(metadata.mediaTime * 1000);
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
            renderFrame(performance.now());
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
    if (currentFacingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.drawImage(arCanvas, 0, 0, w, h);
    ctx.restore();

    // 白グロー
    drawGlow(w, h, timeSec);

    // 大きい玉
    updateAndDrawOrbs(w, h, timeSec);

    // 小さい玉
    updateAndDrawStars(w, h, timeSec);
}

function drawGlow(w, h, timeSec) {
    const alpha = GLOW_BASE_ALPHA + GLOW_PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(timeSec * GLOW_PULSE_SPEED));
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// パーティクル
const GLOW_SPRITE_SIZE = 128;
function createGlowSprite() {
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = GLOW_SPRITE_SIZE;
    spriteCanvas.height = GLOW_SPRITE_SIZE;
    const spriteCtx = spriteCanvas.getContext('2d');
    const r = GLOW_SPRITE_SIZE / 2;
    const gradient = spriteCtx.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    spriteCtx.fillStyle = gradient;
    spriteCtx.beginPath();
    spriteCtx.arc(r, r, r, 0, Math.PI * 2);
    spriteCtx.fill();
    return spriteCanvas;
}
const glowSprite = createGlowSprite();

// モバイル用
const IS_LOW_POWER_DEVICE = matchMedia('(pointer: coarse)').matches;
const EFFECTIVE_ORB_COUNT = IS_LOW_POWER_DEVICE ? Math.round(ORB_COUNT * 0.75) : ORB_COUNT;
const EFFECTIVE_STAR_COUNT = IS_LOW_POWER_DEVICE ? Math.round(STAR_COUNT * 0.6) : STAR_COUNT;

// 大きい玉の処理
let orbs = null;
let orbsW = 0;
let orbsH = 0;

function createOrbs(w, h) {
    const cols = Math.max(1, Math.round(Math.sqrt(EFFECTIVE_ORB_COUNT * (w / h))));
    const rows = Math.max(1, Math.ceil(EFFECTIVE_ORB_COUNT / cols));
    const cellW = w / cols;
    const cellH = h / rows;

    const list = [];
    for (let idx = 0; idx < EFFECTIVE_ORB_COUNT; idx++) {
        const col = idx % cols;
        const row = Math.floor(idx / cols) % rows;
        const cellCx = (col + 0.5) * cellW;
        const cellCy = (row + 0.5) * cellH;

        list.push({
            x: cellCx + (Math.random() * 2 - 1) * cellW * 0.35,
            y: cellCy + (Math.random() * 2 - 1) * cellH * 0.35,
            sizeRatio: ORB_MIN_SIZE_RATIO + Math.random() * (ORB_MAX_SIZE_RATIO - ORB_MIN_SIZE_RATIO),
            driftAngle: Math.random() * Math.PI * 2,
            driftSpeed: (ORB_DRIFT_SPEED_MIN + Math.random() * (ORB_DRIFT_SPEED_MAX - ORB_DRIFT_SPEED_MIN)) * Math.min(w, h),
            turnPhase: Math.random() * Math.PI * 2,
            turnSpeed: ORB_TURN_SPEED * (0.5 + Math.random()),
            twinklePhase: Math.random() * Math.PI * 2,
            twinkleSpeed: ORB_TWINKLE_SPEED_MIN + Math.random() * (ORB_TWINKLE_SPEED_MAX - ORB_TWINKLE_SPEED_MIN),
            alphaVariance: 0.7 + Math.random() * 0.3
        });
    }
    return list;
}

let lastOrbTimeSec = 0;

function updateAndDrawOrbs(w, h, timeSec) {
    if (!orbs || orbsW !== w || orbsH !== h) {
        orbs = createOrbs(w, h);
        orbsW = w;
        orbsH = h;
    }

    const dt = lastOrbTimeSec ? Math.max(0, timeSec - lastOrbTimeSec) : 1 / 60;
    lastOrbTimeSec = timeSec;

    const minSide = Math.min(w, h);
    const margin = minSide * ORB_MAX_SIZE_RATIO;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (const orb of orbs) {
        orb.turnPhase += orb.turnSpeed * dt;
        orb.driftAngle += Math.sin(orb.turnPhase) * 0.4 * dt;

        orb.x += Math.cos(orb.driftAngle) * orb.driftSpeed * dt;
        orb.y += Math.sin(orb.driftAngle) * orb.driftSpeed * dt;

        if (orb.x < -margin) orb.x = w + margin;
        if (orb.x > w + margin) orb.x = -margin;
        if (orb.y < -margin) orb.y = h + margin;
        if (orb.y > h + margin) orb.y = -margin;

        const twinkle = 0.5 + 0.5 * Math.sin(timeSec * orb.twinkleSpeed + orb.twinklePhase);
        const alphaBase = ORB_MAX_ALPHA * orb.alphaVariance;
        const alpha = alphaBase * (ORB_MIN_ALPHA_RATIO + (1 - ORB_MIN_ALPHA_RATIO) * twinkle);
        const size = orb.sizeRatio * minSide;

        ctx.globalAlpha = alpha;
        ctx.drawImage(glowSprite, orb.x - size, orb.y - size, size * 2, size * 2);
    }

    ctx.restore();
}

// 小さい玉の処理
function createStar() {
    return {
        wx: (Math.random() * 2 - 1) * 480,
        wy: (Math.random() * 2 - 1) * 480,
        z: STAR_Z_FAR * (0.35 + Math.random() * 0.65),
        speed: STAR_BASE_SPEED * (0.6 + Math.random() * 0.8),
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 1.5 + Math.random() * 2.5
    };
}

const stars = Array.from({ length: EFFECTIVE_STAR_COUNT }, createStar);
let lastStarTimeSec = 0;

function updateAndDrawStars(w, h, timeSec) {
    const dt = lastStarTimeSec ? Math.max(0, timeSec - lastStarTimeSec) : 1 / 60;
    lastStarTimeSec = timeSec;

    const cx = w * STAR_ORIGIN_X_RATIO;
    const cy = h * STAR_ORIGIN_Y_RATIO;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const star of stars) {
        star.z -= star.speed * dt;
        if (star.z <= STAR_Z_NEAR) {
            const fresh = createStar();
            fresh.z = STAR_Z_FAR;
            Object.assign(star, fresh);
        }

        const scale = STAR_FOCAL / star.z;
        const sx = cx + star.wx * scale;
        const sy = cy + star.wy * scale;

        if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;

        const depthT = 1 - (star.z - STAR_Z_NEAR) / (STAR_Z_FAR - STAR_Z_NEAR); // 0(奥)〜1(手前)
        const fadeIn = Math.min(1, (STAR_Z_FAR - star.z) / 120);   // フェードイン
        const fadeOut = Math.min(1, (star.z - STAR_Z_NEAR) / 80);  // フェードアウト
        const twinkle = 0.5 + 0.5 * Math.sin(timeSec * star.twinkleSpeed + star.phase);
        const alpha = Math.max(0, Math.min(STAR_MAX_ALPHA, depthT * twinkle * fadeIn * fadeOut));

        if (alpha <= 0.01) continue;

        const size = Math.max(0.4, STAR_BASE_SIZE * scale * 0.12);
        const drawSize = size * 8; // 直径

        ctx.globalAlpha = alpha;
        ctx.drawImage(glowSprite, sx - drawSize / 2, sy - drawSize / 2, drawSize, drawSize);
    }

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