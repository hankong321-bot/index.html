// 오프라인에서도 열리도록 앱 파일을 캐시한다.
// 앱 코드를 고치면 VERSION 을 올려야 폰에 새 버전이 반영된다.
const VERSION = 'framemate-v2';
const SHELL = [
  './', './index.html', './style.css', './app.js', './filters.js', './guide.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
const HEAVY = [
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './models/efficientdet_lite0.tflite',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([...SHELL, ...HEAVY])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const heavy = /\/(vendor|models)\//.test(req.url);
  if (heavy) {
    // 큰 파일(모델·엔진): 캐시 우선
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  } else {
    // 앱 코드: 네트워크 우선, 오프라인이면 캐시
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })),
    );
  }
});
