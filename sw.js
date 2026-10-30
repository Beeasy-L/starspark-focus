/* 星火-专注pro Service Worker：离线缓存，可安装
 *
 * v16（R3 分发策略改造，2026-10-30）：
 *   旧版 install 用 addAll 原子等 11 项 ≈ 11.87 MB——任一项（尤其 9 MB 音频）
 *   在网络窗口期下不完，install 就一直卡 installing、缓存 0 条目，
 *   用户点背景乐要整包重下且抢不到带宽（实测冷首访 40 秒不出声）。
 *   现改为：
 *     CORE 只装「打开就必需」的小文件（页面/manifest/图标，≈92 KB，秒装）；
 *     字体与音频进后台逐项预热（HEAVY），每项独立 catch——
 *     慢或失败只影响它自己，永不阻塞 install 完成；
 *   未预热到的资源由 fetch 拦截按需缓存回填（下方 fetch 处理器原本就有此逻辑）。
 *   离线能力不打折：预热最终会把全部 11 项灌进缓存；
 *   中途关页面的话，下次访问 fetch 命中网络时也会写入缓存。
 */
const CACHE = 'starspark-focus-v16';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
/* 后台预热清单：大文件，逐个来，互不牵连 */
const HEAVY = [
  './assets/font-400.woff2',
  './assets/font-700.woff2',
  './assets/music-moon.mp3',
  './assets/rain-forest.mp3',
  './assets/campsite.mp3'
];

let warmPromise = null;   // 单闸门：install 与 activate 都调 warmHeavy()，
                          // 若 install 的预热还在跑，activate 复用同一 promise，绝不重复下载。
function warmHeavy() {
  if (warmPromise) return warmPromise;
  warmPromise = caches.open(CACHE).then(function (c) {
    // 串行预热：避免自己跟自己抢带宽；每项独立 catch，一项坏不拖全队。
    return HEAVY.reduce(function (chain, path) {
      return chain.then(function () {
        return c.match(path).then(function (hit) {
          if (hit) return;                       // 已在缓存（含 fetch 回填的），跳过
          return fetch(path).then(function (res) {
            if (res.ok) return c.put(path, res.clone());
          });
        }).catch(function () { /* 这一项没网/失败：放着，fetch 处理器之后会补 */ });
      });
    }, Promise.resolve());
  }).catch(function () {});
  return warmPromise;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))        // 只原子等 6 个小文件（≈92 KB）
      .then(() => self.skipWaiting())
  );
  // 大文件在 install 成功后预热：这里慢/败都不影响上岗。
  warmHeavy().catch(function () {});
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
  // 兜底：若上次 install 的预热被网络打断，其 promise 已完成不会重跑；
  // 重置闸门再试一轮（已在缓存的会被 c.match 跳过，不重复下载）。
  warmPromise = null;
  warmHeavy().catch(function () {});
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 页面（导航）：网络优先，保证更新；离线回退缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 同源静态资源：缓存优先，回退网络并写入缓存
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
  }
  // 跨域（如字体）：直接走网络，不缓存；离线时退回系统字体

});
