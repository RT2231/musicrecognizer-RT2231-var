/**
 * Service Worker — 音楽認識ツール v3.3.0
 *
 * キャッシュ戦略:
 *   - Shell（HTML / CSS / JS）: Cache First → オフラインでも起動可能
 *   - 外部 API リクエスト（Worker / ACRCloud）: Network Only（認識は常にオンライン必須）
 *   - アセット（画像）: Stale While Revalidate
 *
 * キャッシュ名にバージョンを含める。デプロイ時にバージョンを上げれば古いキャッシュを自動削除。
 */

const CACHE_VERSION = "v3.3.0";
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const ASSET_CACHE   = `assets-${CACHE_VERSION}`;

/** オフラインでも動作させたいシェルファイル */
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./main.js",
  "./spotify-callback.html",
  "./favicon.png",
  "./manifest.json",
];

/** キャッシュしないパターン（外部 API・Worker） */
const BYPASS_PATTERNS = [
  /workers\.dev\//,
  /acrcloud\.com\//,
  /musicbrainz\.org\//,
  /itunes\.apple\.com\//,
  /googleapis\.com\//,
  /wikipedia\.org\//,
  /spotify\.com\//,
];

// ─── インストール ─────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())  // 即座に有効化
  );
});

// ─── アクティベート ───────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map(k => caches.delete(k))  // 古いバージョンのキャッシュを削除
      )
    ).then(() => self.clients.claim())
  );
});

// ─── フェッチ ─────────────────────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // POST / non-GET はキャッシュ対象外
  if (request.method !== "GET") return;

  // 外部 API はバイパス
  if (BYPASS_PATTERNS.some(p => p.test(request.url))) return;

  // シェルファイル → Cache First
  if (SHELL_FILES.some(f => url.pathname.endsWith(f.replace("./", ""))) || url.pathname === "/") {
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(request, clone));
          }
          return res;
        });
        return cached || network;
      })
    );
    return;
  }

  // その他アセット（アルバムアートなど） → Stale While Revalidate
  event.respondWith(
    caches.open(ASSET_CACHE).then(cache =>
      cache.match(request).then(cached => {
        const network = fetch(request).then(res => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => cached);  // ネットワーク失敗時はキャッシュを返す
        return cached || network;
      })
    )
  );
});
