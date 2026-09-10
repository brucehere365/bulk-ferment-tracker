/* TrackMyLoaf — service worker.
 *
 * Two jobs, in this order of importance:
 *
 *   1. Work in a kitchen with no signal. The whole site is four files; they
 *      are precached so a bulk can be logged with the phone in aeroplane mode.
 *   2. Never serve a stale app. A push to main is a deploy, so a phone holding
 *      an old app.js against a new index.html is a real failure mode — the one
 *      the "hard-refresh when the file list changes" note in CLAUDE.md is
 *      about. So this is NETWORK-FIRST, not cache-first: online you always get
 *      what was just deployed, and the cache is strictly a fallback.
 *
 * The cost is that an online load waits for the network. That is the right
 * trade: a fast wrong answer about a bake is worse than a slow right one.
 *
 * To retire this worker, deploy a sw.js whose body is just:
 *     self.addEventListener('install', function () { self.skipWaiting(); });
 *     self.addEventListener('activate', function (e) {
 *       e.waitUntil(self.registration.unregister().then(function () {
 *         return caches.keys().then(function (k) { return Promise.all(k.map(caches.delete.bind(caches))); });
 *       }));
 *     });
 * Browsers always revalidate sw.js, so that tombstone reaches every phone. */
'use strict';

var VERSION = 'bft-2026-09-09';
var NET_TIMEOUT = 3500;

/* Relative so it works from any origin the app is served on — which, given
 * that moving origin is itself a live issue here, is not hypothetical. */
var SHELL = [
  './', 'index.html', 'styles.css', 'model.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      /* addAll is all-or-nothing; one 404 would leave the app with no offline
       * copy at all, so each file is allowed to fail on its own. */
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' }))['catch'](function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches['delete'](k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function fromNetwork(request) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('slow network')); }
    }, NET_TIMEOUT);
    fetch(request).then(function (res) {
      clearTimeout(timer);
      if (settled) {
        /* Too slow to use, but still worth keeping for next time. */
        if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(request, res.clone()); });
        return;
      }
      settled = true;
      if (res && res.ok && request.method === 'GET') {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(request, copy); });
      }
      resolve(res);
    })['catch'](function (err) {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

self.addEventListener('fetch', function (e) {
  var request = e.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Never get between the browser and the worker script itself. */
  if (url.pathname.slice(-6) === '/sw.js') return;

  /* Google Fonts: cache-first and entirely optional. Every font stack in
   * styles.css has a real fallback, so a miss is a slightly different face,
   * not a broken app. */
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(request).then(function (hit) {
        return hit || fetch(request).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(VERSION).then(function (c) { c.put(request, copy); });
          }
          return res;
        })['catch'](function () { return hit || Response.error(); });
      })
    );
    return;
  }

  e.respondWith(
    fromNetwork(request)['catch'](function () {
      return caches.match(request).then(function (hit) {
        if (hit) return hit;
        /* A navigation to any path is still this one-page app. */
        if (request.mode === 'navigate') {
          return caches.match('index.html').then(function (page) {
            return page || caches.match('./');
          });
        }
        return Response.error();
      });
    })
  );
});

/* Lets the page retire the worker without a deploy, if it ever needs to. */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'unregister') {
    self.registration.unregister();
  }
});
