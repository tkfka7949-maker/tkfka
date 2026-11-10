// 잠소리 — 서비스 워커
// 한 번 열어 두면 인터넷이 없어도 앱이 열리도록 화면 파일을 기기에 저장해 둡니다.
// 온라인일 때는 항상 새 파일을 먼저 받아오기 때문에(네트워크 우선) 수정한 내용이 바로 반영돼요.
// 파일을 추가하면 아래 목록에도 넣고, 크게 바꿨으면 CACHE 이름의 숫자를 올려 주세요.

const CACHE = 'jamsori-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/analysis.js',
  'js/charts.js',
  'js/demo.js',
  'js/detector.js',
  'js/recorder.js',
  'js/storage.js',
  'js/worklet.js',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jamsori-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 글꼴: 저장된 게 있으면 바로 쓰고, 뒤에서 새로 받아 둠
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || fresh;
      }),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // 앱 파일: 네트워크 우선, 안 되면 저장본
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone(); // 본문을 읽기 전에 복사해 둬야 함
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
