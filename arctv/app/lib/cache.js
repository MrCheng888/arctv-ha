'use strict';
// Плейлисты и программа передач: скачивание у провайдеров по расписанию, хранение в памяти и на диске.
// С 0.6.1 у каждого плейлиста всё своё: копия плейлиста src-<id>.m3u, программа epg-<id>.txt.gz,
// описания desc-<id>.json.gz. До 0.6.0 файлы назывались playlist.m3u, epg.txt.gz, desc.json.gz — это плейлист № 1.
const zlib = require('zlib');
const store = require('./store');
const m3u = require('./m3u');
const epg = require('./epg');
const sources = require('./sources');

const C = {
  src: new Map(),          // id -> плейлист (см. blank)
  running: null,           // Promise текущего обновления
  stage: '',               // что сейчас делает обновление: playlist | epg | save
  got: 0, total: 0,        // скачано байт текущей программы и сколько всего (0 — неизвестно)
  epgIdx: 0, epgN: 1,      // какая программа по счёту скачивается и сколько их всего (по всем плейлистам)
  lastError: '', lastRun: 0, lastDurationMs: 0
};

function blank(id) {
  return {
    id, text: null, gz: null, parsed: null, at: 0, error: '',
    epg: new Map(), desc: new Map(), epgGz: null, epgAt: 0, epgCount: 0, epgChannels: 0, epgTotal: 0,
    epgSources: [], epgError: '', parts: new Map()
  };
}

function S(id) {
  id = +id;
  if (!C.src.has(id)) { C.src.set(id, blank(id)); }
  return C.src.get(id);
}

function log(...a) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  console.log(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), ...a);
}

function setText(x, text, at) {
  x.text = text;
  x.gz = zlib.gzipSync(text);
  x.parsed = m3u.parse(text);
  x.at = at;
}

function count(x) {
  let n = 0;
  for (const a of x.epg.values()) { n += a.length; }
  x.epgCount = n;
  x.epgChannels = x.epg.size;
  x.parts = new Map();
}

function saveMeta() {
  const src = {};
  for (const [id, x] of C.src) {
    src[id] = { at: x.at, epgAt: x.epgAt, epgTotal: x.epgTotal, epgSources: x.epgSources };
  }
  store.writeAtomic('meta.json', JSON.stringify({ src }));
}

// После перезапуска контейнера сразу отдаём то, что было скачано раньше
function restore() {
  const meta = store.readJson('meta.json', {}), ms = meta.src || {};
  for (const src of store.getSettings().SOURCES) {
    const id = src.id, x = S(id), m = ms[id] || {};
    // до 0.6.0 файлы без номера: это плейлист № 1
    const t = store.readText('src-' + id + '.m3u') || (id === 1 ? store.readText('playlist.m3u') : null);
    if (t) {
      try { setText(x, t, m.at || meta.playlistAt || 0); } catch (e) { log('Копия плейлиста', id, 'повреждена:', e.message); }
    }
    const eg = store.readBuf('epg-' + id + '.txt.gz') || (id === 1 ? store.readBuf('epg.txt.gz') : null);
    if (eg) {
      try {
        x.epg = epg.fromLines(zlib.gunzipSync(eg).toString('utf8'));
        x.epgGz = eg;
        x.epgAt = m.epgAt || meta.epgAt || 0;
        x.epgTotal = m.epgTotal || meta.epgTotal || 0;
        x.epgSources = m.epgSources || [];
        count(x);
      } catch (e) { log('Кэш программы', id, 'повреждён:', e.message); }
    }
    const dg = store.readBuf('desc-' + id + '.json.gz') || (id === 1 ? store.readBuf('desc.json.gz') : null);
    if (dg) {
      try { x.desc = new Map(Object.entries(JSON.parse(zlib.gunzipSync(dg).toString('utf8')))); } catch (e) { x.desc = new Map(); }
    }
    log('Из кэша: плейлист', src.name + ':', x.parsed ? x.parsed.channels.length + ' каналов' : 'нет',
      ', программа', x.epgCount ? x.epgCount + ' передач' : 'нет');
  }
}

// Адреса программы плейлиста: заданные на странице, иначе url-tvg плейлиста (у Xtream — его xmltv.php)
function epgUrls(src) {
  if (src.epg && src.epg.length) { return src.epg.slice(); }
  const x = C.src.get(src.id);
  return x && x.text ? sources.headerEpg(x.text) : [];
}

async function doRefresh() {
  const s = store.getSettings();
  const t0 = Date.now();
  const errors = [];
  const list = sources.enabled(s.SOURCES);
  if (!list.length) { throw new Error(s.SOURCES.length ? 'Все плейлисты выключены (страница настроек)' : 'Не задан ни один плейлист (страница настроек)'); }

  // 1. плейлисты
  C.stage = 'playlist'; C.got = 0; C.total = 0;
  for (const src of list) {
    const x = S(src.id);
    log('Скачиваю плейлист', src.name, '…');
    try {
      const text = await sources.download(src);
      if (!m3u.parse(text).channels.length) { throw new Error('в плейлисте нет каналов'); }
      setText(x, text, Date.now());
      x.error = '';
      store.writeAtomic('src-' + src.id + '.m3u', text);
      log('Плейлист', src.name + ':', x.parsed.channels.length, 'каналов');
    } catch (e) {
      x.error = e.message;
      errors.push('Плейлист ' + src.name + ': ' + e.message);
      log('Плейлист', src.name, 'не скачался:', e.message, x.text ? '(остаётся прежний)' : '');
    }
  }
  saveMeta();

  // 2. программа каждого плейлиста; канал берёт программу из первого источника, где она для него есть
  const jobs = list.map((src) => ({ src, x: S(src.id), urls: epgUrls(src) }));
  C.epgN = Math.max(1, jobs.reduce((n, j) => n + j.urls.length, 0));
  C.epgIdx = 0;
  C.stage = 'epg';
  for (const { src, x, urls } of jobs) {
    if (!x.parsed) { continue; }
    const targets = x.parsed.channels.filter((c) => c.tvgId).map((c) => ({ out: c.tvgId, orig: c.tvgId, name: c.name, rec: c.rec }));
    if (!urls.length) { x.epgError = 'нет адреса программы'; errors.push('Программа ' + src.name + ': нет адреса (url-tvg в плейлисте или адреса на странице)'); continue; }
    if (!targets.length) { x.epgError = 'у каналов нет tvg-id'; C.epgIdx += urls.length; continue; }
    const data = new Map(), desc = new Map(), stat = [];
    let total = 0;
    for (const url of urls) {
      const short = url.replace(/\?.*$/, '');
      const want = targets.filter((t) => !data.has(t.out));
      if (!want.length) { stat.push({ url: short, channels: 0, error: '', skipped: true }); C.epgIdx++; continue; }
      C.got = 0; C.total = 0;
      log('Скачиваю программу', src.name, short, '…');
      try {
        const r = await epg.load(url, want, {
          pastHours: s.EPG_PAST_HOURS, futureHours: s.EPG_FUTURE_HOURS, timeout: 180000,
          onProgress: (got, tot) => { C.got = got; C.total = tot; }
        });
        for (const [id, arr] of r.data) { if (!data.has(id)) { data.set(id, arr); if (r.desc.has(id)) { desc.set(id, r.desc.get(id)); } } }
        total += r.total;
        stat.push({ url: short, channels: r.data.size, byName: r.byName, error: '' });
        log('Программа', src.name, short + ':', r.data.size, 'каналов,', r.kept, 'передач', r.byName ? '(по названию ' + r.byName + ')' : '');
      } catch (e) {
        stat.push({ url: short, channels: 0, error: e.message });
        errors.push('Программа ' + src.name + ' ' + short + ': ' + e.message);
        log('Программа', src.name, short, 'не скачалась:', e.message);
      }
      C.epgIdx++;
    }
    C.stage = 'save';
    x.epgSources = stat;
    if (!data.size) {
      x.epgError = stat.some((y) => y.error) ? 'не скачалась' : 'нет передач для каналов плейлиста';
      if (!stat.some((y) => y.error)) { errors.push('Программа ' + src.name + ': нет передач для каналов плейлиста'); }
      log('Программа', src.name, 'не обновлена', x.epgCount ? '(остаётся прежняя)' : '');
    } else {
      x.epgError = '';
      x.epg = data;
      x.desc = desc;
      store.writeAtomic('desc-' + src.id + '.json.gz', zlib.gzipSync(JSON.stringify(Object.fromEntries(desc))));
      x.epgTotal = total;
      x.epgGz = zlib.gzipSync(epg.toLines(data));
      x.epgAt = Date.now();
      count(x);
      store.writeAtomic('epg-' + src.id + '.txt.gz', x.epgGz);
      log('Программа', src.name + ':', x.epgCount, 'передач,', x.epgChannels, 'каналов, сжато', Math.round(x.epgGz.length / 1024), 'КБ');
    }
    C.stage = 'epg';
    saveMeta();
  }
  C.lastDurationMs = Date.now() - t0;
  return errors;
}

// Обновление; если уже идёт — ждём то же самое
function refresh() {
  if (C.running) { return C.running; }
  C.running = doRefresh()
    .then((errors) => { C.lastError = errors.join('; '); })
    .catch((e) => { C.lastError = e.message; log('Ошибка обновления:', e.message); })
    .then(() => { C.lastRun = Date.now(); C.running = null; C.stage = ''; schedule(); });
  return C.running;
}

let timer = null;
let nextAt = 0;
// delayMs не задан — через REFRESH_HOURS
function schedule(delayMs) {
  if (timer) { clearTimeout(timer); }
  const h = store.getSettings().REFRESH_HOURS || 6;
  const d = delayMs === undefined ? h * 3600 * 1000 : Math.max(1000, delayMs);
  nextAt = Date.now() + d;
  timer = setTimeout(refresh, d);
}

// При запуске: если копии всех включённых плейлистов свежие, следующее обновление по расписанию, иначе сразу
function startup() {
  const list = sources.enabled(store.getSettings().SOURCES);
  if (!list.length) { log('Нет включённых плейлистов — откройте страницу настроек'); return; }
  const h = store.getSettings().REFRESH_HOURS || 6;
  let oldest = Infinity, ready = true;
  for (const src of list) {
    const x = C.src.get(src.id);
    if (!x || !x.gz || !x.epgGz) { ready = false; break; }
    oldest = Math.min(oldest, x.at || 0, x.epgAt || 0);
  }
  const left = oldest + h * 3600 * 1000 - Date.now();
  if (ready && left > 60000) {
    log('Кэш свежий, следующее обновление через', Math.round(left / 60000), 'мин');
    schedule(left);
  } else {
    refresh();
  }
}

// Часть программы плейлиста: skip — набор tvg-id; ext=false — все, кроме skip; ext=true — только они.
// now=true — от 4 часов назад (быстрый старт). Кэшируется до следующего обновления программы.
function epgPart(id, now, ids, ext) {
  const x = S(id);
  ids = ids || new Set();
  const key = (now ? 'now' : 'all') + '|' + (ext ? 'ext' : 'main') + '|' + x.epgAt + '|' + Array.from(ids).sort().join(','),
    hit = x.parts.get(key);
  if (hit && (!now || Date.now() - hit.at < 5 * 60 * 1000)) { return hit.gz; }
  const data = new Map();
  for (const [k, arr] of x.epg) { if (ids.has(k) === !!ext) { data.set(k, arr); } }
  const t = Math.floor(Date.now() / 1000);
  const gz = zlib.gzipSync(now ? epg.toLines(data, t - 4 * 3600, 0) : epg.toLines(data));
  if (x.parts.size > 8) { x.parts.clear(); }
  x.parts.set(key, { at: Date.now(), gz });
  return gz;
}

// Ход обновления для телевизора (кнопка 0): стадия и общий процент скачивания программы
function progress() {
  return {
    running: !!C.running, stage: C.running ? C.stage : '',
    pct: C.running && C.stage === 'epg' && C.total ? Math.min(100, Math.floor((C.epgIdx + Math.min(1, C.got / C.total)) * 100 / (C.epgN || 1))) : -1,
    kb: Math.round(C.got / 1024), error: C.running ? '' : C.lastError
  };
}

// Описание передачи: tvgId и её начало (UTC, секунды — как в программе, без сдвига телевизора)
function descOf(id, ch, s) {
  const x = C.src.get(+id), dd = x && x.desc.get(ch);
  return dd ? (dd[s] || '') : '';
}

// Состояние для страницы: общее и по каждому плейлисту
function status() {
  const s = store.getSettings();
  const pls = s.SOURCES.map((src) => {
    const x = C.src.get(src.id) || blank(src.id);
    return {
      id: src.id, name: src.name, on: src.on, type: src.type, at: x.at, error: x.error,
      channels: x.parsed ? x.parsed.channels.length : 0,
      withArchive: x.parsed ? x.parsed.channels.filter((c) => c.rec > 0).length : 0,
      groups: x.parsed ? new Set(x.parsed.channels.map((c) => c.group)).size : 0,
      epgAt: x.epgAt, epgCount: x.epgCount, epgChannels: x.epgChannels, epgKb: x.epgGz ? Math.round(x.epgGz.length / 1024) : 0,
      epgSources: x.epgSources, epgError: x.epgError,
      epgAuto: !(src.epg && src.epg.length),
      epgHeader: src.type === 'xtream' ? ['xmltv.php'] : (x.text ? sources.headerEpg(x.text).map((u) => u.replace(/\?.*$/, '')) : [])
    };
  });
  const on = pls.filter((p) => p.on);
  return {
    sources: pls,
    channels: on.reduce((n, p) => n + p.channels, 0), withArchive: on.reduce((n, p) => n + p.withArchive, 0),
    epgCount: on.reduce((n, p) => n + p.epgCount, 0), epgChannels: on.reduce((n, p) => n + p.epgChannels, 0),
    epgKb: on.reduce((n, p) => n + p.epgKb, 0),
    playlistAt: Math.max(0, ...on.map((p) => p.at)), epgAt: Math.max(0, ...on.map((p) => p.epgAt)),
    running: !!C.running, lastRun: C.lastRun, lastError: C.lastError, lastDurationMs: C.lastDurationMs,
    nextAt: C.running ? 0 : nextAt, refreshHours: s.REFRESH_HOURS
  };
}

// Плейлист удалён на странице: файлы и память
function forget(id) {
  C.src.delete(+id);
  for (const f of ['src-' + id + '.m3u', 'epg-' + id + '.txt.gz', 'desc-' + id + '.json.gz']) { store.remove(f); }
  if (+id === 1) { for (const f of ['playlist.m3u', 'epg.txt.gz', 'desc.json.gz']) { store.remove(f); } }
  saveMeta();
}

module.exports = { C, S, restore, refresh, schedule, startup, progress, epgPart, status, log, descOf, forget };
