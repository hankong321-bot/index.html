// 구도 가이드 규칙.
// 입력 좌표는 모두 "화면 프레임 기준 0~1 정규화" 값이다 (x: 왼→오, y: 위→아래).
// 원리: 피사체의 기준점(사람이면 머리 근처, 사물이면 중심)을 3분할선/교차점으로 보내도록 안내한다.

const THIRDS = [1 / 3, 2 / 3];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Guide {
  constructor() {
    this.alignIn = 0.07;   // 이 거리 안으로 들어오면 "정렬됨"
    this.alignOut = 0.10;  // 이 거리 밖으로 나가야 "정렬 해제" (깜빡임 방지)
    this.reset();
  }

  setThresholds(alignIn, alignOut) { this.alignIn = alignIn; this.alignOut = alignOut; }

  reset() {
    this.sideX = null;
    this.sideY = null;
    this.aligned = false;
  }

  // 3분할선 중 어느 쪽을 쓸지 고른다. 직전 선택을 유지하는 쪽으로 약간 치우쳐서 좌우로 튀지 않게 한다.
  pickThird(v, prev) {
    const d0 = Math.abs(v - THIRDS[0]);
    const d1 = Math.abs(v - THIRDS[1]);
    if (prev === 0) return d1 + 0.1 < d0 ? 1 : 0;
    if (prev === 1) return d0 + 0.1 < d1 ? 0 : 1;
    return d0 <= d1 ? 0 : 1;
  }

  /**
   * @param sub    {x,y,w,h,label}  피사체 박스
   * @param aspect 프레임 가로/세로 비
   */
  analyze(sub, aspect) {
    const isPerson = sub.label === 'person';
    const cx = sub.x + sub.w / 2;
    const cy = sub.y + sub.h / 2;

    // 가로: 3분할선. 피사체가 프레임 폭의 45% 이상이면 3분할이 불가능하므로 가운데.
    let tx;
    if (sub.w > 0.45) { tx = 0.5; this.sideX = null; }
    else { this.sideX = this.pickThird(cx, this.sideX); tx = THIRDS[this.sideX]; }

    let anchor, target;
    if (isPerson) {
      // 사람: 머리(박스 위쪽 12% 지점)를 위쪽 3분할선에 두되, 발이 잘리지 않게 아래 여백을 확보
      const headOff = 0.12 * sub.h;
      const maxTop = Math.max(0.04, 0.97 - sub.h);
      const desiredTop = clamp(1 / 3 - headOff, 0.04, maxTop);
      anchor = { x: cx, y: sub.y + headOff };
      target = { x: tx, y: desiredTop + headOff };
    } else {
      let ty;
      if (sub.h > 0.45) { ty = 0.5; this.sideY = null; }
      else { this.sideY = this.pickThird(cy, this.sideY); ty = THIRDS[this.sideY]; }
      anchor = { x: cx, y: cy };
      target = { x: tx, y: ty };
    }

    const dx = target.x - anchor.x;
    const dyW = (target.y - anchor.y) / aspect; // 세로 차이를 가로 폭 단위로 환산
    const dist = Math.hypot(dx, dyW);
    this.aligned = this.aligned ? dist < this.alignOut : dist < this.alignIn;

    // 이동 안내: 피사체를 오른쪽으로 보내려면 카메라는 왼쪽으로 돌려야 한다
    let msg;
    if (this.aligned) msg = '좋아요! 지금 찍으세요';
    else if (Math.abs(dx) >= Math.abs(dyW)) msg = dx > 0 ? '← 카메라를 왼쪽으로' : '카메라를 오른쪽으로 →';
    else msg = dyW > 0 ? '↑ 카메라를 위로' : '↓ 카메라를 아래로';

    // 크기(줌) 판단
    let zoomFactor = null;
    let warn = null;
    if (isPerson) {
      if (sub.y < 0.01 && sub.h > 0.5) warn = '머리가 잘려요 · 줌을 줄이거나 한 걸음 뒤로';
      else if (sub.h < 0.3) zoomFactor = 0.55 / sub.h;
      else if (sub.h > 0.98) zoomFactor = 0.8 / sub.h;
    } else {
      const m = Math.sqrt(sub.w * sub.h);
      if (m < 0.18) zoomFactor = 0.35 / m;
      else if (m > 0.85) zoomFactor = 0.6 / m;
    }

    return { anchor, target, dist, aligned: this.aligned, msg, warn, zoomFactor };
  }
}

// 감지 결과(여러 개) 중 주 피사체 하나를 고른다.
const LOW_PRIORITY = new Set(['dining table', 'bed', 'couch', 'tv', 'refrigerator', 'oven', 'sink', 'bench', 'toilet']);

export function pickSubject(boxes, prev) {
  let best = null;
  let bestScore = 0;
  for (const b of boxes) {
    // 프레임 안에 보이는 면적
    const vx = Math.max(0, Math.min(1, b.x + b.w) - Math.max(0, b.x));
    const vy = Math.max(0, Math.min(1, b.y + b.h) - Math.max(0, b.y));
    const visible = vx * vy;
    if (visible < 0.004 || visible > 0.92) continue;
    let s = b.score * Math.sqrt(visible);
    if (b.label === 'person') s *= 2;
    if (LOW_PRIORITY.has(b.label)) s *= 0.4;
    // 가운데에 가까울수록 약간 가산
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    s *= 1.2 - 0.4 * Math.hypot(cx - 0.5, cy - 0.5);
    // 직전 피사체와 같은 대상이면 유지 (대상이 자꾸 바뀌는 것 방지)
    if (prev && prev.label === b.label && iou(prev, b) > 0.3) s *= 1.6;
    if (s > bestScore) { bestScore = s; best = b; }
  }
  return best;
}

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

export const LABEL_KO = {
  person: '인물', cat: '고양이', dog: '강아지', bird: '새', horse: '말', cup: '컵', bottle: '병',
  'wine glass': '와인잔', bowl: '그릇', 'potted plant': '화분', vase: '꽃병', book: '책', clock: '시계',
  car: '자동차', bicycle: '자전거', motorcycle: '오토바이', bus: '버스', truck: '트럭', boat: '보트',
  laptop: '노트북', 'cell phone': '휴대폰', chair: '의자', couch: '소파', bench: '벤치', cake: '케이크',
  pizza: '피자', donut: '도넛', sandwich: '샌드위치', 'teddy bear': '인형', umbrella: '우산',
  handbag: '가방', backpack: '배낭', 'dining table': '테이블', tv: 'TV', keyboard: '키보드',
  banana: '바나나', apple: '사과', orange: '오렌지', broccoli: '브로콜리', 'traffic light': '신호등',
};
