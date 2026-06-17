const CACHE = 'shooting-schedule-v1';
const ASSETS = [
  '/shooting-schedule/',
  '/shooting-schedule/index.html',
];

// 설치 — 핵심 파일 캐시
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 활성화 — 구버전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 요청 처리 — 네트워크 우선, 실패시 캐시
self.addEventListener('fetch', e => {
  // 구글 시트 데이터는 항상 네트워크 (최신 데이터)
  if (e.request.url.includes('docs.google.com')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{}', {status: 503})));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
