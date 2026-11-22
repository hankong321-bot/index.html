// 필터 정의: 미리보기(CSS)와 저장(캔버스)이 같은 값을 쓰도록 한 곳에서 관리한다.
// css      : CSS filter 문자열 (video.style.filter 와 ctx.filter 에 동일하게 적용)
// tint     : 색 덧씌우기 {color, alpha, blend}
// vignette : 가장자리 어둡게 (0~1)
// grain    : 필름 입자 (0~1)
export const FILTERS = [
  { id: 'original', name: '원본', css: 'none' },
  { id: 'travel', name: '트래블 필름', css: 'contrast(1.05) saturate(1.15) sepia(0.12) brightness(1.03)',
    tint: { color: '#ff9a3c', alpha: 0.10, blend: 'soft-light' }, vignette: 0.25, grain: 0.12 },
  { id: 'portrait', name: '포트레이트', css: 'brightness(1.06) contrast(0.95) saturate(0.95)',
    tint: { color: '#ffc4a8', alpha: 0.12, blend: 'soft-light' }, vignette: 0.12 },
  { id: 'vivid', name: '비비드', css: 'contrast(1.15) saturate(1.45)', vignette: 0.12 },
  { id: 'golden', name: '골든아워', css: 'saturate(1.1) sepia(0.18) contrast(1.04)',
    tint: { color: '#ffb347', alpha: 0.14, blend: 'soft-light' }, vignette: 0.2 },
  { id: 'cool', name: '쿨 시티', css: 'saturate(0.9) contrast(1.08) hue-rotate(-6deg)',
    tint: { color: '#3aa0ff', alpha: 0.12, blend: 'soft-light' }, vignette: 0.15 },
  { id: 'fade', name: '페이드', css: 'contrast(0.82) brightness(1.08) saturate(0.8)',
    tint: { color: '#7a86ff', alpha: 0.06, blend: 'screen' }, grain: 0.08 },
  { id: 'vintage', name: '빈티지', css: 'sepia(0.35) contrast(0.9) brightness(1.05) saturate(0.85)',
    tint: { color: '#d9b38c', alpha: 0.12, blend: 'multiply' }, vignette: 0.35, grain: 0.2 },
  { id: 'mono', name: '모노', css: 'grayscale(1) contrast(1.05)' },
  { id: 'noir', name: '누아르', css: 'grayscale(1) contrast(1.45) brightness(0.95)', vignette: 0.35, grain: 0.25 },
];

export const getFilter = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

// ---------- 필름 입자 텍스처 ----------
let noiseCanvas = null;
function getNoiseCanvas() {
  if (noiseCanvas) return noiseCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseCanvas = c;
  return c;
}
let noiseURL = null;
export function noiseDataURL() {
  if (!noiseURL) noiseURL = getNoiseCanvas().toDataURL('image/png');
  return noiseURL;
}

// ---------- 미리보기(라이브 화면)에 적용 ----------
export function applyPreview(f, { video, tint, grain, vignette }) {
  video.style.filter = f.css === 'none' ? '' : f.css;
  if (f.tint) {
    tint.style.background = f.tint.color;
    tint.style.opacity = f.tint.alpha;
    tint.style.mixBlendMode = f.tint.blend;
  } else {
    tint.style.opacity = 0;
  }
  if (f.grain) {
    grain.style.backgroundImage = `url(${noiseDataURL()})`;
    grain.style.opacity = f.grain;
  } else {
    grain.style.opacity = 0;
  }
  vignette.style.background = f.vignette
    ? `radial-gradient(ellipse farthest-corner at center, rgba(0,0,0,0) 55%, rgba(0,0,0,${f.vignette}) 100%)`
    : 'none';
}

// ---------- 저장용 캔버스에 적용 ----------
// src 의 (sx,sy,sw,sh) 영역을 W×H 캔버스에 필터 적용해 그린다.
export function renderFiltered(ctx, src, sx, sy, sw, sh, W, H, f, { mirror = false } = {}) {
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.filter = f.css || 'none';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  ctx.restore();
  ctx.filter = 'none';

  if (f.tint) {
    ctx.save();
    ctx.globalCompositeOperation = f.tint.blend;
    ctx.globalAlpha = f.tint.alpha;
    ctx.fillStyle = f.tint.color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (f.grain) {
    ctx.save();
    const pat = ctx.createPattern(getNoiseCanvas(), 'repeat');
    // 미리보기와 비슷한 입자 크기가 되도록 결과 해상도에 맞춰 키운다
    const k = Math.max(1, W / 1000);
    if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(k));
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = f.grain;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (f.vignette) {
    // CSS 'ellipse farthest-corner' 와 같은 모양: 반지름 = (W/2·√2, H/2·√2)
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale((W / 2) * Math.SQRT2, (H / 2) * Math.SQRT2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${f.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
}
