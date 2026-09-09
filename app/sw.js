// Service Worker: «Расписание ВГУ»
const CACHE = 'vsu-app-v1.2.4';
const SHELL = ['./', './index.html', './app2.js', './style2.css', './manifest.webmanifest', './icons/icon-32.png', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Внешние API (расписание/заметки) не кэшируем в SW — они синхронизируются через IndexedDB
    if (url.origin !== self.location.origin) return;

    // Навигация: сеть, при сбое — кэш оболочки
    if (req.mode === 'navigate') {
        e.respondWith(fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
            return res;
        }).catch(() => caches.match('./index.html')));
        return;
    }
    // Статика: кэш, при сбое — сеть (и обновляем кэш)
    e.respondWith(caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => {
            if (res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
        }).catch(() => cached);
        return cached || net;
    }));
});