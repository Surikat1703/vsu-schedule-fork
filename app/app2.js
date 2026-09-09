/* ═══ Расписание ВГУ — PWA ═══ */
'use strict';

// ─── Состояние ────────────────────────────────────────────────────────────────
const state = {
    token: localStorage.getItem('token') || null,
    userId: parseInt(localStorage.getItem('user_id')) || null,
    isAdmin: localStorage.getItem('is_admin') === '1',
    profile: null,
    schedules: { 0: null, 1: null },
    exams: null,
    meta: null,
    notes: [],
    anchor: null,          // {weekType, monday: 'YYYY-MM-DD'} — привязка чётности недель
    drift: 0,              // серверное время (бот) минус время устройства, сек
    online: navigator.onLine,
    currentView: 'schedule',
    schedDay: null,
    weekOffset: 0,        // 0 = базовая неделя, ±1 = соседняя (сдвигает и даты, и чётность)
    calMonth: null,        // Date (1-е число отображаемого месяца)
    calSelected: null,     // 'YYYY-MM-DD'
    editingNote: null,
    tg: null,
    loginPollTimer: null,
    adminData: null,
    // ── Персональные расширения ──
    notePrio: 0,           // выбранный приоритет в редакторе заметки (0-3)
    noteDone: false,       // «выполнено» в редакторе заметки
    tasksFilter: localStorage.getItem('tasksFilter') || 'all',    // all | today | week
    tasksPrio: parseInt(localStorage.getItem('tasksPrio')) || 0,    // фильтр по приоритету: 0=все, 1|2|3
    tasksDone: localStorage.getItem('tasksDone') || 'undone',      // фильтр по выполненности: all | done | undone
    tasksSearch: '',
    prefill: null,         // {title, date} — автозаполнение при создании из пары
    lessonClickDate: null, // ISO дня, по которому кликнули в паре (для кнопки «на день клика»)
};

// Приоритет хранится эмодзи в КОНЦЕ названия заметки: так заметка остаётся
// обычной и двусторонне синхронизируется с сервисом (в оригинале просто
// виден смайлик в заголовке).
// Схема приоритета: 🔴 = высокий, (без смайлика) = средний, 🟢 = низкий.
// Средний — значение по умолчанию: отсутствие смайлика и есть средний.
const PRIO = {
    1: { emoji: '🟢', label: 'Низкий', rank: 1 },
    2: { emoji: '🟡', label: 'Средний', rank: 2 },
    3: { emoji: '🔴', label: 'Высокий', rank: 3 },
};
// Что реально пишем в название (уходит на сервер). Средний = без смайлика.
// Жёлтый 🟡 рисуем ТОЛЬКО локально (PRIO[2].emoji) — на сервер не отправляем.
const SAVE_EMOJI = { 1: '🟢', 2: '', 3: '🔴' };

function prioFromTitle(title) {
    const t = String(title || '').trim();
    if (t.endsWith('🔴')) return 3;
    if (t.endsWith('🟢')) return 1;
    return 2; // без смайлика = средний
}

function titleWithoutPrio(title) {
    return String(title || '').replace(/(\s*)(?:🔴|🟢)\s*$/, '').trim();
}

function titleWithPrio(title, prio) {
    const base = titleWithoutPrio(title);
    const e = SAVE_EMOJI[prio] || '';
    return e ? (base + ' ' + e) : base;
}

// ── «Выполнено» — галочка ✅ в начале названия заметки (синхронизируется как обычный текст) ──
const DONE_MARK = '✅';
function doneFromTitle(title) {
    return String(title || '').trim().startsWith(DONE_MARK);
}
function titleWithoutDone(title) {
    return String(title || '').replace(new RegExp('^' + DONE_MARK + '\\s*'), '').trim();
}
// Собираем итоговый заголовок: [✅ ] + текст + [приоритет-эмодзи]
function composeTitle(base, prio, done) {
    let t = titleWithoutPrio(titleWithoutDone(base));
    if (done) t = DONE_MARK + ' ' + t;
    const e = SAVE_EMOJI[prio] || '';
    return e ? (t + ' ' + e) : t;
}

const APP_VERSION = '1.2.5';
// Цветные метки типов занятий: на стенде включены, в проде пока выключены
const FEATURE_LESSON_COLORS = true;

const DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const TIME_SLOTS = [
    { start: '8:00', end: '9:35' }, { start: '9:45', end: '11:20' },
    { start: '11:30', end: '13:05' }, { start: '13:25', end: '15:00' },
    { start: '15:10', end: '16:45' }, { start: '16:55', end: '18:30' },
    { start: '18:40', end: '20:00' }, { start: '20:10', end: '21:30' }
];

// ─── Утилиты ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
// Навешивание обработчика с защитой от отсутствующего элемента (смешение версий кэша)
const on = (id, ev, fn) => {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
    else console.warn('[BIND] нет элемента #' + id);
};

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function haptic(type = 'light') {
    try { state.tg?.HapticFeedback?.impactOccurred(type); } catch (e) { }
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Время бота: устройство + дрейф; читать через getUTC*-методы
function botNow() { return new Date((Math.floor(Date.now() / 1000) + state.drift) * 1000); }
function botDayIdx(d) { return (d.getUTCDay() + 6) % 7; }  // 0 = Пн
function botMinutes(d) { return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function isoFromUTCParts(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function isoFromLocalParts(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function mondayOfIso(dateStr) {
    const [y, m, dd] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, dd));
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d;
}

function weekTypeForDate(dateStr) {
    if (!state.anchor) return 0;
    const target = mondayOfIso(dateStr);
    const anchor = mondayOfIso(state.anchor.monday);
    const w = Math.round((target - anchor) / (7 * 864e5));
    return ((state.anchor.weekType + w) % 2 + 2) % 2;
}

function weekName(wt) { return wt === 0 ? 'Числитель' : 'Знаменатель'; }

function parseTimeMin(t) {
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : 0;
}

function parseLesson(raw) {
    const empty = raw.trim().startsWith('▫');
    let s = raw.replace(/[*_]/g, '').replace(/^[🔹▫️\s]+/u, '').trim();
    const m = s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*:?\s*([\s\S]*)$/);
    if (!m) return { start: '', end: '', text: s, empty };
    return { start: m[1], end: m[2], text: m[3].trim(), empty };
}

// Тип занятия определяем по тексту: явных пометок «лекция/практика» в
// расписании нет, зато есть (ДО), физкультура, военная подготовка, НИР, языки.
const LESSON_KINDS = [
    { cls: 'kind-remote',   badge: 'дистанционно', test: (t) => /\(ДО\)/i.test(t) },
    { cls: 'kind-sport',    badge: 'физкультура',  test: (t) => /физическая культура|физкультур/i.test(t) },
    { cls: 'kind-military', badge: 'военная',      test: (t) => /военн|ВУЦ|основы военной/i.test(t) },
    { cls: 'kind-lang',     badge: 'язык',         test: (t) => /ин\.?\s*яз|иностранн|русский язык/i.test(t) },
    { cls: 'kind-research', badge: 'НИР',          test: (t) => /^\s*НИР\b|научно-исследовательск/i.test(t) },
];

function lessonKind(text) {
    for (const k of LESSON_KINDS) {
        if (k.test(text)) return k;
    }
    return { cls: 'kind-default', badge: '' };
}

const KIND_DEFAULTS = {
    remote: '#a78bfa', sport: '#34d399', military: '#94a3b8',
    lang: '#fb923c', research: '#22d3ee', default: '#4f7cff',
};
const KIND_TITLES = {
    remote: 'Дистанционно (ДО)', sport: 'Физкультура', military: 'Военная подготовка',
    lang: 'Иностранный язык', research: 'НИР', default: 'Обычные пары',
};
const COLOR_PALETTE = [
    '#4f7cff', '#6366f1', '#a78bfa', '#f472b6', '#f87171',
    '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee',
    '#38bdf8', '#94a3b8', '#e879f9', '#2dd4bf', '#facc15',
];

function currentKindColors() {
    let saved = {};
    try { saved = JSON.parse(state.profile?.lesson_colors || '{}') || {}; } catch (e) { saved = {}; }
    return { ...KIND_DEFAULTS, ...saved };
}

// Цвета применяются через CSS-переменные — перерисовка списка не нужна
function applyKindColors() {
    const colors = currentKindColors();
    for (const [kind, color] of Object.entries(colors)) {
        document.documentElement.style.setProperty('--kind-' + kind, color);
    }
}

function restText() {
    const mode = state.profile?.mode || 'обычный';
    if (mode === 'po***') return 'Похуй, домой';
    if (mode === 'пивко') return 'По пивку, чилл';
    return 'Пар нет, отдыхай!';
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────
let idb = null;

function idbOpen() {
    // Открытие может зависнуть навсегда (база заблокирована другим процессом,
    // повреждена, запрещена настройками) — тогда приложение застревает на заставке.
    // Поэтому ограничиваем ожидание: без локальной базы работаем, просто без кэша.
    return new Promise((resolve) => {
        let done = false;
        const finish = (db, err) => {
            if (done) return;
            done = true;
            idb = db || null;
            if (err) console.warn('[IDB]', err);
            resolve();
        };
        const timer = setTimeout(() => finish(null, 'таймаут открытия базы'), 5000);
        try {
            const req = indexedDB.open('vsu-pwa', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'client_id' });
            };
            req.onsuccess = (e) => { clearTimeout(timer); finish(e.target.result); };
            req.onerror = () => { clearTimeout(timer); finish(null, req.error); };
            req.onblocked = () => { clearTimeout(timer); finish(null, 'база заблокирована'); };
        } catch (e) {
            clearTimeout(timer);
            finish(null, e);
        }
    });
}

function idbTx(store, mode, fn) {
    return new Promise((resolve, reject) => {
        if (!idb) return resolve(undefined);
        const tx = idb.transaction(store, mode);
        const os = tx.objectStore(store);
        const out = fn(os);
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
    });
}

function kvSet(key, val) { return idbTx('kv', 'readwrite', (os) => os.put(val, key)); }
function kvGet(key) {
    return new Promise((resolve) => {
        if (!idb) return resolve(undefined);
        const tx = idb.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
    });
}
function notesAll() {
    return new Promise((resolve) => {
        if (!idb) return resolve([]);
        const req = idb.transaction('notes', 'readonly').objectStore('notes').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}
function notePut(n) { return idbTx('notes', 'readwrite', (os) => os.put(n)); }
function notesReplaceAll(list) {
    return idbTx('notes', 'readwrite', (os) => { os.clear(); list.forEach((n) => os.put(n)); });
}
function idbClearAll() {
    return Promise.all([idbTx('kv', 'readwrite', (os) => os.clear()), idbTx('notes', 'readwrite', (os) => os.clear())]);
}

// ─── API ──────────────────────────────────────────────────────────────────────
// Базовый адрес сервиса. В веб-версии (с того же домена) пусто — пути
// относительные. В локальных обёртках (Electron/Capacitor) подставляется
// абсолютный адрес через window.__API_BASE__.
const API_BASE = (window.__API_BASE__ || 'https://vsu.my1gvps.xyz').replace(/\/$/, '');

async function api(method, path, body, timeoutMs = 15000) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const opts = { method, headers: {}, signal: ctrl ? ctrl.signal : undefined };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
    let r;
    try {
        r = await fetch(API_BASE + path, opts);
    } finally {
        if (timer) clearTimeout(timer);
    }
    if (!r.ok) {
        const err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
    }
    return r.json();
}

function setOffline(off) {
    state.online = !off;
    $('offline-badge').classList.toggle('hidden', !off);
}

// ─── Авторизация ──────────────────────────────────────────────────────────────
function waitTelegram(timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        (function check() {
            if (window.Telegram?.WebApp) return resolve(window.Telegram.WebApp);
            if (Date.now() - t0 > timeout) return resolve(null);
            setTimeout(check, 100);
        })();
    });
}

function saveAuth(p) {
    state.token = p.token;
    state.userId = p.user_id;
    state.isAdmin = !!p.is_admin;
    localStorage.setItem('token', p.token);
    localStorage.setItem('user_id', p.user_id);
    localStorage.setItem('is_admin', p.is_admin ? '1' : '0');
}

// Код входа готовим заранее: iOS Safari разрешает window.open только
// синхронно внутри обработчика клика, без await перед ним.
let loginData = null;

async function prepareLogin() {
    try { loginData = await api('POST', '/api/auth/start'); }
    catch (e) { loginData = null; }
}

function startLogin() {
    if (!loginData) {
        prepareLogin().then(() => {
            if (loginData) startLogin();
            else toast('Нет связи с сервером');
        });
        return;
    }
    const { link, code } = loginData;
    loginData = null;   // код одноразовый: повторное нажатие получит новый
    prepareLogin();

    // В установленной PWA window.open показывает встроенный браузер-оверлей —
    // храним ссылку, чтобы закрыть его автоматически после подтверждения
    let w = null;
    try { w = window.open(link, '_blank'); } catch (e) { }
    if (!w) location.href = link;
    state.loginWindow = w;

    $('login-btn').classList.add('hidden');
    $('login-waiting').classList.remove('hidden');

    clearInterval(state.loginPollTimer);
    const poll = async () => {
        try {
            const p = await api('GET', '/api/auth/poll?code=' + encodeURIComponent(code));
            if (p.status === 'ok') {
                clearInterval(state.loginPollTimer);
                state.loginPoll = null;
                try { state.loginWindow && state.loginWindow.close(); } catch (e) { }
                saveAuth(p);
                $('login-screen').classList.add('hidden');
                await enterApp();
            } else if (p.status === 'expired') {
                cancelLogin();
                toast('Код входа истёк, попробуй ещё раз');
            }
        } catch (e) { /* сеть мигнула — продолжаем поллить */ }
    };
    state.loginPoll = poll;
    state.loginPollTimer = setInterval(poll, 2000);
    poll();
}

function cancelLogin() {
    clearInterval(state.loginPollTimer);
    state.loginPoll = null;
    $('login-btn').classList.remove('hidden');
    $('login-waiting').classList.add('hidden');
    if (!loginData) prepareLogin();
}

function logout() {
    localStorage.clear();
    idbClearAll().finally(() => location.reload());
}

// ─── Загрузка данных ──────────────────────────────────────────────────────────
async function loadFromCache() {
    state.profile = await kvGet('profile') || null;
    state.anchor = await kvGet('anchor') || null;
    state.drift = await kvGet('drift') || 0;
    state.schedules[0] = await kvGet('sched0') || null;
    state.schedules[1] = await kvGet('sched1') || null;
    state.exams = await kvGet('exams') || null;
    state.meta = await kvGet('meta') || null;
    state.notes = await notesAll();
}

async function refreshAll() {
    if (!state.token) return; // на экране входа дёргать /api/me нельзя: 401 → logout → reload
    if (!navigator.onLine) { setOffline(true); return; }
    try {
        const me = await api('GET', '/api/me');
        state.profile = me;
        state.userId = me.user_id;
        state.isAdmin = !!me.is_admin;
        localStorage.setItem('user_id', me.user_id);
        localStorage.setItem('is_admin', me.is_admin ? '1' : '0');
        state.drift = me.server_time - Math.floor(Date.now() / 1000);
        state.anchor = { weekType: me.week_type, monday: isoFromUTCParts(mondayOfIso(isoFromUTCParts(botNow()))) };
        await kvSet('profile', me);
        await kvSet('anchor', state.anchor);
        await kvSet('drift', state.drift);

        if (!me.registered) {
            setOffline(false);
            renderAll();
            openRegModal();
            return;
        }
        const [s0, s1, ex, meta] = await Promise.all([
            api('GET', `/api/schedule/${me.user_id}?week_type=0`),
            api('GET', `/api/schedule/${me.user_id}?week_type=1`),
            api('GET', `/api/exams/${me.user_id}`).catch(() => null),
            api('GET', '/api/meta').catch(() => null),
        ]);
        if (!s0.updating) { state.schedules[0] = s0; await kvSet('sched0', s0); }
        if (!s1.updating) { state.schedules[1] = s1; await kvSet('sched1', s1); }
        if (ex) { state.exams = ex; await kvSet('exams', ex); }
        if (meta) { state.meta = meta; await kvSet('meta', meta); }
        await kvSet('lastSync', Date.now());
        await syncNotes();
        setOffline(false);
        renderAll();
    } catch (e) {
        if (e.status === 401) { toast('Сессия истекла'); logout(); return; }
        setOffline(true);
    }
}

async function syncNotes() {
    if (!navigator.onLine) return;
    try {
        const dirty = state.notes.filter((n) => n.dirty).map(({ dirty, ...n }) => n);
        const r = await api('POST', '/api/notes/sync', { notes: dirty });
        state.notes = r.notes.map((n) => ({ ...n, dirty: false }));
        await notesReplaceAll(state.notes);
    } catch (e) { /* останутся dirty до следующей синхронизации */ }
}

// ─── Вход в приложение ────────────────────────────────────────────────────────
async function enterApp() {
    $('app').classList.remove('hidden');
    try {
        await loadFromCache();
        renderAll();
    } catch (e) {
        console.error('[START] загрузка из кэша:', e);
    } finally {
        // Заставку убираем в любом случае: даже с пустым кэшем приложение
        // работоспособно и дозагрузит данные с сервера
        disarmSplashGuard();
        $('splash').classList.add('hidden');
    }
    refreshAll();
    preparePush();
    maybeOfferTour();
}

// ─── Рендер: общее ────────────────────────────────────────────────────────────
function renderAll() {
    applyKindColors();
    renderHeader();
    renderDaysNav();
    renderSchedule();
    renderTasks();
    renderCalendar();
    renderExams();
    renderMore();
    updateTabsVisibility();
}

function renderHeader() {
    const p = state.profile;
    const titles = { schedule: 'Расписание', tasks: 'Задачи', calendar: 'Календарь', exams: 'Сессия', search: 'Поиск', more: 'Ещё', admin: 'Админ-панель' };
    $('hdr-title').textContent = titles[state.currentView] || 'Расписание';
    $('hdr-sub').textContent = p?.registered ? `${p.course} · ${p.group} · ${p.subgroup} п/г` : '';
    const wt = shownWeekType();
    const badge = $('week-badge');
    // Подпись зависит от того, какую неделю смотрим относительно сегодняшней
    const isSunday = botDayIdx(botNow()) === 6;
    let sub = '';
    if (state.weekOffset > 0) sub = 'следующая';
    else if (state.weekOffset < 0) sub = 'прошедшая';
    else if (isSunday) sub = 'будущая';
    badge.innerHTML = esc(weekName(wt)) + (sub ? `<small>${sub}</small>` : '');
    badge.classList.toggle('denominator', wt === 1);
    badge.classList.toggle('hidden', state.currentView !== 'schedule' || !!p?.vacation_mode);
}

function updateTabsVisibility() {
    const p = state.profile;
    const showSession = p && p.session_mode !== 'off' && (p.show_session ?? 1) === 1;
    $('tab-exams').classList.toggle('hidden', !showSession);
}

function switchView(view) {
    state.currentView = view;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('view-' + view).classList.remove('hidden');
    document.querySelectorAll('#tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('views').scrollTop = 0;
    renderHeader();
    haptic();
    if (view === 'admin') loadAdmin();
    if (view === 'calendar') renderCalendar();
    if (view === 'tasks') renderTasks();
    // Вкладка «Поиск» открывается на списке преподавателей — подгружаем сразу
    if (view === 'search' && document.querySelector('#search-seg .seg-btn.active')?.dataset.seg === 'teacher') {
        showTeachersTab();
    }
}

// ─── Расписание ───────────────────────────────────────────────────────────────
function baseMonday() {
    // Базовая неделя: текущая; в воскресенье — уже следующая
    const d = new Date(botNow());
    if (botDayIdx(d) === 6) d.setUTCDate(d.getUTCDate() + 1);
    return mondayOfIso(isoFromUTCParts(d));
}

function displayMonday() {
    // Показываемая неделя = базовая ± сдвиг. Сдвиг двигает И даты, И чётность,
    // иначе пары не совпадали бы с датами (и с календарём).
    const d = baseMonday();
    d.setUTCDate(d.getUTCDate() + state.weekOffset * 7);
    return d;
}

function shownWeekType() {
    return weekTypeForDate(isoFromUTCParts(displayMonday()));
}

function currentSchedDay() {
    if (state.schedDay) return state.schedDay;
    const idx = botDayIdx(botNow());
    return DAYS_FULL[idx === 6 ? 0 : idx];
}

function renderDaysNav() {
    const nav = $('days-nav');
    const monday = displayMonday();
    const todayIso = isoFromUTCParts(botNow());
    const selDay = currentSchedDay();
    nav.innerHTML = '';
    for (let i = 0; i < 6; i++) {
        const d = new Date(monday);
        d.setUTCDate(d.getUTCDate() + i);
        const iso = isoFromUTCParts(d);
        const btn = document.createElement('button');
        btn.className = 'day-btn' + (DAYS_FULL[i] === selDay ? ' active' : '') + (iso === todayIso ? ' today' : '');
        btn.innerHTML = `${DAYS_SHORT[i]}<span class="day-num">${d.getUTCDate()}</span>`;
        btn.addEventListener('click', () => {
            state.schedDay = DAYS_FULL[i];
            renderDaysNav();
            renderSchedule();
            haptic();
        });
        nav.appendChild(btn);
    }
}

function renderSchedule() {
    const list = $('schedule-list');

    // Каникулы: прячем дни недели и показываем заглушку
    if (state.profile?.vacation_mode) {
        $('days-nav').classList.add('hidden');
        list.classList.remove('not-current');
        list.innerHTML = `<div class="rest-card"><span class="rest-emoji">🏖</span><b>Каникулы!</b><br>Пар нет — отдыхаем до начала семестра.</div>`;
        return;
    }
    $('days-nav').classList.remove('hidden');

    const wt = shownWeekType();
    // Пунктир — когда смотрим неделю, в которой нет сегодняшнего дня
    const todayMonday = isoFromUTCParts(mondayOfIso(isoFromUTCParts(botNow())));
    list.classList.toggle('not-current', isoFromUTCParts(displayMonday()) !== todayMonday);
    const sched = state.schedules[wt];
    const day = currentSchedDay();

    if (!sched) {
        list.innerHTML = `<div class="rest-card"><span class="rest-emoji">📡</span>${state.online ? 'Загрузка расписания…' : 'Нет данных. Подключись к интернету один раз — и расписание сохранится.'}</div>`;
        return;
    }
    const lessonsRaw = (sched[day] || []).map(parseLesson);
    const real = lessonsRaw.filter((l) => !l.empty);
    if (!real.length) {
        list.innerHTML = `<div class="rest-card"><span class="rest-emoji">🎉</span>${esc(restText())}</div>`;
        return;
    }

    // Подсветка текущей пары — только если смотрим реальное «сегодня»
    const now = botNow();
    const isActualToday = DAYS_FULL[botDayIdx(now)] === day &&
        wt === weekTypeForDate(isoFromUTCParts(now));
    const nowMin = botMinutes(now);

    list.innerHTML = lessonsRaw.map((l, li) => {
        const sMin = parseTimeMin(l.start), eMin = parseTimeMin(l.end);
        const isCurrent = isActualToday && !l.empty && nowMin >= sMin && nowMin < eMin;
        const colorsOn = FEATURE_LESSON_COLORS && (state.profile?.lesson_colors_on ?? 1) === 1;
        const kind = (l.empty || !colorsOn) ? { cls: '', badge: '' } : lessonKind(l.text);
        // Привязываем пару к конкретной дате показываемой недели: клик → создать заметку
        const dayIdx = DAYS_FULL.indexOf(day);
        const monday = displayMonday();
        const lessonDate = new Date(monday); lessonDate.setUTCDate(lessonDate.getUTCDate() + dayIdx);
        return `<div class="lesson-card ${kind.cls}${l.empty ? ' empty' : ''}${isCurrent ? ' current' : ''}${l.empty ? '' : ' clickable'}"
            data-lesson-date="${isoFromUTCParts(lessonDate)}" data-lesson-wt="${wt}" data-lesson-time="${esc(l.start)}" data-lesson-text="${esc(l.text)}">
            <div class="lesson-time"><b>${esc(l.start)}</b><span>${esc(l.end)}</span></div>
            <div class="lesson-text">
                ${isCurrent ? '<span class="lesson-now-badge">Сейчас</span>' : ''}
                ${kind.badge ? `<span class="kind-badge">${kind.badge}</span>` : ''}
                ${isCurrent || kind.badge ? '<br>' : ''}${esc(l.text)}
            </div>
        </div>`;
    }).join('');

    renderDayTasks();
}

// Задачи на показанный день расписания (все, без фильтров — и выполненные, и нет).
function renderDayTasks() {
    const box = $('day-tasks');
    if (!box) return;
    const p = state.profile;
    if (!p || !p.registered) { box.innerHTML = ''; return; }
    const day = currentSchedDay();
    const dayIdx = DAYS_FULL.indexOf(day);
    if (dayIdx < 0) { box.innerHTML = ''; return; }
    const monday = displayMonday();
    const d = new Date(monday); d.setUTCDate(d.getUTCDate() + dayIdx);
    const iso = isoFromUTCParts(d);
    const list = state.notes.filter((n) => !n.deleted && n.date === iso);
    if (!list.length) { box.innerHTML = ''; return; }
    list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || (prioOf(b) - prioOf(a)));
    box.innerHTML = `<div class="section-title">📌 Задачи на ${esc(formatDateShort(iso))}</div>` + list.map((n) => {
        const done = doneFromTitle(n.title);
        const pr = prioOf(n);
        return `<div class="note-card task-card prio-${pr}${done ? ' done' : ''}" data-note="${esc(n.client_id)}">
            <button class="task-done${done ? ' is-done' : ''}" data-toggle-done="${esc(n.client_id)}" title="Отметить выполненным">${done ? '✅' : '☐'}</button>
            <div class="note-info">
                <div class="note-title">${esc(titleWithoutPrio(titleWithoutDone(n.title)) || 'Без названия')}</div>
                ${n.body ? `<div class="note-body">${esc(n.body)}</div>` : ''}
                <div class="note-meta">${n.time ? '⏰ ' + esc(n.time) : ''}</div>
            </div></div>`;
    }).join('');
    document.querySelectorAll('#day-tasks .task-card[data-note]').forEach((el) => {
        el.addEventListener('click', () => openNoteModal(state.notes.find((n) => n.client_id === el.dataset.note)));
    });
    document.querySelectorAll('#day-tasks [data-toggle-done]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDone(b.dataset.toggleDone);
    }));
}

// ─── Таймер ───────────────────────────────────────────────────────────────────
function fmtHMS(totalSec) {
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    return (h > 0 ? h + ':' + pad2(m) : m) + ':' + pad2(s);
}

function updateCountdown() {
    const card = $('countdown-card');
    const p = state.profile;
    if (state.currentView !== 'schedule' || !p?.registered || !(p.show_timer ?? 1) || p.vacation_mode) {
        card.classList.add('hidden');
        return;
    }
    const now = botNow();
    const todayIdx = botDayIdx(now);
    if (todayIdx === 6) { card.classList.add('hidden'); return; }
    const wt = weekTypeForDate(isoFromUTCParts(now));
    const sched = state.schedules[wt];
    if (!sched) { card.classList.add('hidden'); return; }
    const lessons = (sched[DAYS_FULL[todayIdx]] || []).map(parseLesson).filter((l) => !l.empty);
    if (!lessons.length) { card.classList.add('hidden'); return; }

    const nowSec = botMinutes(now) * 60 + now.getUTCSeconds();
    let label = null, target = 0, sub = '';
    for (const l of lessons) {
        const s = parseTimeMin(l.start) * 60, e = parseTimeMin(l.end) * 60;
        if (nowSec >= s && nowSec < e) {
            label = 'До конца пары';
            target = e;
            sub = l.text;
            break;
        }
        if (nowSec < s) {
            const mode = p.timer_start_mode ?? 0;
            if (mode === -1) { card.classList.add('hidden'); return; }
            if (mode > 0 && s - nowSec > mode * 3600) { card.classList.add('hidden'); return; }
            label = 'До начала пары';
            target = s;
            sub = l.text;
            break;
        }
    }
    if (!label) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('countdown-label').textContent = label;
    $('countdown-timer').textContent = fmtHMS(target - nowSec);
    $('countdown-sub').textContent = sub.length > 70 ? sub.slice(0, 70) + '…' : sub;
}

// ─── Календарь ────────────────────────────────────────────────────────────────
function calInit() {
    if (!state.calMonth) {
        const t = new Date();
        state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
        state.calSelected = isoFromLocalParts(t);
    }
}

function dayHasLessons(iso) {
    if (state.profile?.vacation_mode) return false;
    const [y, m, d] = iso.split('-').map(Number);
    const wd = (new Date(y, m - 1, d).getDay() + 6) % 7;
    if (wd === 6) return false;
    const sched = state.schedules[weekTypeForDate(iso)];
    if (!sched) return false;
    return (sched[DAYS_FULL[wd]] || []).map(parseLesson).some((l) => !l.empty);
}

function notesForDate(iso) {
    return state.notes
        .filter((n) => !n.deleted && n.date === iso)
        .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

function examsForDate(iso) {
    return (state.exams?.exams || []).filter((e) => e.date === iso);
}

function renderCalendar() {
    calInit();
    const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
    $('cal-title').textContent = `${MONTHS_NOM[m]} ${y}`;
    const grid = $('cal-grid');
    grid.innerHTML = '';
    const firstWd = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const todayIso = isoFromLocalParts(new Date());
    const totalCells = Math.ceil((firstWd + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
        const dayNum = i - firstWd + 1;
        let cellDate, other = false;
        if (dayNum < 1) { cellDate = new Date(y, m - 1, prevDays + dayNum); other = true; }
        else if (dayNum > daysInMonth) { cellDate = new Date(y, m + 1, dayNum - daysInMonth); other = true; }
        else cellDate = new Date(y, m, dayNum);
        const iso = isoFromLocalParts(cellDate);

        const btn = document.createElement('button');
        btn.className = 'cal-cell' + (other ? ' other' : '') + (iso === todayIso ? ' today' : '') + (iso === state.calSelected ? ' selected' : '');
        let dots = '';
        if (!other) {
            if (dayHasLessons(iso)) dots += '<i class="dot dot-lesson"></i>';
            if (notesForDate(iso).length) dots += '<i class="dot dot-note"></i>';
            if (examsForDate(iso).length) dots += '<i class="dot dot-exam"></i>';
        }
        btn.innerHTML = `${cellDate.getDate()}<span class="cell-dots">${dots}</span>`;
        btn.addEventListener('click', () => {
            state.calSelected = iso;
            if (other) state.calMonth = new Date(cellDate.getFullYear(), cellDate.getMonth(), 1);
            renderCalendar();
            haptic();
        });
        grid.appendChild(btn);
    }
    renderDayPanel();
}

function renderDayPanel() {
    const iso = state.calSelected;
    if (!iso) return;
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const wd = (dt.getDay() + 6) % 7;
    const wt = weekTypeForDate(iso);
    $('day-panel-title').textContent = `${DAYS_SHORT[wd]}, ${d} ${MONTHS_GEN[m - 1]} · ${weekName(wt)}`;

    let html = '';
    for (const ex of examsForDate(iso)) {
        html += `<div class="note-card" style="border-left-color: var(--red)">
            <div class="note-info">
                <div class="note-title">🎓 Экзамен: ${esc(ex.subject)}</div>
                <div class="note-body">${esc(ex.time)} · ауд. ${esc(ex.room)}${ex.teacher ? ' · ' + esc(ex.teacher) : ''}</div>
            </div></div>`;
    }

    if (wd < 6 && !state.profile?.vacation_mode) {
        const sched = state.schedules[wt];
        const lessons = sched ? (sched[DAYS_FULL[wd]] || []).map(parseLesson).filter((l) => !l.empty) : [];
        if (lessons.length) {
            html += `<div class="card" style="margin-bottom:8px">` + lessons.map((l) =>
                `<div class="mini-lesson clickable" data-lesson-date="${iso}" data-lesson-time="${esc(l.start)}" data-lesson-text="${esc(l.text)}"><b>${esc(l.start)}</b><span>${esc(l.text)}</span></div>`).join('') + `</div>`;
        }
    }

    const notes = notesForDate(iso);
    for (const n of notes) {
        const remindStr = n.remind_at ? ' · 🔔' : '';
        const done = doneFromTitle(n.title);
        html += `<div class="note-card${done ? ' done' : ''}" data-note="${esc(n.client_id)}">
            <div class="note-info">
                <div class="note-title">${esc(titleWithoutPrio(titleWithoutDone(n.title)) || 'Без названия')}</div>
                ${n.body ? `<div class="note-body">${esc(n.body)}</div>` : ''}
                <div class="note-meta">${n.time ? '⏰ ' + esc(n.time) : 'Весь день'}${remindStr}${n.dirty ? ' · ожидает синх.' : ''}</div>
            </div>
            <button class="task-done${done ? ' is-done' : ''}" data-toggle-done="${esc(n.client_id)}" title="Отметить выполненным">${done ? '✅' : '☐'}</button>
        </div>`;
    }
    if (!html) html = `<p class="muted small center" style="padding:14px 0">Пусто. Добавь заметку!</p>`;
    $('day-panel-content').innerHTML = html;
    document.querySelectorAll('#day-panel-content .note-card[data-note]').forEach((el) => {
        el.addEventListener('click', () => openNoteModal(state.notes.find((n) => n.client_id === el.dataset.note)));
    });
    document.querySelectorAll('#day-panel-content [data-toggle-done]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDone(b.dataset.toggleDone);
    }));
}

// ─── Заметки ──────────────────────────────────────────────────────────────────
function openModal(id) {
    $('modal-backdrop').classList.remove('hidden');
    $(id).classList.remove('hidden');
}
function closeModals() {
    $('modal-backdrop').classList.add('hidden');
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

function setPrioUI(segId, prio) {
    document.querySelectorAll('#' + segId + ' .seg-btn').forEach((b) => b.classList.toggle('active', +b.dataset.prio === prio));
    state.notePrio = prio;
}

function openNoteModal(note) {
    state.editingNote = note || null;
    const pre = (note ? null : state.prefill) || null;
    const baseTitle = note ? note.title : (pre ? pre.title : '');
    $('note-modal-title').textContent = note ? 'Заметка' : (pre ? 'Новая задача' : 'Новая заметка');
    $('note-title').value = titleWithoutPrio(titleWithoutDone(baseTitle));
    $('note-body').value = note?.body || (pre ? (pre.body || '') : '');
    $('note-date').value = note?.date || (pre && pre.date) || state.calSelected || isoFromLocalParts(new Date());
    $('note-time').value = note?.time || (pre && pre.time ? pre.time : '');
    $('note-delete-btn').classList.toggle('hidden', !note);
    const prio = note ? prioFromTitle(note.title) : (pre && pre.prio ? pre.prio : 2);
    setPrioUI('note-priority-seg', prio);
    // восстановить смещение напоминания
    let remindVal = '';
    if (note?.remind_at) {
        const event = noteEventDate(note.date, note.time);
        const diffMin = Math.round((event - new Date(note.remind_at)) / 60000);
        remindVal = ['0', '15', '60', '180', '1440'].includes(String(diffMin)) ? String(diffMin) : '0';
    }
    $('note-remind').value = remindVal;
    updateRemindHint();
    state.prefill = null;
    openModal('note-modal');
}

function noteEventDate(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '09:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm);
}

function updateRemindHint() {
    const v = $('note-remind').value;
    const hint = $('note-remind-hint');
    if (v === '') { hint.textContent = ''; return; }
    const date = $('note-date').value, time = $('note-time').value;
    if (!date) { hint.textContent = ''; return; }
    const at = new Date(noteEventDate(date, time).getTime() - (+v) * 60000);
    hint.textContent = `Уведомление: ${pad2(at.getDate())}.${pad2(at.getMonth() + 1)} в ${pad2(at.getHours())}:${pad2(at.getMinutes())}` + (time ? '' : ' (время события не задано — считаю от 09:00)');
}

async function saveNote() {
    const date = $('note-date').value;
    const title = $('note-title').value.trim();
    const body = $('note-body').value.trim();
    if (!date) { toast('Укажи дату'); return; }
    if (!title && !body) { toast('Пустая заметка'); return; }

    let remind_at = null;
    const rv = $('note-remind').value;
    if (rv !== '') {
        const at = new Date(noteEventDate(date, $('note-time').value).getTime() - (+rv) * 60000);
        if (at <= new Date()) {
            toast('Время напоминания уже прошло — уведомление отключено');
        } else {
            remind_at = at.toISOString();
        }
    }
    const wasDone = doneFromTitle(state.editingNote ? state.editingNote.title : '');
    const note = {
        client_id: state.editingNote?.client_id || uuid(),
        date,
        time: $('note-time').value || null,
        title: composeTitle(title, state.notePrio, wasDone), body, remind_at,
        updated_at: Date.now(),
        deleted: 0,
        dirty: true,
    };
    const idx = state.notes.findIndex((n) => n.client_id === note.client_id);
    if (idx >= 0) state.notes[idx] = note; else state.notes.push(note);
    await notePut(note);
    closeModals();
    renderCalendar();
    toast('Сохранено');
    haptic('medium');
    syncNotes().then(renderCalendar);
}

async function deleteNote() {
    const n = state.editingNote;
    if (!n) return;
    n.deleted = 1;
    n.updated_at = Date.now();
    n.dirty = true;
    await notePut(n);
    closeModals();
    renderCalendar();
    toast('Заметка удалена');
    syncNotes().then(renderCalendar);
}

// ─── Сессия (экзамены) ────────────────────────────────────────────────────────
function renderExams() {
    const ex = state.exams;
    if (!ex) {
        $('session-title').textContent = 'Сессия';
        $('session-sub').textContent = state.online ? 'Загрузка…' : 'Нет данных (оффлайн)';
        $('exam-list').innerHTML = '';
        return;
    }
    $('session-title').textContent = ex.session_label;
    $('session-sub').textContent = `${ex.course} · ${ex.group}`;
    const list = $('exam-list');
    if (!ex.has_exams) {
        list.innerHTML = `<div class="rest-card"><span class="rest-emoji">📭</span>Экзамены не найдены в расписании</div>`;
        $('exam-next-card').classList.add('hidden');
        return;
    }
    const next = ex.exams.find((e) => e.status === 'next');
    if (next) {
        $('exam-next-card').classList.remove('hidden');
        $('exam-next-name').textContent = next.subject;
    } else {
        $('exam-next-card').classList.add('hidden');
    }
    list.innerHTML = ex.exams.map((e) => {
        let badge = '';
        if (e.status === 'next') {
            badge = e.is_now ? '🔥 Идёт сейчас' : (e.days_left === 0 ? '🔥 Сегодня' : e.days_left === 1 ? '🔥 Завтра' : `🔥 через ${e.days_left} дн.`);
        } else if (e.status === 'future') {
            badge = `через ${e.days_left} дн.`;
        } else badge = '✅ Сдан';
        return `<div class="exam-card ${e.status}">
            <div class="exam-date"><span>${esc(e.date_display)} (${esc(e.weekday)})</span><span class="exam-badge">${badge}</span></div>
            <div class="exam-info">⏰ <b>${esc(e.time)}</b> · 🚪 ауд. <b>${esc(e.room)}</b><br>📖 ${esc(e.subject)}${e.teacher ? `<br><span class="muted">👨‍🏫 ${esc(e.teacher)}</span>` : ''}</div>
        </div>`;
    }).join('');
}

function updateExamCountdown() {
    if (state.currentView !== 'exams' || !state.exams?.has_exams) return;
    const next = state.exams.exams.find((e) => e.status === 'next');
    if (!next) return;
    const [y, m, d] = next.date.split('-').map(Number);
    const [hh, mm] = next.time.split(':').map(Number);
    const target = Date.UTC(y, m - 1, d, hh, mm) / 1000;
    const now = Math.floor(Date.now() / 1000) + state.drift;
    const diff = target - now;
    const el = $('exam-next-countdown');
    if (diff <= 0) { el.textContent = 'Экзамен идёт!'; return; }
    const days = Math.floor(diff / 86400);
    const rest = diff % 86400;
    el.textContent = (days > 0 ? days + ' дн. ' : '') + fmtHMS(rest);
}

// ─── Поиск ────────────────────────────────────────────────────────────────────
function initSearchForms() {
    const daySel = $('rooms-day');
    DAYS_FULL.slice(0, 6).forEach((d) => {
        const o = document.createElement('option');
        o.value = d; o.textContent = d;
        daySel.appendChild(o);
    });
    const slotSel = $('rooms-slot');
    TIME_SLOTS.forEach((s) => {
        const val = `${s.start} - ${s.end}`;
        const o = document.createElement('option');
        o.value = val; o.textContent = val;
        slotSel.appendChild(o);
    });
}

// ─── Преподаватели ────────────────────────────────────────────────────────────
// Списки кэшируются в IndexedDB вместе с расписанием — вкладка открывается
// оффлайн, а расписание конкретного преподавателя требует сети.
const teachers = { my: null, all: null, mySig: null, scope: 'my', filter: '', openKey: null };

// Подпись профиля: список «Мои» принадлежит конкретной группе, и при смене
// курса/группы кэш обязан промахнуться, иначе останутся чужие преподаватели.
function teachersSig() {
    const p = state.profile;
    return p ? `${p.course}|${p.group}|${p.subgroup}` : 'none';
}

function teachersCacheKey(scope) {
    return scope === 'my' ? 'teachers_my_' + teachersSig() : 'teachers_all';
}

function dropMyTeachers() {
    teachers.my = null;
    teachers.mySig = null;
}

async function loadTeachers(scope, force) {
    if (scope === 'my' && teachers.mySig !== teachersSig()) dropMyTeachers();
    if (teachers[scope] && !force) return teachers[scope];
    const key = teachersCacheKey(scope);
    const cached = await kvGet(key);
    if (cached && !force) {
        teachers[scope] = cached;
        if (scope === 'my') teachers.mySig = teachersSig();
        return cached;
    }
    if (!navigator.onLine) return null;
    if (scope === 'my') {
        if (!state.userId) { teachers.my = []; teachers.mySig = teachersSig(); return teachers.my; }
        try {
            const data = await api('GET', '/api/teachers/my/' + state.userId);
            teachers.my = data.teachers || [];
        } catch (e) {
            teachers.my = [];   // профиль ещё не заполнен — покажем подсказку
            teachers.mySig = teachersSig();
            return teachers.my;
        }
        teachers.mySig = teachersSig();
    } else {
        teachers.all = await api('GET', '/api/teachers');
    }
    await kvSet(key, teachers[scope]);
    return teachers[scope];
}

function teacherCardHtml(t) {
    const meta = [t.position, t.degree].filter(Boolean).join(' · ');
    const open = teachers.openKey === t.key;
    const initials = t.has_full_name ? '' : ' <span class="muted small">(только инициалы)</span>';
    return `<div class="search-item teacher-item${open ? ' open' : ''}" data-key="${esc(t.key)}">
        <h4>${esc(t.full_name)}${initials}</h4>
        ${meta ? `<p class="muted small">${esc(meta)}</p>` : ''}
        ${t.department ? `<p class="muted small">${esc(t.department)}</p>` : ''}
        <p class="teacher-subjects">${t.subjects.slice(0, 4).map(esc).join(' · ')}</p>
        <div class="teacher-detail" ${open ? '' : 'hidden'}>
            <div class="teacher-actions">
                <button class="ghost-btn" data-act="schedule">📅 Расписание</button>
                ${t.url ? `<a class="ghost-btn" href="${esc(t.url)}" target="_blank" rel="noopener">🔗 На сайте ВГУ</a>` : ''}
            </div>
            <div class="teacher-schedule"></div>
        </div>
    </div>`;
}

function renderTeachers() {
    const box = $('teachers-list');
    const list = teachers[teachers.scope];
    if (list === null) {
        box.innerHTML = navigator.onLine
            ? '<div class="loader" style="margin:20px auto"></div>'
            : '<p class="muted center" style="padding:16px">Список ещё не загружен — нужен интернет</p>';
        return;
    }
    const q = teachers.filter.toLowerCase();
    const shown = q
        ? list.filter((t) => t.full_name.toLowerCase().includes(q)
            || t.subjects.some((s) => s.toLowerCase().includes(q)))
        : list;
    if (!shown.length) {
        box.innerHTML = `<p class="muted center" style="padding:16px">${
            teachers.scope === 'my' && !list.length
                ? 'Сначала укажи курс и группу в профиле'
                : 'Никого не нашлось'}</p>`;
        return;
    }
    box.innerHTML = `<p class="muted small teachers-count">${shown.length} чел.</p>`
        + shown.map(teacherCardHtml).join('');
}

async function showTeachersTab(force) {
    if (teachers.scope === 'my' && teachers.mySig !== teachersSig()) dropMyTeachers();
    if (teachers[teachers.scope] === null || force) { teachers.openKey = null; renderTeachers(); }
    try {
        await loadTeachers(teachers.scope, force);
    } catch (e) {
        toast('Не удалось загрузить список');
    }
    renderTeachers();
}

async function loadTeacherSchedule(key, box) {
    if (!navigator.onLine) { box.innerHTML = '<p class="muted small">Расписание доступно только онлайн</p>'; return; }
    box.innerHTML = '<div class="loader" style="margin:12px auto"></div>';
    try {
        const data = await api('GET', '/api/search/teacher?name=' + encodeURIComponent(key));
        box.innerHTML = data.length
            ? data.map((i) => `<div class="teacher-slot"><b>${esc(i.day)} · ${esc(i.time)}</b>
                <span class="muted small">[${esc(i.week_type)}] ${esc(i.course)}, ${esc(i.group)}</span>
                <span>${esc(i.subject)}</span></div>`).join('')
            : '<p class="muted small">Пар не найдено</p>';
    } catch (e) { box.innerHTML = '<p class="muted small">Ошибка загрузки</p>'; }
}

async function doRoomsSearch() {
    if (!navigator.onLine) { toast('Поиск недоступен оффлайн'); return; }
    const res = $('search-results');
    res.innerHTML = '<div class="loader" style="margin:20px auto"></div>';
    try {
        const q = `day=${encodeURIComponent($('rooms-day').value)}&slot=${encodeURIComponent($('rooms-slot').value)}&week_type=${$('rooms-week').value}`;
        const data = await api('GET', '/api/search/rooms?' + q);
        let html = '';
        if (data.main?.length) html += `<div class="search-item"><h4>Главный / 2 корпус</h4><p>${data.main.map(esc).join(', ')}</p></div>`;
        if (data.p?.length) html += `<div class="search-item"><h4>Пристройка (П)</h4><p>${data.p.map(esc).join(', ')}</p></div>`;
        res.innerHTML = html || '<p class="muted center" style="padding:16px">Свободных аудиторий нет</p>';
    } catch (e) { res.innerHTML = ''; toast('Ошибка поиска'); }
}

// ─── Ещё / настройки ──────────────────────────────────────────────────────────
async function renderMore() {
    const p = state.profile;
    $('profile-name').textContent = p?.registered ? `${p.course}, ${p.group}` : 'Профиль не настроен';
    $('profile-sub').textContent = p?.registered ? `Подгруппа ${p.subgroup}` : 'Нажми «Изменить»';
    document.querySelectorAll('#mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === (p?.mode || 'обычный')));
    $('timer-toggle').checked = (p?.show_timer ?? 1) === 1;
    $('timer-mode-select').value = String(p?.timer_start_mode ?? 0);
    $('session-toggle').checked = (p?.show_session ?? 1) === 1;
    // Отладочные инструменты видит только администратор
    $('push-diag-btn').classList.toggle('hidden', !state.isAdmin);
    if (!state.isAdmin) {
        $('push-diag').classList.add('hidden');
        $('sw-reset-btn').classList.add('hidden');
    }
    const nc = p?.notify_channel || 'both';
    document.querySelectorAll('#notify-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.nc === nc));
    $('admin-entry').classList.toggle('hidden', !state.isAdmin);
    // Внутри Telegram показываем карточку с кнопкой «в Safari», в браузере — текстовую памятку
    $('install-tg-card').classList.toggle('hidden', !state.tg);
    $('install-card').classList.toggle('hidden', !!state.tg || window.navigator.standalone === true);

    const last = await kvGet('lastSync');
    $('sync-info').textContent = last ? `Данные обновлены: ${new Date(last).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
    renderSummaryUI();
    renderColorsUI();
    refreshPushUI();
}

// ─── Настройка цветов типов пар ───────────────────────────────────────────────
function renderColorsUI() {
    $('colors-card').classList.toggle('hidden', !FEATURE_LESSON_COLORS);
    if (!FEATURE_LESSON_COLORS) return;
    const p = state.profile || {};
    const on = (p.lesson_colors_on ?? 1) === 1;
    $('colors-toggle').checked = on;
    const box = $('colors-list');
    box.classList.toggle('hidden', !on);
    $('colors-reset').classList.toggle('hidden', !on);
    if (!on) { box.innerHTML = ''; return; }
    const colors = currentKindColors();
    box.innerHTML = '';
    for (const kind of Object.keys(KIND_DEFAULTS)) {
        const row = document.createElement('div');
        row.className = 'color-row';
        row.innerHTML = `<span class="color-name">${esc(KIND_TITLES[kind])}</span>`;
        const chip = document.createElement('button');
        chip.className = 'color-chip';
        chip.style.background = colors[kind];
        chip.addEventListener('click', () => openColorModal(kind));
        row.appendChild(chip);
        box.appendChild(row);
    }
}

let editingKind = null;

function openColorModal(kind) {
    editingKind = kind;
    $('color-modal-title').textContent = KIND_TITLES[kind];
    const current = currentKindColors()[kind];
    const pal = $('color-palette');
    pal.innerHTML = '';
    COLOR_PALETTE.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'color-opt' + (c.toLowerCase() === String(current).toLowerCase() ? ' active' : '');
        b.style.background = c;
        b.addEventListener('click', () => {
            saveKindColor(kind, c);
            closeModals();
        });
        pal.appendChild(b);
    });
    openModal('color-modal');
}

async function saveKindColor(kind, color) {
    const colors = currentKindColors();
    colors[kind] = color;
    const custom = {};
    for (const [k, v] of Object.entries(colors)) {
        if (v.toLowerCase() !== KIND_DEFAULTS[k]) custom[k] = v;
    }
    if (state.profile) state.profile.lesson_colors = JSON.stringify(custom);
    applyKindColors();
    renderColorsUI();
    renderSchedule();
    await kvSet('profile', state.profile);
    haptic();
    try {
        await api('POST', '/api/lesson_colors', { colors: custom, enabled: (state.profile.lesson_colors_on ?? 1) ? 1 : 0 });
    } catch (e) { toast('Нет сети — цвет сохранён на этом устройстве'); }
}

async function saveColorsEnabled(on) {
    if (state.profile) state.profile.lesson_colors_on = on ? 1 : 0;
    await kvSet('profile', state.profile);
    renderColorsUI();
    renderSchedule();
    try {
        let custom = {};
        try { custom = JSON.parse(state.profile.lesson_colors || '{}'); } catch (e) { }
        await api('POST', '/api/lesson_colors', { colors: custom, enabled: on ? 1 : 0 });
    } catch (e) { toast('Нет сети — настройка сохранена локально'); }
}

async function resetKindColors() {
    if (state.profile) state.profile.lesson_colors = '';
    applyKindColors();
    renderColorsUI();
    renderSchedule();
    await kvSet('profile', state.profile);
    try { await api('POST', '/api/lesson_colors', { colors: {}, enabled: 1 }); } catch (e) { }
    toast('Цвета сброшены');
}

// ─── Сводка расписания ────────────────────────────────────────────────────────
function renderSummaryUI() {
    const p = state.profile || {};
    const en = (p.summary_enabled ?? 0) === 1;
    $('summary-toggle').checked = en;
    $('summary-box').classList.toggle('hidden', !en);
    const mode = p.summary_mode || 'evening';
    document.querySelectorAll('#summary-mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.sm === mode));
    $('summary-evening-box').classList.toggle('hidden', mode !== 'evening');
    $('summary-sameday-box').classList.toggle('hidden', mode !== 'sameday');
    $('summary-time').value = p.summary_time || '20:00';
    $('summary-before').value = String(p.summary_before || 60);
    const skip = new Set(String(p.summary_skip_days ?? '').split(',').filter((x) => x !== '').map(Number));
    const box = $('summary-skip');
    box.innerHTML = '';
    DAYS_SHORT.slice(0, 6).forEach((d, i) => {
        const b = document.createElement('button');
        b.className = 'skip-chip' + (skip.has(i) ? ' on' : '');
        b.textContent = d;
        b.addEventListener('click', () => {
            skip.has(i) ? skip.delete(i) : skip.add(i);
            saveSummary({ summary_skip_days: [...skip].sort().join(',') });
        });
        box.appendChild(b);
    });
}

async function saveSummary(partial) {
    const p = state.profile;
    if (!p?.registered) return;
    Object.assign(p, partial);
    renderSummaryUI();
    await kvSet('profile', p);
    try {
        await api('POST', '/api/summary_settings', {
            enabled: (p.summary_enabled ?? 0) ? 1 : 0,
            mode: p.summary_mode || 'evening',
            time: p.summary_time || '20:00',
            before: parseInt(p.summary_before) || 60,
            skip_days: String(p.summary_skip_days ?? '').split(',').filter((x) => x !== '').map(Number),
        });
        toast('Сохранено');
    } catch (e) {
        toast('Нет сети — попробуй ещё раз');
    }
}

async function refreshPushUI() {
    const hint = $('push-hint');
    const toggle = $('push-toggle');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        toggle.checked = false;
        toggle.disabled = true;
        hint.textContent = 'Push недоступен в этом режиме. На iPhone установи приложение на экран «Домой» (Safari → Поделиться → На экран «Домой») и включи уведомления там. Напоминания продолжат приходить в бот.';
        return;
    }
    toggle.disabled = false;
    if (!state.swReg || !state.vapidKey) preparePush();
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) throw new Error('service worker не зарегистрирован');
        const sub = await reg.pushManager.getSubscription();
        toggle.checked = !!sub && Notification.permission === 'granted';
        const permText = { granted: 'разрешены', denied: 'запрещены в настройках iOS', default: 'ещё не запрашивались' }[Notification.permission] || Notification.permission;
        hint.textContent = toggle.checked
            ? '✅ Push включены: напоминания и объявления будут приходить уведомлениями на это устройство.'
            : `Push выключены. Разрешение — ${permText}, подписка — ${sub ? 'есть' : 'нет'}.`;
        $('sw-reset-btn').classList.toggle('hidden', toggle.checked || !state.isAdmin);
    } catch (e) {
        toggle.checked = false;
        hint.textContent = state.isAdmin
            ? 'Проблема с service worker: ' + (e.message || e)
            : 'Не удалось подготовить уведомления — закрой и открой приложение ещё раз.';
        $('sw-reset-btn').classList.toggle('hidden', !state.isAdmin);
    }
}

// ─── Диагностика уведомлений ─────────────────────────────────────────────────
async function pushDiagnostics() {
    const L = [];
    const mode = window.navigator.standalone === true ? 'PWA с домашнего экрана'
        : state.tg ? 'Telegram Mini App'
        : window.matchMedia('(display-mode: standalone)').matches ? 'PWA (standalone)' : 'браузер';
    L.push('режим: ' + mode);
    L.push('версия: ' + APP_VERSION);
    L.push('Push API: ' + ('PushManager' in window ? 'есть' : 'НЕТ (нужна установка на домашний экран)'));
    L.push('разрешение: ' + (window.Notification ? Notification.permission : 'нет API'));
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) L.push('service worker: НЕ зарегистрирован');
        else {
            L.push('service worker: ' + (reg.active ? 'активен' : reg.installing ? 'устанавливается' : reg.waiting ? 'ожидает' : 'неактивен'));
            L.push('область: ' + reg.scope);
            const sub = await reg.pushManager.getSubscription();
            L.push('подписка: ' + (sub ? 'есть (' + new URL(sub.endpoint).host + ')' : 'нет'));
        }
    } catch (e) {
        L.push('ошибка SW: ' + (e.message || e));
    }
    L.push('готовность: SW ' + (state.swReg ? 'ок' : 'нет') + ', ключ ' + (state.vapidKey ? 'ок' : 'нет'));
    L.push('сеть: ' + (navigator.onLine ? 'онлайн' : 'оффлайн'));
    if (state.lastPushError) L.push('последняя ошибка: ' + state.lastPushError);
    else L.push('последняя ошибка: нет');
    L.push('');
    L.push('Подписка создаётся Safari напрямую у серверов Apple (APNs)');
    L.push('и работает только внутри нажатия — поэтому всё готовится заранее.');
    return L.join('\n');
}

async function resetServiceWorker() {
    try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
        toast('Service worker сброшен, перезагружаю…');
        setTimeout(() => location.reload(), 1200);
    } catch (e) {
        toast('Не удалось сбросить: ' + (e.message || e));
    }
}

function urlB64ToUint8(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// navigator.serviceWorker.ready виснет навсегда, если установка SW не удалась.
// Берём регистрацию напрямую и дожидаемся активации с понятной ошибкой.
async function getActiveSW() {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register('./sw.js?v=' + APP_VERSION);
    if (reg.active) return reg;
    const worker = reg.installing || reg.waiting;
    if (!worker) {
        await reg.update();
        if (reg.active) return reg;
        throw new Error('service worker не установился');
    }
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('service worker не активировался за 15 c')), 15000);
        worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') { clearTimeout(timer); resolve(); }
            if (worker.state === 'redundant') { clearTimeout(timer); reject(new Error('установка service worker отклонена')); }
        });
    });
    return await navigator.serviceWorker.getRegistration();
}

// Готовим всё заранее: Safari на iOS выполняет pushManager.subscribe() только
// внутри «живого» жеста пользователя. Любой await до вызова съедает активацию,
// и подписка молча не создаётся — именно так выглядел баг.
async function preparePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        state.swReg = await getActiveSW();
        if (!state.vapidKey) state.vapidKey = (await api('GET', '/api/push/key')).key;
    } catch (e) {
        console.warn('[PUSH] подготовка:', e);
    }
}

async function enablePush() {
    $('push-hint').textContent = '⏳ Подключаю уведомления… (до 20 секунд)';
    try {
        if (Notification.permission === 'denied') {
            toast('Уведомления запрещены — включи их в Настройках iOS для этого приложения');
            refreshPushUI();
            return;
        }
        // Всё готово? Тогда subscribe вызывается СРАЗУ, без единого await перед ним
        if (!state.swReg || !state.vapidKey) {
            await preparePush();
            if (!state.swReg || !state.vapidKey) throw new Error('не удалось подготовить подписку — попробуй ещё раз');
        }
        const reg = state.swReg;
        const key = state.vapidKey;
        // Ни одного await до subscribe: getSubscription() тоже съедает жест.
        // subscribe() идемпотентен — при том же ключе вернёт существующую подписку.
        let sub = null;
        {
            // Разрешение спрашиваем только если его ещё нет: requestPermission
            // сам по себе является жестом и позволяет вызвать subscribe следом.
            if (Notification.permission !== 'granted') {
                const perm = await Notification.requestPermission();
                if (perm !== 'granted') {
                    toast('Разрешение на уведомления не выдано');
                    refreshPushUI();
                    return;
                }
            }
            const subPromise = reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8(key),
            });
            sub = await Promise.race([
                subPromise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('apns-timeout')), 20000)),
            ]);
        }
        if (!sub) throw new Error('подписка не создана');
        await api('POST', '/api/push/subscribe', sub.toJSON());
        toast('Уведомления включены 🔔');
    } catch (e) {
        console.error('[PUSH]', e);
        state.lastPushError = `${e.name || 'Error'}: ${e.message || e.status || e}`;
        let msg;
        if (e.message === 'apns-timeout') {
            msg = 'Служба уведомлений не ответила за 20 c. Попробуй ещё раз — иногда помогает перезапуск приложения';
            state.lastPushError += ' (нет ответа от APNs; проверь сеть/VPN и повтори)';
        }
        else if (e.name === 'AbortError' || e.name === 'NotAllowedError') {
            msg = 'Система отказала в подписке. Отключи VPN, проверь Настройки → Уведомления → ВГУ ФКН';
        }
        else if (e.name === 'InvalidStateError') {
            // осталась подписка со старым ключом — снимаем её, следующая попытка пройдёт
            try {
                const old = await state.swReg.pushManager.getSubscription();
                if (old) await old.unsubscribe();
            } catch (e2) { }
            msg = 'Старая подписка снята — нажми переключатель ещё раз';
        }
        else if (String(e.message).includes('service worker')) msg = e.message + ' — нажми «Переустановить service worker»';
        else if (e.status === 401) msg = 'Сессия истекла — войди заново';
        else msg = 'Не удалось включить: ' + (e.name || '') + ' ' + (e.message || e.status || 'ошибка');
        toast(msg);
        await refreshPushUI();
        $('push-hint').textContent = msg; // тост исчезает — оставляем причину на экране
        return;
    }
    refreshPushUI();
}

async function disablePush() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => { });
            await sub.unsubscribe();
        }
        toast('Уведомления выключены');
    } catch (e) { }
    refreshPushUI();
}

async function saveUserSettings() {
    const p = state.profile;
    if (!p?.registered || !state.userId) return;
    p.show_timer = $('timer-toggle').checked ? 1 : 0;
    p.timer_start_mode = parseInt($('timer-mode-select').value);
    p.show_session = $('session-toggle').checked ? 1 : 0;
    await kvSet('profile', p);
    updateTabsVisibility();
    if (!navigator.onLine) { toast('Сохранится при подключении'); return; }
    try {
        await api('POST', '/api/update_settings', {
            user_id: state.userId,
            show_timer: p.show_timer,
            timer_start_mode: p.timer_start_mode,
            show_intra_break: p.show_intra_break ?? 0,
            show_session: p.show_session,
        });
    } catch (e) { toast('Ошибка сохранения'); }
}

async function setMode(mode) {
    if (!state.userId) return;
    state.profile.mode = mode;
    await kvSet('profile', state.profile);
    renderMore();
    try {
        await api('POST', '/api/update_mode', { user_id: state.userId, mode });
        await refreshAll(); // расписание приходит уже с учётом режима
        toast('Режим: ' + mode);
    } catch (e) { toast('Нет сети — режим применится позже'); }
}

// ─── Регистрация ──────────────────────────────────────────────────────────────
let regSubgroup = null;

async function openRegModal() {
    if (!state.meta) {
        try { state.meta = await api('GET', '/api/meta'); await kvSet('meta', state.meta); }
        catch (e) { toast('Нужен интернет для настройки профиля'); return; }
    }
    const cSel = $('reg-course');
    cSel.innerHTML = '<option value="">Выбери курс</option>';
    Object.keys(state.meta).forEach((c) => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        cSel.appendChild(o);
    });
    const p = state.profile;
    if (p?.registered) {
        cSel.value = p.course;
        fillRegGroups(p.course, p.group);
        loadRegSubgroups(p.course, p.group, p.subgroup);
    } else {
        $('reg-group').innerHTML = '<option value="">Выбери группу</option>';
        $('reg-group').disabled = true;
        $('reg-subgroups').innerHTML = '';
    }
    openModal('reg-modal');
}

function fillRegGroups(course, selected) {
    const gSel = $('reg-group');
    gSel.innerHTML = '<option value="">Выбери группу</option>';
    (state.meta[course] || []).forEach((g) => {
        const o = document.createElement('option');
        o.value = g; o.textContent = g;
        gSel.appendChild(o);
    });
    gSel.disabled = false;
    if (selected) gSel.value = selected;
}

async function loadRegSubgroups(course, group, selected) {
    const box = $('reg-subgroups');
    box.innerHTML = '<span class="muted small">Загрузка…</span>';
    try {
        const subs = await api('GET', `/api/subgroups?course=${encodeURIComponent(course)}&group=${encodeURIComponent(group)}`);
        regSubgroup = selected && subs.includes(String(selected)) ? String(selected) : (subs[0] || '1');
        box.innerHTML = '';
        subs.forEach((sg) => {
            const b = document.createElement('button');
            b.className = 'seg-btn' + (String(sg) === regSubgroup ? ' active' : '');
            b.textContent = sg + ' подгруппа';
            b.addEventListener('click', () => {
                regSubgroup = String(sg);
                box.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
                b.classList.add('active');
            });
            box.appendChild(b);
        });
    } catch (e) { box.innerHTML = '<span class="muted small">Ошибка загрузки</span>'; }
}

async function saveRegistration() {
    const course = $('reg-course').value, group = $('reg-group').value;
    if (!course || !group || !regSubgroup) { toast('Заполни все поля'); return; }
    try {
        await api('POST', '/api/update_profile', { user_id: state.userId, course, group_num: group, subgroup: regSubgroup });
        dropMyTeachers();   // у новой группы другие преподаватели
        closeModals();
        toast('Профиль сохранён 🎓');
        await refreshAll();
    } catch (e) { toast('Ошибка сохранения'); }
}

// ─── Жалоба ───────────────────────────────────────────────────────────────────
async function sendReport() {
    const text = $('report-text').value.trim();
    if (!text) { toast('Опиши проблему'); return; }
    const name = state.tg?.initDataUnsafe?.user
        ? `${state.tg.initDataUnsafe.user.first_name || ''} ${state.tg.initDataUnsafe.user.last_name || ''}`.trim()
        : `PWA #${state.userId}`;
    try {
        await api('POST', '/api/report', { user_id: state.userId, user_name: name, text });
        $('report-text').value = '';
        closeModals();
        toast('Отправлено! Спасибо 🙏');
    } catch (e) { toast('Ошибка отправки'); }
}

// ─── Админ-панель ─────────────────────────────────────────────────────────────
async function loadAdmin() {
    if (!state.isAdmin) return;
    try {
        const d = await api('GET', '/api/admin/overview');
        state.adminData = d;
        $('admin-stats').innerHTML = `
            <div class="stat-tile"><b>${d.stats.total}</b><span>всего пользователей</span></div>
            <div class="stat-tile"><b>${d.stats.daily}</b><span>активны сегодня</span></div>
            <div class="stat-tile"><b>${d.push_subs}</b><span>push-подписок</span></div>
            <div class="stat-tile"><b>${d.new_reports ?? 0}</b><span>новых жалоб</span></div>`;
        $('admin-week-label').textContent = 'Сейчас: ' + weekName(d.week_type);
        $('admin-vacation-toggle').checked = !!d.vacation_mode;
        document.querySelectorAll('#admin-session-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.sess === d.session_mode));
        $('admin-sess-year').textContent = d.session_year;
        $('admin-offset').textContent = d.timezone_offset;
        $('admin-shift').textContent = d.time_shift_days;
        const botT = new Date(d.server_time * 1000);
        $('admin-bot-time').textContent = `Время бота: ${pad2(botT.getUTCDate())}.${pad2(botT.getUTCMonth() + 1)}.${botT.getUTCFullYear()} ${pad2(botT.getUTCHours())}:${pad2(botT.getUTCMinutes())}`;
        $('admin-monitoring').innerHTML =
            `Перезапуск бота: <b>${esc(d.monitoring.last_restart)}</b><br>` +
            `URL обновлён: <b>${esc(d.monitoring.url_update_date)}</b><br>` +
            `URL: ${esc(d.monitoring.current_url)}<br>` +
            `Смена недели: <b>${esc(d.week_toggle.date)}</b>`;
        const reps = await api('GET', '/api/admin/reports?limit=30');
        state.adminReports = reps.reports;
        $('admin-reports').innerHTML = reps.reports.length
            ? reps.reports.map(renderReportItem).join('')
            : '<p class="muted small">Жалоб нет</p>';
        document.querySelectorAll('[data-reply]').forEach((b) =>
            b.addEventListener('click', () => openReplyModal(parseInt(b.dataset.reply))));
        document.querySelectorAll('[data-close-rep]').forEach((b) =>
            b.addEventListener('click', async () => {
                const r = await adminPost('/api/admin/reports/close', { report_id: parseInt(b.dataset.closeRep) });
                if (r) toast('Жалоба закрыта');
            }));
    } catch (e) {
        toast(e.status === 403 ? 'Нет прав администратора' : 'Ошибка загрузки админки');
    }
}

function renderReportItem(r) {
    const st = r.status || 'new';
    const badge = st === 'new' ? '<span class="rep-badge new">новая</span>'
        : st === 'answered' ? '<span class="rep-badge ok">отвечена</span>'
        : '<span class="rep-badge">закрыта</span>';
    return `<div class="report-item">
        <div class="rep-head"><span>#${r.id} · ${esc(r.user_name)} (${r.user_id})</span><span>${esc(r.timestamp)}</span></div>
        <div>${esc(r.text)}</div>
        ${r.answer ? `<div class="rep-answer">↳ ${esc(r.answer)}</div>` : ''}
        <div class="rep-actions">
            ${badge}
            <button class="small-btn" data-reply="${r.id}">Ответить</button>
            ${st === 'new' ? `<button class="small-btn" data-close-rep="${r.id}">Закрыть</button>` : ''}
        </div>
    </div>`;
}

let replyReportId = null;

function openReplyModal(reportId) {
    const r = (state.adminReports || []).find((x) => x.id === reportId);
    if (!r) return;
    replyReportId = reportId;
    $('reply-modal-title').textContent = `Ответ на жалобу #${reportId}`;
    $('reply-quote').textContent = `${r.user_name}: ${r.text}`;
    $('reply-text').value = '';
    openModal('reply-modal');
}

async function adminPost(path, body) {
    try {
        const r = await api('POST', path, body);
        await loadAdmin();
        return r;
    } catch (e) {
        toast('Ошибка: ' + (e.status || 'сеть'));
        return null;
    }
}

function promptModal(title, initial, cb) {
    $('prompt-title').textContent = title;
    $('prompt-input').value = initial || '';
    openModal('prompt-modal');
    $('prompt-ok-btn').onclick = () => {
        const v = $('prompt-input').value.trim();
        closeModals();
        cb(v);
    };
}

// ─── Онбординг-тур ────────────────────────────────────────────────────────────
const TOUR_STEPS = [
    { view: null, title: 'Добро пожаловать! 👋', text: 'Это приложение-расписание ФКН ВГУ: пары, календарь с заметками, экзамены и уведомления. Всё работает даже без интернета. Показать быстрый тур по приложению?', next: 'Показать', skip: 'Не нужно' },
    { view: 'schedule', title: '📅 Пары', text: 'Расписание по дням недели. Кнопка справа сверху переключает числитель/знаменатель: если вокруг списка фиолетовый пунктир — ты смотришь не текущую неделю. Здесь же живёт таймер до начала и конца пары.' },
    { view: 'calendar', title: '🗓 Календарь', text: 'Точки под числами: синяя — пары, оранжевая — заметки, красная — экзамен. Тапни день, чтобы увидеть подробности, и жми «+ Заметка» — заметке можно поставить напоминание, оно придёт уведомлением.' },
    { view: 'exams', title: '🎓 Сессия', text: 'Все экзамены твоей группы с отсчётом до ближайшего. Вкладка видна, только когда идёт сессия.', skipIf: () => $('tab-exams').classList.contains('hidden') },
    { view: 'search', title: '🔍 Поиск', text: 'Список твоих преподавателей и всех на факультете — с кафедрой, должностью и расписанием. Рядом — поиск свободных аудиторий.' },
    { view: 'more', title: '⚙️ Ещё', text: 'Профиль, режимы отображения, установка приложения на iPhone и Android, уведомления и сводка расписания: всё настраивается здесь.', next: 'Готово' },
];
let tourIdx = -1;

function maybeOfferTour() {
    if (localStorage.getItem('tour_done')) return;
    tourIdx = 0;
    showTourStep();
}

function showTourStep() {
    const step = TOUR_STEPS[tourIdx];
    if (!step) { endTour(); return; }
    if (step.skipIf && step.skipIf()) { tourIdx++; showTourStep(); return; }
    if (step.view) switchView(step.view);
    $('tour-title').textContent = step.title;
    $('tour-text').textContent = step.text;
    $('tour-next').textContent = step.next || (tourIdx === TOUR_STEPS.length - 1 ? 'Готово' : 'Далее');
    $('tour-skip').textContent = step.skip || 'Пропустить';
    $('tour-progress').innerHTML = TOUR_STEPS.map((s, i) => `<i class="${i <= tourIdx ? 'on' : ''}"></i>`).join('');
    $('tour-card').classList.remove('hidden');
}

function endTour() {
    localStorage.setItem('tour_done', '1');
    $('tour-card').classList.add('hidden');
    if (tourIdx > 0) switchView('schedule');
    tourIdx = -1;
}

// ─── Service Worker ───────────────────────────────────────────────────────────
function registerSW() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js?v=' + APP_VERSION).catch((e) => console.warn('SW:', e));
    }
}

// ─── Высота приложения ────────────────────────────────────────────────────────
// В standalone-PWA на iOS ВСЕ viewport-метрики (vh/dvh/innerHeight/visualViewport)
// занижены на статус-бар + полоску Home, хотя webview рисует весь экран.
// Поэтому в установленном приложении берём высоту экрана целиком (screen.*,
// у iOS эти значения не зависят от поворота), в браузере — visualViewport.
function fitViewport() {
    let h;
    if (window.navigator.standalone === true) {
        const portrait = !window.matchMedia || window.matchMedia('(orientation: portrait)').matches;
        h = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    } else {
        h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    }
    document.documentElement.style.setProperty('--app-h', h + 'px');
}

// ─── События ──────────────────────────────────────────────────────────────────
function bindEvents() {
    // Вкладки
    document.querySelectorAll('#tabbar .tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

    // Вход
    on('login-btn', 'click', startLogin);
    on('login-cancel', 'click', cancelLogin);

    // Неделя
    on('week-badge', 'click', () => {
        // В воскресенье базовая неделя уже следующая — показываем прошедшую,
        // в остальные дни — следующую
        const backwards = botDayIdx(botNow()) === 6;
        state.weekOffset = state.weekOffset === 0 ? (backwards ? -1 : 1) : 0;
        renderHeader();
        renderDaysNav();
        renderSchedule();
        haptic();
    });

    // Календарь
    on('cal-prev', 'click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); });
    on('cal-next', 'click', () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); });
    on('add-note-btn', 'click', () => openNoteModal(null));

    // Заметки
    on('note-save-btn', 'click', saveNote);
    on('note-delete-btn', 'click', deleteNote);
    on('note-remind', 'change', updateRemindHint);
    on('note-date', 'change', updateRemindHint);
    on('note-time', 'change', updateRemindHint);

    // Приоритет в редакторе заметки
    document.querySelectorAll('#note-priority-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
        setPrioUI('note-priority-seg', +b.dataset.prio);
    }));

    // Клик по паре → предложение создать заметку
    $('schedule-list').addEventListener('click', (e) => {
        const card = e.target.closest('.lesson-card.clickable');
        if (!card) return;
        openLessonNoteModal(card.dataset.lessonDate, card.dataset.lessonText, card.dataset.lessonTime);
    });
    on('lesson-note-ok', 'click', confirmLessonNote);
    on('lesson-note-today', 'click', () => {
        const d = $('lesson-note-modal').dataset.clickDate;
        if (d) $('lesson-note-date').value = d;
    });
    on('lesson-note-next', 'click', () => {
        const d = $('lesson-note-modal').dataset.nextDate;
        if (d) $('lesson-note-date').value = d;
    });
    on('lesson-note-date', 'change', () => { });
    document.querySelectorAll('#lesson-note-prio .seg-btn').forEach((b) => b.addEventListener('click', () => {
        setPrioUI('lesson-note-prio', +b.dataset.prio);
    }));

    // Календарь: клик по предмету в день-панели → заметка
    $('day-panel-content').addEventListener('click', (e) => {
        const card = e.target.closest('.mini-lesson.clickable');
        if (!card) return;
        openLessonNoteModal(card.dataset.lessonDate, card.dataset.lessonText, card.dataset.lessonTime);
    });

    // Вкладка «Задачи»
    document.querySelectorAll('#tasks-filter-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
        state.tasksFilter = b.dataset.tf;
        localStorage.setItem('tasksFilter', state.tasksFilter);
        renderTasks();
    }));
    document.querySelectorAll('#tasks-prio-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
        state.tasksPrio = +b.dataset.tp;
        localStorage.setItem('tasksPrio', state.tasksPrio);
        renderTasks();
    }));
    document.querySelectorAll('#tasks-done-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
        state.tasksDone = b.dataset.td;
        localStorage.setItem('tasksDone', state.tasksDone);
        renderTasks();
    }));
    on('tasks-search', 'input', (e) => { state.tasksSearch = e.target.value.trim(); renderTasks(); });
    on('tasks-add-btn', 'click', () => { state.prefill = null; openNoteModal(null); });
    on('modal-backdrop', 'click', closeModals);
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));

    // Поиск
    document.querySelectorAll('#search-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#search-seg .seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        $('search-teacher-form').classList.toggle('hidden', b.dataset.seg !== 'teacher');
        $('search-rooms-form').classList.toggle('hidden', b.dataset.seg !== 'rooms');
        $('search-results').innerHTML = '';
        if (b.dataset.seg === 'teacher') showTeachersTab();
    }));
    document.querySelectorAll('#teachers-scope .seg-btn').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#teachers-scope .seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        teachers.scope = b.dataset.scope;
        teachers.openKey = null;
        showTeachersTab();
    }));
    on('teacher-input', 'input', (e) => { teachers.filter = e.target.value.trim(); renderTeachers(); });
    // Делегирование: карточки перерисовываются целиком, слушатели на них не живут
    $('teachers-list').addEventListener('click', (e) => {
        const card = e.target.closest('.teacher-item');
        if (!card) return;
        if (e.target.closest('a')) return;
        const key = card.dataset.key;
        if (e.target.closest('[data-act="schedule"]')) {
            loadTeacherSchedule(key, card.querySelector('.teacher-schedule'));
            return;
        }
        teachers.openKey = teachers.openKey === key ? null : key;
        renderTeachers();
    });
    on('rooms-search-btn', 'click', doRoomsSearch);

    // Ещё
    on('edit-profile-btn', 'click', () => openRegModal());
    document.querySelectorAll('#mode-seg .seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    on('timer-toggle', 'change', saveUserSettings);
    on('timer-mode-select', 'change', saveUserSettings);
    on('session-toggle', 'change', saveUserSettings);
    on('push-toggle', 'change', (e) => e.target.checked ? enablePush() : disablePush());
    document.querySelectorAll('#notify-seg .seg-btn').forEach((b) => b.addEventListener('click', async () => {
        if (state.profile) state.profile.notify_channel = b.dataset.nc;
        await kvSet('profile', state.profile);
        renderMore();
        try { await api('POST', '/api/notify_channel', { value: b.dataset.nc }); toast('Сохранено'); }
        catch (e) { toast('Нет сети — попробуй ещё раз'); }
    }));
    on('push-test-btn', 'click', async () => {
        try {
            const r = await api('POST', '/api/push/test');
            const parts = [];
            if (r.channel !== 'tg') parts.push(r.sent > 0 ? 'push ✅' : 'push ❌ (нет подписки)');
            if (r.channel !== 'push') parts.push(r.tg ? 'бот ✅' : 'бот ❌');
            toast('Отправлено: ' + parts.join(' · '));
        } catch (e) { toast('Ошибка отправки'); }
    });
    on('open-safari-btn', 'click', () => {
        // openLink открывает внешний браузер (Safari на iOS) — оттуда можно ставить на экран «Домой»
        if (state.tg?.openLink) state.tg.openLink(location.origin);
        else window.open(location.origin, '_blank');
    });
    // Цвета типов пар
    on('colors-toggle', 'change', (e) => saveColorsEnabled(e.target.checked));
    on('colors-reset', 'click', resetKindColors);

    // Сводка
    on('summary-toggle', 'change', (e) => saveSummary({ summary_enabled: e.target.checked ? 1 : 0 }));
    document.querySelectorAll('#summary-mode-seg .seg-btn').forEach((b) =>
        b.addEventListener('click', () => saveSummary({ summary_mode: b.dataset.sm })));
    on('summary-time', 'change', (e) => saveSummary({ summary_time: e.target.value || '20:00' }));
    on('summary-before', 'change', (e) => saveSummary({ summary_before: parseInt(e.target.value) }));

    on('get-apk-btn', 'click', async (e) => {
        e.target.disabled = true;
        try {
            await api('POST', '/api/send_apk');
            toast('Файл отправлен в чат с ботом 📦');
        } catch (err) {
            toast('Не получилось — попробуй позже');
        }
        e.target.disabled = false;
    });
    on('push-diag-btn', 'click', async () => {
        const box = $('push-diag');
        box.textContent = await pushDiagnostics();
        box.classList.remove('hidden');
        $('sw-reset-btn').classList.remove('hidden');
    });
    on('sw-reset-btn', 'click', () => {
        if (confirm('Переустановить service worker? Приложение перезагрузится, данные не потеряются.')) resetServiceWorker();
    });
    on('report-btn', 'click', () => openModal('report-modal'));
    on('report-send-btn', 'click', sendReport);
    on('open-admin-btn', 'click', () => switchView('admin'));
    on('logout-btn', 'click', () => { if (confirm('Выйти из аккаунта?')) logout(); });

    // Регистрация
    on('reg-course', 'change', (e) => {
        if (e.target.value) fillRegGroups(e.target.value);
        $('reg-subgroups').innerHTML = '';
    });
    on('reg-group', 'change', (e) => {
        if (e.target.value) loadRegSubgroups($('reg-course').value, e.target.value);
    });
    on('reg-save-btn', 'click', saveRegistration);

    // Админ
    on('reply-send-btn', 'click', async () => {
        const text = $('reply-text').value.trim();
        if (!text) { toast('Введи текст ответа'); return; }
        const r = await adminPost('/api/admin/reports/reply', { report_id: replyReportId, text });
        if (r) {
            closeModals();
            toast('Ответ отправлен пользователю ✅');
        }
    });
    on('admin-back', 'click', () => switchView('more'));
    on('admin-toggle-week', 'click', async () => { await adminPost('/api/admin/toggle_week'); refreshAll(); });
    on('admin-vacation-toggle', 'change', async (e) => {
        await adminPost('/api/admin/vacation', { value: e.target.checked ? 1 : 0 });
        refreshAll();
        toast(e.target.checked ? 'Каникулы включены 🏖' : 'Каникулы выключены');
    });
    on('admin-update-data', 'click', async () => {
        toast('Обновляю данные…');
        const r = await adminPost('/api/admin/update_data');
        if (r) toast(r.status === 'ok' ? 'Данные обновлены ✅' : 'Ошибка обновления');
        refreshAll();
    });
    document.querySelectorAll('#admin-session-seg .seg-btn').forEach((b) => b.addEventListener('click', async () => {
        await adminPost('/api/admin/session_mode', { value: b.dataset.sess });
        refreshAll();
    }));
    on('admin-sess-year-btn', 'click', () => {
        promptModal('Год сессии', state.adminData?.session_year || '2025/2026', async (v) => {
            if (v) await adminPost('/api/admin/session_year', { value: v });
        });
    });
    document.querySelectorAll('.stepper button').forEach((b) => b.addEventListener('click', async () => {
        const [what, delta] = b.dataset.step.split(':');
        const d = state.adminData;
        if (!d) return;
        if (what === 'offset') await adminPost('/api/admin/timezone', { value: d.timezone_offset + (+delta) });
        else await adminPost('/api/admin/time_shift', { value: +delta === 0 ? 0 : d.time_shift_days + (+delta) });
        refreshAll();
    }));
    on('broadcast-btn', 'click', async () => {
        const text = $('broadcast-text').value.trim();
        if (!text) { toast('Введи текст'); return; }
        if (!confirm('Отправить рассылку всем пользователям?')) return;
        toast('Рассылаю…');
        const r = await adminPost('/api/admin/broadcast', { text, via_tg: $('bc-tg').checked, via_push: $('bc-push').checked });
        if (r) {
            $('broadcast-text').value = '';
            toast(`TG: ${r.sent_tg} ✅ / ${r.failed_tg} ❌ · Push: ${r.sent_push}`);
        }
    });

    // Тур
    on('tour-next', 'click', () => {
        tourIdx++;
        if (tourIdx >= TOUR_STEPS.length) endTour();
        else showTourStep();
    });
    on('tour-skip', 'click', endTour);

    // Сеть
    window.addEventListener('online', () => { setOffline(false); refreshAll(); });
    window.addEventListener('offline', () => setOffline(true));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        // Вернулись из Telegram во время входа — проверяем код сразу, не ждём таймер
        if (state.loginPoll) state.loginPoll();
        refreshAll();
    });
}

// ─── Защита от «вечной заставки» ──────────────────────────────────────────────
let splashGuard = null;

function armSplashGuard() {
    // Если за 12 секунд приложение не запустилось, показываем экран восстановления,
    // а не бесконечную иконку (симптом: приложение «перестало открываться»).
    splashGuard = setTimeout(() => showStartupError('Приложение не смогло запуститься за 12 секунд'), 12000);
}

function disarmSplashGuard() {
    clearTimeout(splashGuard);
    splashGuard = null;
}

function showStartupError(reason) {
    disarmSplashGuard();
    const splash = $('splash');
    if (!splash || splash.classList.contains('hidden')) return;
    splash.innerHTML = `
        <img src="icons/icon-192.png" alt="" class="splash-icon">
        <div class="startup-error">
            <h2>Не удалось запустить приложение</h2>
            <p>${esc(reason || 'Неизвестная ошибка')}</p>
            <button id="startup-retry" class="primary-btn">Попробовать снова</button>
            <button id="startup-reset" class="secondary-btn mt8">Сбросить данные приложения</button>
            <p class="muted small">Сброс удалит только сохранённые на устройстве данные (расписание закачается заново). Заметки, которые успели синхронизироваться, останутся.</p>
        </div>`;
    const retry = document.getElementById('startup-retry');
    const reset = document.getElementById('startup-reset');
    if (retry) retry.addEventListener('click', () => location.reload());
    if (reset) reset.addEventListener('click', hardReset);
}

async function hardReset() {
    try { localStorage.clear(); } catch (e) { }
    try {
        if (window.indexedDB) indexedDB.deleteDatabase('vsu-pwa');
    } catch (e) { }
    try {
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
    } catch (e) { }
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister();
        }
    } catch (e) { }
    setTimeout(() => location.reload(), 800);
}

// ─── Персональные расширения: разбор пары, задачи, создание из пары ──────────
function formatDateShort(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS_GEN[m - 1]}`;
}

// Разбор текста пары на предмет/аудиторию/преподавателя.
// Проверено на живых данных: формат "<Предмет> <должность> <Фамилия> <И.О.> <аудитория>",
// аудитория — число в конце (иногда с суффиксом П), дистант = "(ДО)" без аудитории.
const _POS_RE = /(?:доц\.?|асс\.?|ст\.преп\.?|преп\.?|проф\.?|зав\.каф\.?|старший преподаватель|ассистент|доцент|преподаватель|профессор)/i;
function parseLessonParts(text) {
    const parts = { subject: '', room: '', teacher: '', position: '', kind: '', remote: false };
    const t = String(text || '').trim();
    parts.remote = /\(ДО\)/i.test(t);
    const room = t.match(/(\d{3,4}[А-Я]?)\s*$/) || t.match(/\((\d{3,4}[А-Я]?)\)/);
    if (room) parts.room = room[1];
    const teach = t.match(/([А-ЯЁ][а-яё]+(?:\-[А-ЯЁ][а-яё]+)?)\s+([А-ЯЁ]\.)\s*([А-ЯЁ]\.)?/);
    if (teach) parts.teacher = (teach[1] + ' ' + teach[2] + (teach[3] || '')).trim();
    let pm = t.match(_POS_RE);
    if (pm) parts.position = pm[0];
    let s = t.replace(/\d{3,4}[А-Я]?\s*$/, ' ');
    if (parts.teacher) s = s.replace(parts.teacher, ' ');
    if (parts.position) s = s.replace(new RegExp(parts.position.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    s = s.replace(/\(ДО\)/gi, ' ').replace(/\s+/g, ' ').trim();
    parts.subject = s;
    const r = parseInt(parts.room);
    if (parts.remote) parts.kind = 'дистанционно';
    else if (r >= 400) parts.kind = 'лекция';
    else if (r >= 200 && r < 400) parts.kind = 'практика';
    else if (r && r < 200) parts.kind = 'семинар/лаб';
    else parts.kind = '';
    return parts;
}

function lessonIdentity(parts) {
    return ((parts.subject || '').toLowerCase().trim()) + '|' + ((parts.teacher || '').toLowerCase().trim());
}

// Ближайшая следующая такая же пара (одинаковые название+препод = одна и та же
// пара, даже если кабинет другой). Сканируем до 120 дней вперёд.
function nextSameLessonDate(lessonText) {
    const targetKey = lessonIdentity(parseLessonParts(lessonText));
    for (let i = 1; i <= 120; i++) {
        const d = new Date(); d.setDate(d.getDate() + i);
        const iso = isoFromLocalParts(d);
        const wd = (d.getDay() + 6) % 7;
        if (wd === 6) continue;
        const wt = weekTypeForDate(iso);
        const sched = state.schedules[wt];
        if (!sched) continue;
        const hit = (sched[DAYS_FULL[wd]] || [])
            .map(parseLesson).filter((l) => !l.empty)
            .map((l) => ({ ...l, parts: parseLessonParts(l.text) }))
            .find((l) => lessonIdentity(l.parts) === targetKey);
        if (hit) return { iso, parts: hit.parts, time: hit.start };
    }
    return null;
}

function openLessonNoteModal(lessonDateIso, lessonText, lessonTime) {
    state.lessonClickDate = lessonDateIso || null;
    const parts = parseLessonParts(lessonText);
    const nxt = nextSameLessonDate(lessonText);
    const date = lessonDateIso; // изначальная дата по предмету (день клика)
    const prio = nxt && nxt.parts.kind ? (nxt.parts.kind === 'лекция' ? 3 : 2) : 2;

    $('lesson-note-preview').innerHTML =
        `<div class="note-title">${esc(parts.subject || lessonText)}</div>` +
        `<div class="note-meta">${esc(lessonTime)}${parts.room ? ' · ауд. ' + esc(parts.room) : ''}${parts.teacher ? ' · ' + esc(parts.teacher) : ''}${parts.kind ? ' · ' + esc(parts.kind) : ''}</div>` +
        (nxt ? `<p class="muted small mt8">Ближайшая такая же пара: <b>${esc(formatDateShort(nxt.iso))}</b>${nxt.parts.room ? ' · ауд. ' + esc(nxt.parts.room) : ''}</p>` : '');

    $('lesson-note-date').value = date;
    const m = $('lesson-note-modal');
    m.dataset.clickDate = lessonDateIso || '';
    m.dataset.nextDate = (nxt && nxt.iso) || '';
    $('lesson-note-today').textContent = lessonDateIso ? 'На день клика (' + formatDateShort(lessonDateIso) + ')' : 'На день клика';
    $('lesson-note-next').textContent = nxt ? 'На следующую пару (' + formatDateShort(nxt.iso) + ')' : 'На следующую пару';
    setPrioUI('lesson-note-prio', prio);
    m.dataset.prefillTitle = parts.subject || lessonText;
    m.dataset.prefillBody = '';
    m.dataset.prefillTime = lessonTime || '';
    openModal('lesson-note-modal');
}

function confirmLessonNote() {
    const date = $('lesson-note-date').value;
    if (!date) { toast('Укажи дату'); return; }
    const m = $('lesson-note-modal');
    state.prefill = {
        title: m.dataset.prefillTitle || '',
        body: m.dataset.prefillBody || '',
        date,
        time: m.dataset.prefillTime || '',
        prio: state.notePrio,
    };
    closeModals();
    openNoteModal(null);
}

// ─── Вкладка «Задачи» ────────────────────────────────────────────────────────
function prioOf(note) { return prioFromTitle(note.title); }

async function toggleDone(client_id) {
    const idx = state.notes.findIndex((x) => x.client_id === client_id);
    if (idx < 0) return;
    const n = state.notes[idx];
    const done = !doneFromTitle(n.title);
    const updated = { ...n, title: composeTitle(n.title, prioFromTitle(n.title), done), updated_at: Date.now(), dirty: true };
    state.notes[idx] = updated;
    await notePut(updated);
    renderTasks();
    renderCalendar();
    renderDayTasks();
    syncNotes().then(renderCalendar);
}

function renderTasks() {
    const box = $('tasks-list');
    if (!box) return;
    const p = state.profile;
    if (!p || !p.registered) {
        box.innerHTML = '<p class="muted center" style="padding:16px">Сначала укажи курс и группу в профиле</p>';
        return;
    }
    document.querySelectorAll('#tasks-filter-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tf === state.tasksFilter));
    document.querySelectorAll('#tasks-prio-seg .seg-btn').forEach((b) => b.classList.toggle('active', +b.dataset.tp === state.tasksPrio));
    document.querySelectorAll('#tasks-done-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.td === state.tasksDone));
    const todayIso = isoFromLocalParts(new Date());
    const mondayD = mondayOfIso(todayIso);
    const weekMon = isoFromLocalParts(mondayD);
    const weekSunD = new Date(mondayD); weekSunD.setUTCDate(weekSunD.getUTCDate() + 6);
    const weekSun = isoFromUTCParts(weekSunD);
    let list = state.notes.filter((n) => !n.deleted);
    if (state.tasksFilter === 'today') list = list.filter((n) => n.date === todayIso);
    else if (state.tasksFilter === 'week') list = list.filter((n) => n.date && n.date >= weekMon && n.date <= weekSun);
    if (state.tasksPrio) list = list.filter((n) => prioOf(n) === state.tasksPrio);
    if (state.tasksDone === 'done') list = list.filter((n) => doneFromTitle(n.title));
    else if (state.tasksDone === 'undone') list = list.filter((n) => !doneFromTitle(n.title));
    const q = state.tasksSearch.toLowerCase();
    if (q) list = list.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (prioOf(b) - prioOf(a)) || (a.time || '99').localeCompare(b.time || '99'));
    if (!list.length) {
        box.innerHTML = '<p class="muted center" style="padding:16px">Задач нет. Нажми «+ Задача» или тапни по паре в расписании.</p>';
        return;
    }
    box.innerHTML = list.map((n) => {
        const pr = prioOf(n);
        const done = doneFromTitle(n.title);
        const overdue = n.date && n.date < todayIso && !done;
        const inWeek = n.date >= weekMon && n.date <= weekSun;
        return `<div class="note-card task-card prio-${pr}${done ? ' done' : ''}" data-note="${esc(n.client_id)}">
            <button class="task-done${done ? ' is-done' : ''}" data-toggle-done="${esc(n.client_id)}" title="Отметить выполненным">${done ? '✅' : '☐'}</button>
            <div class="note-info">
                <div class="note-title">${esc(titleWithoutPrio(titleWithoutDone(n.title)) || 'Без названия')}</div>
                ${n.body ? `<div class="note-body">${esc(n.body)}</div>` : ''}
                <div class="note-meta">${n.date ? '📅 ' + esc(formatDateShort(n.date)) : ''} ${n.time ? '· ⏰ ' + esc(n.time) : ''}${inWeek ? ' · <span class="week-tag">эта неделя</span>' : ''}${overdue ? ' · <b class="overdue">просрочено</b>' : ''}${n.dirty ? ' · ожидает синх.' : ''}</div>
            </div>
        </div>`;
    }).join('');
    document.querySelectorAll('#tasks-list .task-card[data-note]').forEach((el) => {
        el.addEventListener('click', () => openNoteModal(state.notes.find((n) => n.client_id === el.dataset.note)));
    });
    document.querySelectorAll('#tasks-list [data-toggle-done]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDone(b.dataset.toggleDone);
    }));
}

// ─── Инициализация ────────────────────────────────────────────────────────────
async function init() {
    armSplashGuard();
    window.addEventListener('error', (e) => {
        if (splashGuard) showStartupError('Ошибка при запуске: ' + (e.message || 'неизвестно'));
    });
    fitViewport();
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
    window.addEventListener('resize', fitViewport);
    window.addEventListener('orientationchange', fitViewport);

    bindEvents();
    initSearchForms();
    registerSW();
    try { await idbOpen(); } catch (e) { console.warn('IDB:', e); }

    setInterval(() => { updateCountdown(); updateExamCountdown(); }, 1000);

    // Внутри Telegram Mini App — автовход по initData
    const tgApp = await waitTelegram(navigator.onLine ? 2000 : 300);
    if (tgApp?.initData) {
        state.tg = tgApp;
        try { tgApp.expand(); tgApp.ready(); } catch (e) { }
        try {
            const r = await api('POST', '/api/auth/telegram', { init_data: tgApp.initData });
            saveAuth(r);
        } catch (e) { /* оффлайн или ошибка — пробуем сохранённый токен */ }
    }

    if (!state.token) {
        disarmSplashGuard();
        $('splash').classList.add('hidden');
        $('login-screen').classList.remove('hidden');
        prepareLogin();
        return;
    }
    await enterApp();
}

init().catch((e) => {
    console.error('[START]', e);
    showStartupError((e && e.message) || 'Ошибка инициализации');
});
