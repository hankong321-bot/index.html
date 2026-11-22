import { ObjectDetector } from './vendor/mediapipe/vision_bundle.mjs';
import { FILTERS, getFilter, applyPreview, renderFiltered } from './filters.js';
import { Guide, pickSubject, LABEL_KO } from './guide.js';

// ---------------- 공통 ----------------
const $ = (s) => document.querySelector(s);
const el = {
  stage: $('#stage'), frame: $('#frame'), video: $('#video'), overlay: $('#overlay'),
  tint: $('#tint'), grain: $('#grain'), vignette: $('#vignette'),
  hint: $('#hint'), zoomSuggest: $('#zoomSuggest'), countdown: $('#countdown'), flash: $('#flash'),
  status: $('#status'), statusText: $('#statusText'), btnRetry: $('#btnRetry'),
  zoomRow: $('#zoomRow'), filterStrip: $('#filterStrip'), btnFilter: $('#btnFilter'),
  btnTimer: $('#btnTimer'), btnRatio: $('#btnRatio'), btnMenu: $('#btnMenu'),
  thumb: $('#thumb'), shutter: $('#shutter'), btnFlip: $('#btnFlip'),
  preview: $('#preview'), previewImg: $('#previewImg'),
  pvClose: $('#pvClose'), pvSave: $('#pvSave'), pvShare: $('#pvShare'),
  sheet: $('#sheet'), sheetClose: $('#sheetClose'), camInfo: $('#camInfo'),
  optAutoSave: $('#optAutoSave'), optHiRes: $('#optHiRes'), optHaptic: $('#optHaptic'),
  toast: $('#toast'),
};
const octx = el.overlay.getContext('2d');

const store = {
  get(k, d) { try { const v = localStorage.getItem('fm.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fm.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

const RATIOS = ['3:4', '1:1', '9:16', 'full'];
const TIMERS = [0, 3, 10];

const state = {
  facing: store.get('facing', 'environment'),
  ratio: store.get('ratio', '3:4'),
  timer: store.get('timer', 0),
  grid: store.get('grid', true),
  level: store.get('level', true),
  guide: store.get('guide', true),
  filter: store.get('filter', 'original'),
  autoSave: store.get('autoSave', true),
  hiRes: store.get('hiRes', true),
  haptic: store.get('haptic', true),

  stream: null, track: null, imageCapture: null,
  hwZoom: null,          // {min, max} 하드웨어 줌 지원 시
  zoom: 1,
  layout: { fw: 1, fh: 1, vw: 1, vh: 1, s: 1, offX: 0, offY: 0 },

  detector: null, detectorState: 'off', // off | loading | ready | error
  lastDetect: 0,
  subject: null, lastSeen: 0,
  analysis: null,
  suggestZoom: null, suggestSince: 0,

  tilt: null,            // 화면 기준 기울기 (도)
  busy: false,
  lastShot: null,        // {blob, url, name}
  wakeLock: null,
  starting: false,
};

const guide = new Guide();

function toast(msg, ms = 1800) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function setStatus(text, { retry = false } = {}) {
  if (!text) { el.status.classList.add('hidden'); return; }
  el.status.classList.remove('hidden');
  el.statusText.textContent = text;
  el.btnRetry.classList.toggle('hidden', !retry);
}

// ---------------- 카메라 ----------------
function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = state.track = state.imageCapture = null;
  el.video.srcObject = null;
  releaseWakeLock();
}

async function startCamera() {
  if (state.starting) return;
  state.starting = true;
  stopCamera();
  setStatus('카메라 준비 중…');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('카메라를 쓸 수 없어요.\nhttps:// 주소로 열었는지 확인해 주세요.', { retry: true });
      return;
    }
    const base = { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } };
    let stream;
    try {
      // zoom:true 를 함께 요청해야 Android Chrome 이 하드웨어 줌 값을 노출한다
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, zoom: true }, audio: false });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
    }
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    if (!el.video.videoWidth) await new Promise((r) => el.video.addEventListener('loadedmetadata', r, { once: true }));

    const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
    state.hwZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max } : null;
    state.imageCapture = 'ImageCapture' in window ? new ImageCapture(state.track) : null;
    state.zoom = state.hwZoom ? Math.max(1, state.hwZoom.min) : 1;
    if (state.hwZoom) applyHwZoom(state.zoom);

    el.video.style.transform = state.facing === 'user' ? 'scaleX(-1)' : '';
    guide.reset();
    state.subject = null;
    buildZoomChips();
    layout();
    updateCamInfo();
    setStatus(null);
    requestWakeLock();
  } catch (e) {
    console.error(e);
    const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    setStatus(denied
      ? '카메라 권한이 거부됐어요.\n주소창 왼쪽 자물쇠 → 권한 → 카메라 허용 후 다시 시도하세요.'
      : `카메라를 열지 못했어요. (${e.name || e.message})`, { retry: true });
  } finally {
    state.starting = false;
  }
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 무시 */ }
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* 무시 */ }
  state.wakeLock = null;
}

function updateCamInfo() {
  const s = state.track?.getSettings?.() || {};
  const zoomInfo = state.hwZoom ? `하드웨어 줌 ${state.hwZoom.min}–${state.hwZoom.max}x` : '디지털 줌 (최대 4x)';
  el.camInfo.textContent =
    `미리보기 해상도: ${el.video.videoWidth}×${el.video.videoHeight}\n` +
    `${zoomInfo} · 고화질 촬영 ${state.imageCapture ? '지원' : '미지원'}\n` +
    `AI 감지: ${{ off: '꺼짐', loading: '불러오는 중', ready: '사용 중', error: '오류' }[state.detectorState]}` +
    (s.deviceId ? '' : '');
}

// ---------------- 레이아웃 ----------------
function ratioValue() {
  switch (state.ratio) {
    case '3:4': return 3 / 4;
    case '1:1': return 1;
    case '9:16': return 9 / 16;
    default: return null;
  }
}

function layout() {
  const st = el.stage.getBoundingClientRect();
  if (!st.width || !st.height) return;
  const r = ratioValue();
  let fw, fh;
  if (!r) { fw = st.width; fh = st.height; }
  else if (st.width / st.height > r) { fh = st.height; fw = fh * r; }
  else { fw = st.width; fh = fw / r; }
  fw = Math.round(fw); fh = Math.round(fh);
  el.frame.style.width = fw + 'px';
  el.frame.style.height = fh + 'px';

  const vw = el.video.videoWidth || fw;
  const vh = el.video.videoHeight || fh;
  const dz = state.hwZoom ? 1 : state.zoom; // 하드웨어 줌이 없으면 화면을 키워서 디지털 줌
  const s = Math.max(fw / vw, fh / vh) * dz;
  const dw = vw * s, dh = vh * s;
  const offX = (fw - dw) / 2, offY = (fh - dh) / 2;
  Object.assign(el.video.style, { width: dw + 'px', height: dh + 'px', left: offX + 'px', top: offY + 'px' });

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  el.overlay.width = Math.round(fw * dpr);
  el.overlay.height = Math.round(fh * dpr);
  state.layout = { fw, fh, vw, vh, s, offX, offY, dpr };
}

// ---------------- 줌 ----------------
let zoomApplying = false;
let zoomPending = null;
async function applyHwZoom(z) {
  zoomPending = z;
  if (zoomApplying) return;
  zoomApplying = true;
  while (zoomPending != null) {
    const v = zoomPending;
    zoomPending = null;
    try { await state.track?.applyConstraints({ advanced: [{ zoom: v }] }); } catch (e) { console.warn('zoom', e); }
  }
  zoomApplying = false;
}

function zoomRange() {
  return state.hwZoom ? [state.hwZoom.min, state.hwZoom.max] : [1, 4];
}

function setZoom(z) {
  const [mn, mx] = zoomRange();
  z = Math.min(mx, Math.max(mn, Math.round(z * 10) / 10));
  if (z === state.zoom) return;
  state.zoom = z;
  if (state.hwZoom) applyHwZoom(z); else layout();
  state.suggestZoom = null;
  el.zoomSuggest.classList.add('hidden');
  updateZoomChips();
}

function zoomPresets() {
  const [mn, mx] = zoomRange();
  const list = [];
  if (mn < 0.95) list.push(mn);
  for (const p of [1, 2, 3, 5, 10]) if (p >= mn - 1e-6 && p <= mx + 1e-6) list.push(p);
  return list;
}

function buildZoomChips() {
  el.zoomRow.innerHTML = '';
  for (const p of zoomPresets()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'zoom-chip';
    b.dataset.z = p;
    b.addEventListener('click', () => setZoom(p));
    el.zoomRow.appendChild(b);
  }
  updateZoomChips();
}

function fmtZoom(z) { return (Math.round(z * 10) / 10).toString().replace(/\.0$/, '') + 'x'; }

function updateZoomChips() {
  const chips = [...el.zoomRow.children];
  // 현재 배율 이하에서 가장 가까운 프리셋 칩이 현재 배율을 표시
  let activeIdx = 0;
  chips.forEach((c, i) => { if (parseFloat(c.dataset.z) <= state.zoom + 1e-6) activeIdx = i; });
  chips.forEach((c, i) => {
    const active = i === activeIdx;
    c.classList.toggle('active', active);
    c.textContent = active ? fmtZoom(state.zoom) : fmtZoom(parseFloat(c.dataset.z));
  });
}

// 두 손가락 핀치 줌
(function setupPinch() {
  let startDist = 0, startZoom = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.frame.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { startDist = dist(e.touches); startZoom = state.zoom; }
  }, { passive: true });
  el.frame.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) { e.preventDefault(); setZoom(startZoom * dist(e.touches) / startDist); }
  }, { passive: false });
  el.frame.addEventListener('touchend', (e) => { if (e.touches.length < 2) startDist = 0; });
})();

// ---------------- 수평계 ----------------
window.addEventListener('devicemotion', (e) => {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  const ang = screen.orientation?.angle ?? window.orientation ?? 0;
  // 세로 화면에서만, 그리고 폰을 눕혀 들었을 때(바닥/하늘을 찍을 때)는 수평선 의미가 없으므로 끈다
  if (ang !== 0 || Math.abs(g.z ?? 0) > 8) { state.tilt = null; return; }
  const deg = Math.atan2(g.x, g.y) * 180 / Math.PI; // 화면에 보이는 수평선의 회전 각도
  state.tilt = state.tilt == null ? deg : state.tilt + (deg - state.tilt) * 0.2;
});

// ---------------- AI 감지 ----------------
async function initDetector() {
  if (state.detector || state.detectorState === 'loading') return;
  state.detectorState = 'loading';
  updateCamInfo();
  const base = new URL('./vendor/mediapipe/wasm/', location.href).href;
  const fileset = { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' };
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: new URL('./models/efficientdet_lite0.tflite', location.href).href, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: 0.4,
    maxResults: 6,
  });
  try {
    // GPU 위임은 일부 환경에서 오류 없이 빈 결과만 돌려주는 경우가 있어 CPU 를 쓴다 (이 모델은 CPU 로도 충분히 빠름)
    state.detector = await ObjectDetector.createFromOptions(fileset, opts('CPU'));
    state.detectorState = 'ready';
  } catch (e) {
    console.error(e);
    state.detectorState = 'error';
    toast('AI 감지를 불러오지 못했어요 (격자·수평계는 사용 가능)', 3000);
  }
  updateCamInfo();
}

function videoBoxToFrame(bb) {
  const { s, offX, offY, fw, fh } = state.layout;
  let x = (bb.originX * s + offX) / fw;
  const y = (bb.originY * s + offY) / fh;
  const w = (bb.width * s) / fw;
  const h = (bb.height * s) / fh;
  if (state.facing === 'user') x = 1 - x - w; // 전면 카메라는 화면이 좌우 반전
  return { x, y, w, h };
}

function handleDetections(dets, now) {
  const boxes = dets.map((d) => {
    const c = d.categories?.[0] || {};
    return { ...videoBoxToFrame(d.boundingBox), label: c.categoryName || 'object', score: c.score || 0 };
  });
  const pick = pickSubject(boxes, state.subject);
  if (pick) {
    const p = state.subject;
    if (p && p.label === pick.label) {
      // 흔들림을 줄이기 위한 지수 평활
      const a = 0.45;
      state.subject = {
        label: pick.label, score: pick.score,
        x: p.x + (pick.x - p.x) * a, y: p.y + (pick.y - p.y) * a,
        w: p.w + (pick.w - p.w) * a, h: p.h + (pick.h - p.h) * a,
      };
    } else {
      state.subject = pick;
      guide.reset();
    }
    state.lastSeen = now;
  }
}

// ---------------- 그리기 루프 ----------------
function loop(now) {
  requestAnimationFrame(loop);
  const v = el.video;
  if (state.guide && state.detector && state.track && v.readyState >= 2 && !document.hidden && now - state.lastDetect > 90) {
    state.lastDetect = now;
    try { handleDetections(state.detector.detectForVideo(v, now).detections, now); }
    catch (e) { console.warn(e); }
  }
  draw(now);
}

function draw(now) {
  const { fw, fh, dpr } = state.layout;
  const ctx = octx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, fw, fh);
  if (!state.track) { setHint(null); return; }

  if (state.grid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      ctx.moveTo(fw * t, 0); ctx.lineTo(fw * t, fh);
      ctx.moveTo(0, fh * t); ctx.lineTo(fw, fh * t);
    }
    ctx.stroke();
  }

  if (state.level && state.tilt != null) drawLevel(ctx, fw, fh);

  if (!state.guide) { setHint(null); hideSuggest(); return; }

  if (state.detectorState === 'loading') { setHint('AI 모델 불러오는 중…'); return; }
  if (state.detectorState !== 'ready') { setHint(null); return; }

  const sub = state.subject && now - state.lastSeen < 700 ? state.subject : null;
  if (!sub) {
    state.analysis = null;
    setHint('피사체를 찾는 중…');
    hideSuggest();
    return;
  }

  const prevAligned = state.analysis?.aligned;
  const a = guide.analyze(sub, fw / fh);
  state.analysis = a;
  if (a.aligned && !prevAligned && state.haptic) navigator.vibrate?.(20);

  const col = a.aligned ? '#4ade80' : '#ffffff';
  drawBrackets(ctx, sub.x * fw, sub.y * fh, sub.w * fw, sub.h * fh, col);
  drawLabel(ctx, sub, fw, fh, col);

  const ax = a.anchor.x * fw, ay = a.anchor.y * fh, tx = a.target.x * fw, ty = a.target.y * fh;
  // 목표 지점
  ctx.lineWidth = 2;
  ctx.strokeStyle = a.aligned ? '#4ade80' : '#ff6b35';
  ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  // 기준점과 화살표
  ctx.beginPath(); ctx.arc(ax, ay, 5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  if (!a.aligned) drawArrow(ctx, ax, ay, tx, ty);

  if (a.warn) setHint(a.warn, 'warn');
  else setHint(a.msg, a.aligned ? 'ok' : '');

  updateSuggest(a, now);
}

function drawLevel(ctx, fw, fh) {
  const rad = state.tilt * Math.PI / 180;
  const ok = Math.abs(state.tilt) < 1;
  const cx = fw / 2, cy = fh / 2;
  const len = fw * 0.3;
  ctx.save();
  ctx.lineWidth = 2;
  // 고정 기준선 (양 끝)
  ctx.strokeStyle = ok ? '#4ade80' : 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.moveTo(cx - len - 26, cy); ctx.lineTo(cx - len - 6, cy);
  ctx.moveTo(cx + len + 6, cy); ctx.lineTo(cx + len + 26, cy);
  ctx.stroke();
  // 실제 수평선
  ctx.translate(cx, cy);
  ctx.rotate(ok ? 0 : rad);
  ctx.strokeStyle = ok ? '#4ade80' : '#fbbf24';
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
  ctx.restore();
  if (!ok) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.abs(state.tilt).toFixed(1)}°`, cx, cy - 10);
  }
}

function drawBrackets(ctx, x, y, w, h, color) {
  const L = Math.max(10, Math.min(26, Math.min(w, h) * 0.22));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y);
  ctx.moveTo(x + w - L, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + L);
  ctx.moveTo(x + w, y + h - L); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - L, y + h);
  ctx.moveTo(x + L, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - L);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, sub, fw, fh, color) {
  const text = `주 피사체 · ${LABEL_KO[sub.label] || sub.label}`;
  ctx.save();
  ctx.font = '700 11px system-ui, sans-serif';
  const tw = ctx.measureText(text).width + 14;
  let lx = Math.min(Math.max(4, sub.x * fw), fw - tw - 4);
  let ly = (sub.y + sub.h) * fh + 6;
  if (ly + 20 > fh) ly = Math.max(4, sub.y * fh - 26);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(lx, ly, tw, 20, 10) : ctx.rect(lx, ly, tw, 20);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, lx + 7, ly + 10.5);
  ctx.restore();
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (d < 24) return;
  const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
  const sx = x1 + ux * 9, sy = y1 + uy * 9;
  const ex = x2 - ux * 17, ey = y2 - uy * 17;
  ctx.save();
  ctx.strokeStyle = '#ff6b35';
  ctx.fillStyle = '#ff6b35';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(ex + ux * 8, ey + uy * 8);
  ctx.lineTo(ex - uy * 6, ey + ux * 6);
  ctx.lineTo(ex + uy * 6, ey - ux * 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

let hintText = null, hintKind = null;
function setHint(text, kind = '') {
  if (text === hintText && kind === hintKind) return;
  hintText = text; hintKind = kind;
  if (!text) { el.hint.classList.add('hidden'); return; }
  el.hint.textContent = text;
  el.hint.className = 'hint' + (kind ? ' ' + kind : '');
}

// 줌 추천: 0.7초 이상 같은 판단이 유지될 때만 띄운다
function updateSuggest(a, now) {
  if (!a.zoomFactor) { hideSuggest(); return; }
  const [mn, mx] = zoomRange();
  const target = Math.min(mx, Math.max(mn, Math.round(state.zoom * a.zoomFactor * 2) / 2));
  if (Math.abs(target - state.zoom) < 0.3) { hideSuggest(); return; }
  if (state.suggestZoom !== target) { state.suggestZoom = target; state.suggestSince = now; }
  if (now - state.suggestSince > 700) {
    const txt = `🔍 ${fmtZoom(target)} 로 ${target > state.zoom ? '확대' : '축소'}`;
    if (el.zoomSuggest.textContent !== txt) el.zoomSuggest.textContent = txt;
    el.zoomSuggest.classList.remove('hidden');
  }
}
function hideSuggest() {
  state.suggestZoom = null;
  el.zoomSuggest.classList.add('hidden');
}
el.zoomSuggest.addEventListener('click', () => { if (state.suggestZoom) setZoom(state.suggestZoom); });

// ---------------- 촬영 ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function countdown(sec) {
  el.countdown.classList.remove('hidden');
  for (let i = sec; i > 0; i--) { el.countdown.textContent = i; await sleep(1000); }
  el.countdown.classList.add('hidden');
}

function flash() {
  el.flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => el.flash.classList.remove('on')));
}

function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `FrameMate_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

async function grabSource() {
  const { vw, vh } = state.layout;
  // 고화질: 센서 해상도로 찍되, 미리보기와 화면비가 같을 때만 사용 (다르면 화각이 달라 구도가 어긋남)
  if (state.hiRes && state.imageCapture && state.facing === 'environment') {
    try {
      const blob = await Promise.race([
        state.imageCapture.takePhoto(),
        sleep(3000).then(() => { throw new Error('takePhoto 시간 초과'); }),
      ]);
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (Math.abs(bmp.width / bmp.height - vw / vh) < 0.02) return { src: bmp, scale: bmp.width / vw };
      bmp.close();
    } catch (e) { console.warn('takePhoto 실패, 미리보기 프레임으로 촬영', e); }
  }
  // 기본: 현재 화면 프레임을 그대로 캡처
  const bmp = await createImageBitmap(el.video);
  return { src: bmp, scale: bmp.width / vw };
}

async function capture() {
  if (state.busy || !state.track) return;
  state.busy = true;
  el.shutter.classList.add('busy');
  try {
    if (state.timer) await countdown(state.timer);
    flash();
    const { fw, fh, s, offX, offY } = state.layout;
    const { src, scale } = await grabSource();
    // 화면 프레임에 보이는 영역을 원본 좌표로 환산해서 잘라낸다 (보이는 그대로 저장)
    const sx = (-offX / s) * scale, sy = (-offY / s) * scale;
    const sw = (fw / s) * scale, sh = (fh / s) * scale;
    const W = Math.round(sw), H = Math.round(W / (ratioValue() || fw / fh)); // 선택한 화면비를 정확히 유지
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    renderFiltered(c.getContext('2d'), src, sx, sy, sw, sh, W, H, getFilter(state.filter), { mirror: state.facing === 'user' });
    src.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('이미지 생성 실패');

    if (state.lastShot) URL.revokeObjectURL(state.lastShot.url);
    state.lastShot = { blob, url: URL.createObjectURL(blob), name: fileName() };
    el.thumb.style.backgroundImage = `url(${state.lastShot.url})`;

    if (state.autoSave) { download(state.lastShot); toast(`저장됨 · ${W}×${H}`); }
    else toast('촬영됨 · 썸네일을 눌러 저장하세요');
  } catch (e) {
    console.error('capture', e);
    toast('촬영에 실패했어요');
  } finally {
    state.busy = false;
    el.shutter.classList.remove('busy');
  }
}

function download(shot) {
  const a = document.createElement('a');
  a.href = shot.url;
  a.download = shot.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function share(shot) {
  const file = new File([shot.blob], shot.name, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') toast('공유 실패'); }
  } else {
    toast('이 브라우저는 파일 공유를 지원하지 않아요');
  }
}

// ---------------- 필터 UI ----------------
function buildFilterStrip() {
  el.filterStrip.innerHTML = '';
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fbtn';
    b.dataset.id = f.id;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 112;
    b.append(cv, document.createTextNode(f.name));
    b.addEventListener('click', () => selectFilter(f.id));
    el.filterStrip.appendChild(b);
  }
  markFilter();
}

// 필터 썸네일: 현재 화면 가운데를 잘라 각 필터로 미리 그려준다
function renderFilterThumbs() {
  const v = el.video;
  if (v.readyState < 2) return;
  const side = Math.min(v.videoWidth, v.videoHeight);
  const sx = (v.videoWidth - side) / 2, sy = (v.videoHeight - side) / 2;
  for (const b of el.filterStrip.children) {
    const cv = b.querySelector('canvas');
    renderFiltered(cv.getContext('2d'), v, sx, sy, side, side, cv.width, cv.height, getFilter(b.dataset.id), { mirror: state.facing === 'user' });
  }
}

function markFilter() {
  for (const b of el.filterStrip.children) b.classList.toggle('active', b.dataset.id === state.filter);
  el.btnFilter.classList.toggle('on', state.filter !== 'original' || !el.filterStrip.classList.contains('hidden'));
  el.btnFilter.textContent = state.filter === 'original' ? '필터' : `필터 · ${getFilter(state.filter).name}`;
}

function selectFilter(id) {
  state.filter = id;
  store.set('filter', id);
  applyPreview(getFilter(id), el);
  markFilter();
}

// ---------------- 버튼 연결 ----------------
function refreshToggles() {
  for (const b of document.querySelectorAll('[data-toggle]')) b.classList.toggle('on', !!state[b.dataset.toggle]);
  el.btnTimer.textContent = state.timer ? `⏱ ${state.timer}초` : '⏱ 끔';
  el.btnRatio.textContent = state.ratio === 'full' ? '전체' : state.ratio;
}

for (const b of document.querySelectorAll('[data-toggle]')) {
  b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    state[k] = !state[k];
    store.set(k, state[k]);
    if (k === 'guide' && state.guide) initDetector();
    if (k === 'guide' && !state.guide) { state.subject = null; guide.reset(); }
    refreshToggles();
  });
}

el.btnTimer.addEventListener('click', () => {
  state.timer = TIMERS[(TIMERS.indexOf(state.timer) + 1) % TIMERS.length];
  store.set('timer', state.timer);
  refreshToggles();
});

el.btnRatio.addEventListener('click', () => {
  state.ratio = RATIOS[(RATIOS.indexOf(state.ratio) + 1) % RATIOS.length];
  store.set('ratio', state.ratio);
  refreshToggles();
  layout();
});

el.btnFilter.addEventListener('click', () => {
  el.filterStrip.classList.toggle('hidden');
  if (!el.filterStrip.classList.contains('hidden')) renderFilterThumbs();
  markFilter();
  requestAnimationFrame(layout);
});

el.btnFlip.addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  store.set('facing', state.facing);
  startCamera();
});

el.shutter.addEventListener('click', capture);
el.btnRetry.addEventListener('click', startCamera);

el.thumb.addEventListener('click', () => {
  if (!state.lastShot) return;
  el.previewImg.src = state.lastShot.url;
  el.preview.classList.remove('hidden');
});
el.pvClose.addEventListener('click', () => el.preview.classList.add('hidden'));
el.pvSave.addEventListener('click', () => { if (state.lastShot) { download(state.lastShot); toast('저장됨'); } });
el.pvShare.addEventListener('click', () => { if (state.lastShot) share(state.lastShot); });

el.btnMenu.addEventListener('click', () => { updateCamInfo(); el.sheet.classList.remove('hidden'); });
el.sheetClose.addEventListener('click', () => el.sheet.classList.add('hidden'));
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) el.sheet.classList.add('hidden'); });
for (const [input, key] of [[el.optAutoSave, 'autoSave'], [el.optHiRes, 'hiRes'], [el.optHaptic, 'haptic']]) {
  input.checked = state[key];
  input.addEventListener('change', () => { state[key] = input.checked; store.set(key, input.checked); });
}

// 볼륨 키는 웹에서 받을 수 없어서, 블루투스 리모컨/키보드용으로 Enter·Space 만 셔터로 쓴다
window.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && el.preview.classList.contains('hidden') && el.sheet.classList.contains('hidden')) {
    e.preventDefault();
    capture();
  }
});

window.addEventListener('resize', () => requestAnimationFrame(layout));
el.video.addEventListener('resize', layout); // 기기 회전 등으로 영상 크기가 바뀔 때

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else startCamera();
});

// ---------------- 시작 ----------------
refreshToggles();
buildFilterStrip();
applyPreview(getFilter(state.filter), el);
startCamera();
if (state.guide) initDetector();
requestAnimationFrame(loop);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
