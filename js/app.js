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
    return landscapeMql.matches
        ? { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } }
        : { facingMode: currentFacingMode, width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } };
}
function getOutputCanvasSize(dispWidth, dispHeight) {
    if (!isMobile) {
        return { width: dispWidth, height: dispHeight };
    }

    const isRotatedSideways = rotationState !== 'none';
    const targetRatio = isRotatedSideways ? 4 / 3 : 3 / 4;
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

// 端末の物理的な回転方向を検出する('none'=縦持ち / 'cw'=時計回り(45〜180度) / 'ccw'=反時計回り(-45〜-180度))
// 135〜180度/-135〜-180度(上下逆さま付近)は独立した状態を持たず、直前のcw/ccwの位置を維持する
//
// screen.orientation / window.orientation はOSが要約した回転状態のため、
// 180度(上下逆さま)を経由する回転でOS側が古い値のまま固まることがある(特にiPhone)。
// また deviceorientation の gamma 値は「端末を垂直に構えている」前提の値のため、
// 顔合わせのために端末を前後に傾ける(beta変化)とgamma自体が歪み、誤検知の原因になる。
// そこで、iPhone純正のUI回転と同じ「重力ベクトルを画面平面に投影してロール角を出す」方式
// (devicemotionのaccelerationIncludingGravity)を最優先で使い、前後の傾きの影響を受けないようにする。
// ※実機で左右の対応が逆に感じる場合はROLL_SIGN/GAMMA_SIGNを-1に、角度方式の場合は下の2配列を入れ替えてください
const ROTATION_CW_ANGLES = [270];
const ROTATION_CCW_ANGLES = [90];

const ROLL_SIGN = 1;
const GAMMA_SIGN = 1;

// 縦持ちを0度、時計回りを正として3分割 (-45〜45:縦, 45〜180:cw, -45〜-180:ccw)
// HYSTERESISは境界付近でのちらつき防止用の最小限の遊び
const ZONE_BOUNDARY_1 = 45;
const HYSTERESIS = 5;
// atan2の出力は180度と-180度の境界で数値上不連続にジャンプする(実際の回転は連続している)。
// 45〜135を通って180(-180)に達した場合は-135まで、-45〜-135を通って-180(180)に達した場合は135まで、
// 同じ向きを維持したまま折り返しをまたげるようにする境界値。
const ZONE_BOUNDARY_WRAP_HOLD = 135;

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
    // 実際の描画(renderComposite)は元映像を無回転のまま中央クロップして敷き詰めるだけなので、
    // ここでは元映像のネイティブ寸法をそのまま渡す(縦横を入れ替えない)。
    // rotationStateによる縦横比の切り替えはgetOutputCanvasSize内のtargetRatioが担う。
    const { width, height } = getOutputCanvasSize(rawVideoWidth, rawVideoHeight);
    outputCanvas.width = width;
    outputCanvas.height = height;
}

// OSの画面ロック(回転ロック)がかかっていると、物理的に端末を回転させてもページのCSSレイアウト
// (matchMediaのorientation)は変化しない。センサーは画面ロックと無関係に動き続けるため、
// 「実際に50度以上はっきり傾けた瞬間に、ページの向きが追従しているかどうか」を見ればロックの有無を
// 判定できる。追従していれば(=一致)即座にロックなしと確定する。ただし追従にはOS側のネイティブな
// 回転リフローの遅延があり、センサーが50度に達する速さの方が勝ることがあるため、まだ追従していない
// 場合はすぐにロック確定とはせず、ORIENTATION_LOCK_GRACE_MSだけ待って再確認する
// (この間に追従すればロックなし、追従しなければロック中と確定する)。
//
// この判定は起動直後に1回だけ行う(常時チェックし続けるとセンサー処理のコストがかかり続けるうえ、
// ユーザーが実際に端末を回転させるまで判定が確定しないため)。起動時にオーバーレイでアニメーションと
// 案内文を表示して端末を傾けてもらい、判定が確定し次第オーバーレイを消して、
// ロック中なら0度の状態に固定したまま以後は何もしない、ロックなしなら通常の追従動作に切り替える。
const ORIENTATION_LOCK_CHECK_ANGLE = 50; // この角度をはっきり超えたらページの追従状況を見始める
const ORIENTATION_LOCK_GRACE_MS = 500; // OS側のネイティブ回転リフローが追いつくのを待つ猶予
const ORIENTATION_CHECK_NUDGE_MS = 3000; // この時間、境界を超えなければ「もう少し傾けてください」を表示
const ORIENTATION_CHECK_SAFETY_TIMEOUT_MS = 15000; // センサーが使えない等の異常時にオーバーレイが残り続けないための保険
let orientationCheckDone = false;
let lockedMode = false;
let orientationCheckNudgeTimeoutId = null;
let orientationCheckSafetyTimeoutId = null;
let lockCheckPendingSinceMs = null;

function showOrientationCheckUI(text) {
    motionPermissionOverlay.hidden = false;
    motionPermissionText.textContent = text;
}

function hideOrientationCheckUI() {
    motionPermissionOverlay.hidden = true;
}

function finishOrientationCheck(locked) {
    if (orientationCheckDone) return;
    orientationCheckDone = true;
    lockedMode = locked;
    clearTimeout(orientationCheckNudgeTimeoutId);
    clearTimeout(orientationCheckSafetyTimeoutId);
    hideOrientationCheckUI();
    if (locked && rotationState !== 'none') {
        rotationState = 'none';
        document.documentElement.setAttribute('data-rotation', 'none');
        updateOutputCanvasSize();
    }
}

// 起動直後の1回だけ呼ばれる判定処理。50度をはっきり超えたら、ページの向きが追従しているかを見る。
// 追従していれば即座にロックなしと確定。追従していなければ、OS側のリフロー遅延の可能性があるため
// ORIENTATION_LOCK_GRACE_MSだけ待って再確認し、それでも追従しなければロック中と確定する。
function runOrientationCheck() {
    if (orientationCheckDone || !rollAvailable) return;
    if (Math.abs(latestRollDeg) < ORIENTATION_LOCK_CHECK_ANGLE) return;

    if (landscapeMql.matches) {
        rotationState = computeRotationState();
        document.documentElement.setAttribute('data-rotation', rotationState);
        updateOutputCanvasSize();
        showToast(`ロック解除 angle:${Math.round(latestRollDeg)} state:${rotationState} attr:${document.documentElement.getAttribute('data-rotation')}`);
        finishOrientationCheck(false);
        return;
    }

    // まだページが追従していない: OS側のリフローが追いついていないだけの可能性があるので少し待つ
    if (lockCheckPendingSinceMs === null) {
        lockCheckPendingSinceMs = Date.now();
        return;
    }
    if (Date.now() - lockCheckPendingSinceMs >= ORIENTATION_LOCK_GRACE_MS) {
        showToast(`ロック検出 angle:${Math.round(latestRollDeg)}`);
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
    showToast(`追従更新 angle:${Math.round(latestRollDeg)} state:${rotationState}`);
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

                rawVideoWidth = videoWidth;
                rawVideoHeight = videoHeight;

                updateOutputCanvasSize();

                arCanvas.width = videoWidth;
                arCanvas.height = videoHeight;
                renderer.setSize(videoWidth, videoHeight, false);

                camera.aspect = videoWidth / videoHeight;
                camera.updateProjectionMatrix();
                startFrameLoop();
                showArLoading();
                showToast(`raw:${videoWidth}x${videoHeight} canvas:${outputCanvas.width}x${outputCanvas.height}`);
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

let rotationDebounceTimer = null;
function scheduleRotationUpdate() {
    clearTimeout(rotationDebounceTimer);
    rotationDebounceTimer = setTimeout(() => {
        if (!orientationCheckDone || lockedMode) return;
        applyRotationState();
    }, 150);
}

// 重力ベクトル(画面のX/Y平面への投影)からロール角を求める。
// 前後の傾き(pitch)を変えても、端末自身のZ軸(画面を貫く軸)まわりの回転(=ロール)には影響しないため、
// 顔を画角に収めるために端末を前後に傾ける操作では誤検知しない。
// 顔合わせのため端末をやや後ろに傾けて構えると重力のXY成分が小さくなり、
// atan2の結果がノイズで揺れやすくなる(=縦のつもりでも左右に振れて見える原因)。
// 平滑化(指数移動平均)とやや広めの無効化しきい値でこれを抑える。
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
    // 第2引数(Y)の符号を反転: 実機では「縦持ち(0度)」と「上下逆さま(180度)」が
    // 逆に計算されていたため補正(左右cw/ccwの判定軸には影響しない)
    latestRollDeg = Math.atan2(smoothedAx * ROLL_SIGN, -smoothedAy) * 180 / Math.PI;

    if (!orientationCheckDone) {
        runOrientationCheck();
        return;
    }
    if (lockedMode) return;
    applyRotationState();
}

// devicemotionが使えない端末向けのフォールバック
// (gamma単体では折り返し等の判定に使えないため、ロック判定自体はタイムアウトに任せる)
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

const ORIENTATION_CHECK_MAIN_TEXT = 'スマホを左右どちらかに\n90度まで傾けてください';
const ORIENTATION_CHECK_NUDGE_TEXT = 'もう少し傾けてください';

function beginOrientationCheck() {
    showOrientationCheckUI(ORIENTATION_CHECK_MAIN_TEXT);
    startRotationSensors();
    orientationCheckNudgeTimeoutId = setTimeout(() => {
        if (!orientationCheckDone) {
            motionPermissionText.textContent = ORIENTATION_CHECK_NUDGE_TEXT;
        }
    }, ORIENTATION_CHECK_NUDGE_MS);
    orientationCheckSafetyTimeoutId = setTimeout(() => finishOrientationCheck(false), ORIENTATION_CHECK_SAFETY_TIMEOUT_MS);
}

function requestPermissionThenBeginCheck() {
    requestMotionPermissions()
        .then((results) => {
            if (results.length > 0 && results.every((r) => r === 'granted')) {
                beginOrientationCheck();
            } else {
                finishOrientationCheck(false);
            }
        })
        .catch((err) => {
            console.error("モーション許可の取得に失敗しました: ", err);
            finishOrientationCheck(false);
        });
}

function showTapToStartUI() {
    showOrientationCheckUI('タップして開始');
    motionPermissionOverlay.addEventListener('click', function onTapToStart() {
        motionPermissionOverlay.removeEventListener('click', onTapToStart);
        requestPermissionThenBeginCheck();
    }, { once: true });
}

// カメラ許可が確定した(=getUserMediaが成功した)タイミングで呼ばれる。
//
// iOSはモーション許可の取得に実際のタップ操作が必須(初回訪問時はタップなしで許可ダイアログを
// 出すことができない)。ただし一度許可済みなら、タップなし(ユーザー操作なし)で
// requestPermission()を呼んでも即座に'granted'で解決される。そこでまず静かに1回試し、
// 既に許可済みならタップなしでそのまま検知に入る。未許可(主に初回訪問)の場合は、
// タップが必要なことが伝わるよう「タップして開始」を表示してタップを待ち、
// タップされたらモーション許可をリクエストしてから検知の表示・ロジックに入る。
function onCameraReady() {
    if (!needsMotionPermission) {
        beginOrientationCheck();
        return;
    }

    requestMotionPermissions()
        .then((results) => {
            if (results.length > 0 && results.every((r) => r === 'granted')) {
                beginOrientationCheck();
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
    landscapeMql.addEventListener('change', scheduleRotationUpdate);
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

    // 出力キャンバスのアスペクト比に合わせて元映像(arCanvasも同じ座標系)を中央クロップし、
    // キャンバス全体に等倍でスケールして敷き詰める(検出側のrawVideoWidth/Heightはそのまま利用)
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