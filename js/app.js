import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8";

const video = document.getElementById('webcam');
const outputCanvas = document.getElementById('output_canvas');
const ctx = outputCanvas.getContext('2d', { alpha: false });
const arCanvas = document.createElement('canvas');
// 上下さかさま時に顔検出用だけ90度回転した映像を渡す作業用canvas(合成結果には使わない)
const rotatedVideoCanvas = document.createElement('canvas');
const rotatedVideoCtx = rotatedVideoCanvas.getContext('2d', { alpha: false });
const shutterBtn = document.getElementById('shutter_btn');
const switchCameraBtn = document.getElementById('switch_camera_btn');
const cameraPicker = document.getElementById('camera_picker');
const cameraPickerList = document.getElementById('camera_picker_list');
const flashOverlay = document.getElementById('flash_overlay');
const toastEl = document.getElementById('toast');
const arLoadingEl = document.getElementById('ar_loading');
const motionPermissionOverlay = document.getElementById('motion_permission_overlay');
const motionPermissionText = document.getElementById('motion_permission_text');
let faceLandmarker;
let runningMode = "VIDEO";
let vfcLoopStarted = false;
let rafLoopRunning = false;
let currentFacingMode = 'user';
let currentStream = null;
let selectedDeviceId = null;
let rawVideoWidth = 0;
let rawVideoHeight = 0;
let rotationState = 'none'; // 'none' | 'cw' | 'ccw'

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
// 検出用に回転させた結果を元の映像座標系に戻す補正用スクラッチ(Z軸回転)
const _upsideDownAxis = new THREE.Vector3(0, 0, 1);
const _upsideDownCorrectionQuat = new THREE.Quaternion();
let lastTimestampSec = 0;

const _detPos = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());
const _detQuat = Array.from({ length: MAX_FACES }, () => new THREE.Quaternion());
const _detScale = Array.from({ length: MAX_FACES }, () => new THREE.Vector3());

const slotActive = new Array(MAX_FACES).fill(false);
// 毎フレームのGCを避けるため使い回すスクラッチ(applyResults内でのみ使用)
const _maskOffsetScratch = new THREE.Vector3();
const _assignedSlotOfDetection = new Array(MAX_FACES).fill(-1);
const _slotUsedThisFrame = new Array(MAX_FACES).fill(false);
const _nextSlotActive = new Array(MAX_FACES).fill(false);
const _candidatePairPool = Array.from({ length: MAX_FACES * MAX_FACES }, () => ({ i: 0, j: 0, dist: 0 }));
const _candidatePairs = [];

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
    const maskTexture = textureLoader.load('assets/base_copy.png');
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

    const cameraPromise = startCamera().then(() => {
        if (isMobile) {
            onCameraReady();
        }
    });
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
    // 画面の向きに関わらず常に同じ解像度(16:9)を要求し、クロップ時に細く切り取られる問題を防ぐ
    return { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } };
}
function getOutputCanvasSize(dispWidth, dispHeight) {
    if (!isMobile) {
        return { width: dispWidth, height: dispHeight };
    }

    // 横画面なら4:3、縦画面なら3:4にする
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

// 端末の物理回転方向を検出('none'/'cw'/'ccw')。screen.orientationは180度経由で値が固まることがあるため、重力ベクトルからロール角を出す方式(devicemotion)を優先使用(左右が逆なら ROLL_SIGN/GAMMA_SIGN を-1に)
const ROTATION_CW_ANGLES = [270];
const ROTATION_CCW_ANGLES = [90];

const ROLL_SIGN = 1;
const GAMMA_SIGN = 1;
// 上下さかさま時、顔検出用に映像を回転させる向き。実機で90度の左右が逆に感じる場合は-1にしてください。
const DETECTION_ROTATION_SIGN = 1;

// 縦持ちを0度として3分割(-45〜45:縦,45〜180:cw,-45〜-180:ccw)。HYSTERESISは境界のちらつき防止
const ZONE_BOUNDARY_1 = 45;
const HYSTERESIS = 5;
// atan2は±180度境界で不連続にジャンプするため、折り返しをまたいでも135度まで同じ向きを維持する境界値
const ZONE_BOUNDARY_WRAP_HOLD = 135;

// 端末が上下さかさま(±135度以降)かとその到達方向。ボタン位置やロック状態とは独立に常に判定する
const UPSIDE_DOWN_BOUNDARY = 135;
let upsideDownDir = 0; // 0=通常 / 1=時計回り経由(135度)で到達 / -1=反時計回り経由(-135度)で到達
let isUpsideDown = false;

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

// 画面ロック中専用の45度境界判定(135度以降はisUpsideDownが担当、ロックなしでは未使用)
let lockedEarlyZone = 'none'; // 'none' | 'cw' | 'ccw'

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

// 検出用回転角度を決定: ロックなしはブラウザが45〜135度分を肩代わりするため135度以降だけ90度補正、ロック中は自前で45度から90度・135度から180度を補正する
function getDetectionRotationRad() {
    if (lockedMode) {
        if (isUpsideDown) return Math.PI;
        if (lockedEarlyZone === 'cw') return -Math.PI / 2;
        if (lockedEarlyZone === 'ccw') return Math.PI / 2;
        return 0;
    }
    return isUpsideDown ? (-upsideDownDir * DETECTION_ROTATION_SIGN * (Math.PI / 2)) : 0;
}

let rollAvailable = false;
let latestRollDeg = 0;
let gammaAvailable = false;
let latestGamma = 0;

function getScreenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
        return screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
        return ((window.orientation % 360) + 360) % 360;
    }
    return 0;
}

function classifyAngle(angleDeg, previous) {
    if (previous === 'cw') {
        // 45〜180の通常域、または折り返し後の180(-180)〜-135は引き続きcwを維持
        const inHoldZone = angleDeg >= ZONE_BOUNDARY_1 - HYSTERESIS || angleDeg <= -ZONE_BOUNDARY_WRAP_HOLD;
        return inHoldZone ? 'cw' : 'none';
    }
    if (previous === 'ccw') {
        // -45〜-180の通常域、または折り返し後の-180(180)〜135は引き続きccwを維持
        const inHoldZone = angleDeg <= -(ZONE_BOUNDARY_1 - HYSTERESIS) || angleDeg >= ZONE_BOUNDARY_WRAP_HOLD;
        return inHoldZone ? 'ccw' : 'none';
    }
    if (angleDeg > ZONE_BOUNDARY_1 + HYSTERESIS) return 'cw';
    if (angleDeg < -(ZONE_BOUNDARY_1 + HYSTERESIS)) return 'ccw';
    return 'none';
}

function computeRotationState() {
    if (rollAvailable) {
        return classifyAngle(latestRollDeg, rotationState);
    }
    if (gammaAvailable) {
        return classifyAngle(latestGamma * GAMMA_SIGN, rotationState);
    }
    const angle = getScreenAngle();
    if (ROTATION_CW_ANGLES.includes(angle)) return 'cw';
    if (ROTATION_CCW_ANGLES.includes(angle)) return 'ccw';
    return 'none';
}

function updateOutputCanvasSize() {
    if (!rawVideoWidth || !rawVideoHeight) return;
    // renderCompositeは無回転で中央クロップするだけなので、元映像のネイティブ寸法をそのまま渡す
    const { width, height } = getOutputCanvasSize(rawVideoWidth, rawVideoHeight);
    outputCanvas.width = width;
    outputCanvas.height = height;
}

// 画面ロック中はCSSレイアウトが回転に追従しないことを利用してロックの有無を判定(50度傾いた時点でCSSが追従したか見て、追従なしがGRACE_MS続けばロック確定)
const ORIENTATION_LOCK_CHECK_ANGLE = 50; // この角度をはっきり超えたらページの追従状況を見始める
const ORIENTATION_LOCK_GRACE_MS = 500; // OS側のネイティブ回転リフローが追いつくのを待つ猶予
let orientationCheckDone = false;
let lockedMode = false;
let lockCheckPendingSinceMs = null;

function finishOrientationCheck(locked) {
    if (orientationCheckDone) return;
    orientationCheckDone = true;
    lockedMode = locked;
    if (locked && rotationState !== 'none') {
        rotationState = 'none';
        document.documentElement.setAttribute('data-rotation', 'none');
        updateOutputCanvasSize();
    }
}

// 50度を超えたらページ追従の有無を見て、追従していなければGRACE_MS待ってロック判定を確定する
function runOrientationCheck() {
    if (orientationCheckDone || !rollAvailable) return;
    if (Math.abs(latestRollDeg) < ORIENTATION_LOCK_CHECK_ANGLE) return;

    if (landscapeMql.matches) {
        rotationState = computeRotationState();
        document.documentElement.setAttribute('data-rotation', rotationState);
        updateOutputCanvasSize();
        finishOrientationCheck(false);
        return;
    }

    // まだページが追従していない: OS側のリフローが追いついていないだけの可能性があるので少し待つ
    if (lockCheckPendingSinceMs === null) {
        lockCheckPendingSinceMs = Date.now();
        return;
    }
    if (Date.now() - lockCheckPendingSinceMs >= ORIENTATION_LOCK_GRACE_MS) {
        finishOrientationCheck(true);
    }
}

// 判定確定後(ロックなし)に使う、通常の追従処理
function applyRotationState() {
    if (!isMobile) {
        if (rotationState !== 'none') {
            rotationState = 'none';
            document.documentElement.setAttribute('data-rotation', 'none');
            updateOutputCanvasSize();
        }
        return;
    }

    const candidate = computeRotationState();
    if (candidate === rotationState) return;
    rotationState = candidate;
    document.documentElement.setAttribute('data-rotation', rotationState);
    updateOutputCanvasSize();
}

// video要素の実解像度が変わった際に派生サイズを再同期する共通処理(loadeddata/resize両方から呼ばれる)
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
// srcObject差し替えだけでなくapplyConstraintsでの解像度変更時もこのイベントが発火する
video.addEventListener('resize', syncVideoDimensions);

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

// 画面回転時はgetUserMediaをやり直さずapplyConstraintsで解像度だけその場変更(通信を伴わないため高速、非対応端末のみ再起動にフォールバック)
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

// 重力ベクトルからロール角を求める(前後の傾きに影響されない)。ノイズ対策に平滑化と無効化しきい値を使用
let smoothedAx = 0;
let smoothedAy = 1;
const ROLL_SMOOTHING = 0.15;

function handleDeviceMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || typeof acc.x !== 'number' || typeof acc.y !== 'number') return;
    smoothedAx += (acc.x - smoothedAx) * ROLL_SMOOTHING;
    smoothedAy += (acc.y - smoothedAy) * ROLL_SMOOTHING;
    if (Math.hypot(smoothedAx, smoothedAy) < 2) return; // ほぼ水平(画面が真上/真下)で向きが定義できない場合は無視
    rollAvailable = true;
    // 第2引数(Y)の符号反転: 縦持ち(0度)と上下逆さま(180度)が逆算されていたための補正
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

// devicemotion非対応端末向けフォールバック(gamma単体では折り返し判定不可のためロック判定はタイムアウト任せ)
function handleDeviceOrientation(event) {
    if (rollAvailable || typeof event.gamma !== 'number') return;
    gammaAvailable = true;
    latestGamma = event.gamma;
    if (!orientationCheckDone || lockedMode) return;
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

const needsMotionPermission =
    (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') ||
    (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function');

function requestPermissionThenStartSensors() {
    requestMotionPermissions()
        .then((results) => {
            motionPermissionOverlay.hidden = true;
            if (results.length > 0 && results.every((r) => r === 'granted')) {
                startRotationSensors();
            }
        })
        .catch((err) => {
            console.error("モーション許可の取得に失敗しました: ", err);
            motionPermissionOverlay.hidden = true;
        });
}

function showTapToStartUI() {
    motionPermissionOverlay.hidden = false;
    motionPermissionText.textContent = 'タップして開始';
    motionPermissionOverlay.addEventListener('click', function onTapToStart() {
        motionPermissionOverlay.removeEventListener('click', onTapToStart);
        requestPermissionThenStartSensors();
    }, { once: true });
}

// カメラ許可確定時に呼ばれる。iOSは初回のみタップ必須のため、まず無タップで試し、未許可なら「タップして開始」を表示する
function onCameraReady() {
    if (!needsMotionPermission) {
        startRotationSensors();
        return;
    }

    requestMotionPermissions()
        .then((results) => {
            if (results.length > 0 && results.every((r) => r === 'granted')) {
                startRotationSensors();
            } else {
                showTapToStartUI();
            }
        })
        .catch(() => {
            showTapToStartUI();
        });
}

if (isMobile) {
    if (screen.orientation && screen.orientation.addEventListener) {
        screen.orientation.addEventListener('change', scheduleRotationUpdate);
    } else {
        window.addEventListener('orientationchange', scheduleRotationUpdate);
    }
    landscapeMql.addEventListener('change', () => {
        // 生映像の解像度を今の向きに再同期する(完了後resizeイベント経由でsyncVideoDimensionsが呼ばれる)
        scheduleOrientationResync();
        scheduleRotationUpdate();
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

let currentDetectionContainScale = 1;
let currentDetectionRotateRad = 0;

function renderFrame(timestampMs) {
    if (faceLandmarker) {
        // 顔検出は上向きの顔が前提のため、必要時だけ回転させた映像を渡す(表示側には影響しない、角度はgetDetectionRotationRad参照)
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
                // 90度回転: MediaPipeの奥行き計算はcanvasのアスペクト比に依存するため、canvasは元映像と同じ寸法にし内容は縮小して収める
                const rotatedContentWidth = rawVideoHeight; // 90度回転後の内容の自然な幅(=元の高さ)
                const rotatedContentHeight = rawVideoWidth; // 90度回転後の内容の自然な高さ(=元の幅)
                currentDetectionContainScale = Math.min(
                    rawVideoWidth / rotatedContentWidth,
                    rawVideoHeight / rotatedContentHeight
                );
            }
            // 180度回転は縦横が入れ替わらないため縮小不要(currentDetectionContainScaleは1のまま)
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

    if (currentDetectionRotateRad !== 0) {
        // 画像空間とThree.jsカメラ空間はY軸が逆だが符号はそのまま一致するため、検出時と同じ角度で逆補正して元の座標系に戻す
        _upsideDownCorrectionQuat.setFromAxisAngle(_upsideDownAxis, currentDetectionRotateRad);
    }

    for (let i = 0; i < faceCount; i++) {
        _matrix.fromArray(matrices[i].data);
        _matrix.decompose(_detPos[i], _detQuat[i], _detScale[i]);
        if (currentDetectionRotateRad !== 0) {
            _detPos[i].applyQuaternion(_upsideDownCorrectionQuat);
            _detQuat[i].premultiply(_upsideDownCorrectionQuat);
            // MediaPipeは検出canvasの高さ基準で奥行きを計算するため、containScale分の縮小でZだけが遠くズレる(scaleは常に1固定、X・Yは別経路なので触るとズレる)。Z成分だけcontainScale倍して戻す
            _detPos[i].z *= currentDetectionContainScale;
        }
    }

    // 以下、GC対策で毎フレームnew Array/new Objectせず使い回しのスクラッチに書き込む
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
}

// 合成描画
function renderComposite(w, h, timeSec) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // 出力キャンバスのアスペクト比に合わせて元映像を中央クロップし、キャンバス全体に敷き詰める
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

// 保存用画像だけの回転角度(ラジアン)。ロックの有無・向きの組み合わせで実機検証した値(プレビュー自体は無回転のまま)
function getPhotoRotationRad() {
    if (lockedMode) {
        if (isUpsideDown) return Math.PI; // 180度
        if (lockedEarlyZone === 'cw') return Math.PI / 2; // 90度(時計回り)
        if (lockedEarlyZone === 'ccw') return -Math.PI / 2; // -90度(反時計回り)
        return 0;
    }
    // ロック解除中は90度・-90度はブラウザの自動回転で正しくなるため触らず、180度だけ270度(=-90度)回転させる
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

async function takePhoto() {
    flashEffect();

    const photoCanvas = getPhotoCanvas();
    const blob = await new Promise((resolve) => photoCanvas.toBlob(resolve, 'image/png', 1.0));
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