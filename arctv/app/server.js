'use strict';
// ArcTV — домашний сервер для приложения «Наталкин Кинозал».
// Плейлист и программа передач с сервера, общее Избранное и сохранения, настройки телевизоров, страница настроек.
// Node.js 18+, без зависимостей.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');
const cache = require('./lib/cache');
const auth = require('./lib/auth');
const m3u = require('./lib/m3u');
const sources = require('./lib/sources');
const epg = require('./lib/epg');
const holidays = require('./lib/holidays');
const door = require('./lib/door');
const cams = require('./lib/cams');

const VERSION = require('./package.json').version;
const PORT = parseInt(process.env.PORT || '8090', 10);
const PAGE = path.join(__dirname, 'public', 'index.html');

function ip(req) { return (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }

// Номер телевизора (DUID или свой случайный) — по нему у каждого телевизора свои настройки
function devId(req, q) { return String(q.get('dev') || '').replace(/[^\w.\-]/g, '').slice(0, 80) || 'ip-' + ip(req); }

function seen(req, q) {
  const dev = devId(req, q);
  store.seenDevice(dev, { ip: ip(req), model: (q.get('model') || '').slice(0, 60), ver: (q.get('v') || '').slice(0, 20) });
  return dev;
}

function send(res, code, body, type, extra) {
  const headers = Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-ArcTV-Updated'
  }, extra || {});
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); }
  res.writeHead(code, headers);
  res.end(body);
}

// Отдаёт заранее сжатое; если клиент gzip не понимает — распаковывает
function sendGz(req, res, gz, type, extra) {
  if (/gzip/.test(req.headers['accept-encoding'] || '')) {
    send(res, 200, gz, type, Object.assign({ 'Content-Encoding': 'gzip' }, extra));
  } else {
    send(res, 200, zlib.gunzipSync(gz), type, extra);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      if (!t) { resolve({}); return; }
      try { resolve(JSON.parse(t)); } catch (e) { reject(new Error('Неверный JSON')); }
    });
    req.on('error', reject);
  });
}

// ----- вход на страницу настроек -----
function cookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}
const SID = 'arctv_sid';
function sessionCookie(token, hours) {
  return SID + '=' + (token || '') + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (token ? hours * 3600 : 0);
}

// Страница внутри Home Assistant (Ingress, 0.7.7): запрос приходит от прокси Supervisor (172.30.32.2)
// с заголовком X-Ingress-Path — пользователь уже вошёл в HA, свой пароль не спрашиваем.
// По прямому адресу (порт 18090) — вход по логину и паролю, как раньше.
const INGRESS_IP = process.env.INGRESS_IP || '172.30.32.2';   // адрес прокси Supervisor (меняется только для проверки)
function isIngress(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return ip === INGRESS_IP && !!req.headers['x-ingress-path'];
}

// Пока логин и пароль не созданы, страница открыта (первый запуск) и предлагает их создать
function authorized(req) { return isIngress(req) || !auth.hasAccount() || auth.validSession(cookie(req, SID)); }

function needAuth(res) { send(res, 401, { error: 'Нужно войти', login: true }); }

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, q = u.searchParams, m = req.method;

  if (m === 'OPTIONS') { send(res, 204, ''); return; }

  // ----- страница настроек -----
  // страница отдаётся всегда: без входа она сама показывает форму входа
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    return;
  }

  if (m === 'GET' && p === '/api/session') {
    send(res, 200, { account: auth.hasAccount(), logged: authorized(req) && auth.hasAccount(), user: authorized(req) ? auth.user() : '', version: VERSION, ingress: isIngress(req) });
    return;
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readBody(req);
    if (!auth.check(b.user || '', b.pass || '')) {
      await new Promise((r) => setTimeout(r, 800));        // от подбора пароля
      send(res, 403, { error: 'Неверный логин или пароль' });
      return;
    }
    send(res, 200, { ok: true }, null, { 'Set-Cookie': sessionCookie(auth.newSession(), auth.SESSION_HOURS) });
    return;
  }

  if (m === 'POST' && p === '/api/logout') {
    auth.dropSession(cookie(req, SID));
    send(res, 200, { ok: true }, null, { 'Set-Cookie': sessionCookie('', 0) });
    return;
  }

  // Создать или сменить логин и пароль (при смене — нужен вход)
  if (m === 'POST' && p === '/api/account') {
    if (!authorized(req)) { needAuth(res); return; }
    const b = await readBody(req);
    const u = String(b.user || '').trim(), pw = String(b.pass || '');
    if (!u || pw.length < 4) { send(res, 400, { error: 'Логин не пустой, пароль не короче 4 символов' }); return; }
    const first = !auth.hasAccount();
    auth.setAccount(u, pw);
    if (first) {
      send(res, 200, { ok: true }, null, { 'Set-Cookie': sessionCookie(auth.newSession(), auth.SESSION_HOURS) });
    } else {
      auth.keepOnly(cookie(req, SID));
      send(res, 200, { ok: true });
    }
    return;
  }

  // ----- плейлист и программа для других плееров (0.6.2) -----
  // /m3u/<номер>.m3u и /m3u/<номер>.xml.gz — без пароля, если у плейлиста включена галочка «Ссылка для других плееров»
  // (и сам плейлист включён); со страницы сервера (после входа) — всегда; dl=1 — скачать файлом
  const ex = /^\/m3u\/(\d+)\.(m3u|xml\.gz)$/.exec(p);
  if (m === 'GET' && ex) {
    const id = +ex[1], src = srcById(id), x = cache.S(id);
    if (!src || !((src.on && src.share) || (auth.hasAccount() && authorized(req)))) { send(res, 404, { error: 'Нет такого плейлиста или ссылка выключена' }); return; }
    if (!x.parsed) { send(res, 503, { error: 'Плейлист ещё не скачан' }); return; }
    const fname = encodeURIComponent(src.name.replace(/[\\/:*?"<>|]/g, '_'));
    if (ex[2] === 'm3u') {
      const host = req.headers.host || ('127.0.0.1:' + PORT);
      // галочка «Программа провайдера» — его адреса программы (поле плейлиста или его url-tvg), иначе программа с сервера
      const prov = src.epg.length ? src.epg : sources.headerEpg(x.text);
      const body = exportM3u(id, src.epgProv && prov.length ? prov.join(',') : 'http://' + host + '/m3u/' + id + '.xml.gz');
      send(res, 200, body, 'audio/x-mpegurl; charset=utf-8', q.get('dl') ? { 'Content-Disposition': "attachment; filename=\"playlist.m3u\"; filename*=UTF-8''" + fname + '.m3u' } : {});
    } else {
      send(res, 200, exportEpg(id), 'application/gzip', q.get('dl') ? { 'Content-Disposition': "attachment; filename=\"epg.xml.gz\"; filename*=UTF-8''" + fname + '.xml.gz' } : {});
    }
    return;
  }

  // ----- домофон (0.7.9, lib/door.js) -----
  // От Home Assistant (rest_command): POST /doorbell?key=… {event: ring | end, door, reason}
  if (m === 'POST' && p === '/doorbell') {
    if (!door.keyOk(q.get('key') || req.headers['x-arctv-key'])) { send(res, 403, { error: 'Неверный ключ домофона' }); return; }
    send(res, 200, door.event(await readBody(req)));
    return;
  }
  // Телевизор ждёт звонка: ответ при изменении (seq) или через 25 с
  if (m === 'GET' && p === '/api/door/wait') {
    const dev = String(q.get('dev') || '');
    if (!store.isAllowed(dev)) { send(res, 403, { error: 'Телевизор не разрешён на сервере', notAllowed: true }); return; }
    door.wait(dev, q.get('seq'), req, (v) => { if (!res.writableEnded) { send(res, 200, v); } });
    return;
  }
  // Кадр с камеры (пока идёт вызов): телевизорам с флажком «Домофон» и странице сервера
  if (m === 'GET' && p === '/api/door/frame.jpg') {
    if (!store.doorAllowed(String(q.get('dev') || '')) && !authorized(req)) { send(res, 403, { error: 'Нет доступа' }); return; }
    const f = door.frame();
    if (!f) { send(res, 404, { error: 'Кадра нет' }); return; }
    send(res, 200, f, 'image/jpeg');
    return;
  }
  // Кнопка с пульта: {cmd: open | hangup}
  if (m === 'POST' && p === '/api/door/cmd') {
    const b = await readBody(req);
    const r = await door.command(String(q.get('dev') || ''), b.cmd === 'open' ? 'open' : 'hangup');
    send(res, r.error ? 409 : 200, r);
    return;
  }
  // Для страницы сервера: состояние, снимок для проверки, имитация звонка
  if (p.indexOf('/api/door/') === 0 && ['/api/door/status', '/api/door/snap', '/api/door/test'].indexOf(p) >= 0) {
    if (!authorized(req)) { needAuth(res); return; }
    if (p === '/api/door/status') { send(res, 200, door.status()); return; }
    if (p === '/api/door/snap') {
      try { send(res, 200, await door.snapshot(), 'image/jpeg'); } catch (e) { send(res, 502, { error: e.message }); }
      return;
    }
    if (p === '/api/door/test' && m === 'POST') {
      const b = await readBody(req);
      if (!door.status().on) { send(res, 409, { error: 'Сначала включите домофон и сохраните' }); return; }
      if (b.event === 'ring') { door.ring('test'); } else if (b.event === 'dismiss') { door.event({ event: 'dismiss', reason: b.reason || 'test' }); } else { door.end('test'); }
      send(res, 200, door.status());
      return;
    }
  }

  // ----- камеры (0.8.1, lib/cams.js) -----
  // Список для телевизора с плиткой «Камеры» (и для страницы сервера)
  if (m === 'GET' && p === '/api/cams') {
    const dev = String(q.get('dev') || '');
    if (!authorized(req) && !(store.isAllowed(dev) && store.camsAllowed(dev))) { send(res, 403, { error: 'Камеры этому телевизору не разрешены' }); return; }
    if (!cams.haReady()) { send(res, 503, { error: 'Нет доступа к Home Assistant' }); return; }
    try { send(res, 200, { fps: cams.fps(), cams: await cams.tvList() }); } catch (e) { send(res, 502, { error: e.message }); }
    return;
  }
  // Кадр: телевизору — по номеру включённой камеры (i), странице — по сущности (ent, для «Снимка»)
  if (m === 'GET' && p === '/api/cams/frame.jpg') {
    const dev = String(q.get('dev') || '');
    let ent = null;
    if (authorized(req) && /^camera\.[a-z0-9_]{1,120}$/.test(String(q.get('ent') || ''))) { ent = String(q.get('ent')); }
    if (!ent && store.isAllowed(dev) && store.camsAllowed(dev)) { ent = cams.entOf(q.get('i')); }
    if (!ent) { send(res, 403, { error: 'Нет доступа' }); return; }
    try { send(res, 200, await cams.frame(ent), 'image/jpeg'); } catch (e) { send(res, 502, { error: 'Камера: ' + e.message }); }
    return;
  }
  // Для страницы: все camera.* из HA + сохранённые (пересканирование — каждый запрос)
  if (m === 'GET' && p === '/api/cams/list') {
    if (!authorized(req)) { needAuth(res); return; }
    if (!cams.haReady()) { send(res, 200, { fps: cams.fps(), ha: false, rows: [] }); return; }
    try { send(res, 200, await cams.pageList()); } catch (e) { send(res, 502, { error: e.message }); }
    return;
  }

  // ----- для телевизора -----
  // Номер плейлиста — pl=…; без него (приложение до 0.6.0) — первый включённый плейлист
  // now — время сервера (мс): телевизор сверяет по нему свои часы
  if (m === 'GET' && p === '/api/ping') { send(res, 200, { ok: true, version: VERSION, now: Date.now() }); return; }

  // Значки праздников (0.6.8): правила и рисунки; телевизор хранит их до следующего изменения (holAt в /api/config)
  if (m === 'GET' && p === '/api/holidays') {
    const s = store.getSettings();
    send(res, 200, holidays.forTv(s.HOLIDAYS, (s._holAt || 0) + holidays.REV));
    return;
  }
  // для страницы: все значки и ближайшие даты
  if (m === 'GET' && p === '/api/holidays/page') {
    if (!authorized(req)) { needAuth(res); return; }
    const s = store.getSettings();
    send(res, 200, { list: s.HOLIDAYS, icons: holidays.iconList(), upcoming: holidays.upcoming(s.HOLIDAYS, new Date()) });
    return;
  }

  if (m === 'GET' && p === '/api/progress') { send(res, 200, Object.assign({ now: Date.now() }, cache.progress())); return; }

  // Настройки для телевизора: общие и его свои, с временем изменения каждой (stamps); список плейлистов (pls)
  if (m === 'GET' && p === '/api/config') {
    const dev = seen(req, q);
    const st = cache.status(), id = plOf(q), x = cache.S(id), ps = store.plSettings(id);
    const cfg = store.deviceConfig(dev);
    // для старого приложения — группы и программа плейлиста по умолчанию
    cfg.config.CLOSED_GROUPS = tvGroups(id, ps.CLOSED_GROUPS, true);
    cfg.config.EXT_GROUPS = tvGroups(id, ps.EXT_GROUPS);
    cfg.config.EPG_URL = (srcById(id) || {}).epg ? (srcById(id).epg[0] || '') : '';
    cfg.config.CAMS = cams.countFor(dev);              // плитка «Камеры» (0.8.1): сколько камер; 0 — плитки нет
    send(res, 200, Object.assign(cfg, {
      dev, server: VERSION, playlistAt: x.at, epgAt: x.epgAt, channels: x.parsed ? x.parsed.channels.length : 0, epgCount: x.epgCount,
      refreshing: st.running, now: Date.now(), pls: tvPlaylists(),
      holAt: (store.getSettings()._holAt || 0) + holidays.REV   // календарь или рисунки изменены — телевизор заберёт /api/holidays
    }));
    return;
  }

  // Изменения из Tools на телевизоре: {changes: {key: {v, at}}}; побеждает более позднее
  if (m === 'POST' && p === '/api/tvset') {
    const dev = devId(req, q);
    const b = await readBody(req);
    send(res, 200, Object.assign(store.applyTvChanges(dev, b.changes), { now: Date.now() }));
    return;
  }

  if (m === 'GET' && p === '/api/playlist') {
    // только своим телевизорам: номер телевизора (dev) должен быть разрешён на странице сервера
    const dev = String(q.get('dev') || '');
    if (!store.isAllowed(dev)) {
      if (dev) { seen(req, q); }                     // новый телевизор появится на странице с кнопкой «Разрешить»
      send(res, 403, { error: 'Телевизор не разрешён на сервере', notAllowed: true });
      return;
    }
    const id = plOf(q);
    if (!id) { send(res, 503, { error: 'На сервере нет плейлистов' }); return; }
    if (!cache.S(id).gz) {
      // сервер только что запущен и ещё ничего не скачал — ждём первое обновление
      if (cache.C.running) { await cache.C.running; }
      if (!cache.S(id).gz) { send(res, 503, { error: cache.S(id).error || cache.C.lastError || 'Плейлист ещё не скачан' }); return; }
    }
    // без скрытых групп и каналов; телевизору без закрытых групп — и без их каналов
    sendGz(req, res, tvPlaylist(id, dev), 'audio/x-mpegurl; charset=utf-8', { 'X-ArcTV-Updated': String(cache.S(id).at) });
    return;
  }

  if (m === 'GET' && p === '/api/epg') {
    const id = plOf(q), x = cache.S(id);
    if (!x.epgGz) {
      if (cache.C.running) { await cache.C.running; }
      if (!x.epgGz) { send(res, 503, { error: x.epgError || cache.C.lastError || 'Программа ещё не скачана' }); return; }
    }
    // set=main — программа основных и закрытых групп (при входе в плейлист), set=ext — только расширенных
    // (телевизор догружает при включении расширенного режима); без set — вся (старые версии приложения)
    const set = q.get('set') || '';
    // телевизору без закрытых групп программа их каналов тоже не нужна; скрытые каналы — тоже без программы
    const hid = hiddenOnlyIds(id), ext = new Set([...extIds(id)].filter((k) => !hid.has(k)));
    const skip = new Set([...extIds(id), ...hid, ...(store.closedAllowed(String(q.get('dev') || '')) ? [] : closedOnlyIds(id))]);
    // телевизору без расширенных групп (0.7.2) их программа не отдаётся
    if (set === 'ext' && !store.extAllowed(String(q.get('dev') || ''))) { ext.clear(); }
    const gz = set ? cache.epgPart(id, q.get('part') === 'now', set === 'ext' ? ext : skip, set === 'ext') :
      cache.epgPart(id, q.get('part') === 'now', new Set(), false);
    sendGz(req, res, gz, 'text/plain; charset=utf-8', { 'X-ArcTV-Updated': String(x.epgAt) });
    return;
  }

  // Описание одной передачи (кнопка Info на телевизоре): ch — tvg-id, s — начало (UTC, секунды)
  if (m === 'GET' && p === '/api/desc') {
    send(res, 200, { d: cache.descOf(plOf(q), q.get('ch') || '', parseInt(q.get('s') || '0', 10)) });
    return;
  }

  // Избранное (fav — всех плейлистов; favorites — плейлиста pl, для старого приложения) и сохранения (всех плейлистов)
  if (m === 'GET' && p === '/api/state') {
    seen(req, q);
    dropClosedFavs();
    send(res, 200, stateFor(plOf(q)));
    return;
  }

  if (m === 'POST' && p === '/api/fav') {
    const b = await readBody(req);
    const id = +b.pl || plOf(q);
    // каналы закрытых групп в Избранное не добавляются
    const closed = closedKeys(id);
    store.changeFavorites(id, (Array.isArray(b.add) ? b.add : []).filter((k) => !closed.has(k)), Array.isArray(b.remove) ? b.remove : []);
    dropClosedFavs();
    send(res, 200, Object.assign({ ok: true }, stateFor(id)));
    return;
  }

  // Сохранения (синяя кнопка): {add: {..., pl}} или {remove: id}
  if (m === 'POST' && p === '/api/save') {
    const b = await readBody(req);
    if (b.add) { if (!(+b.add.pl > 0)) { b.add.pl = plOf(q); } store.addSave(b.add); }
    if (b.remove) { store.removeSave(String(b.remove)); }
    send(res, 200, { ok: true, rev: store.getState().rev, saves: store.getState().saves });
    return;
  }

  // Обновить плейлисты и программу. wait=1 — ответить после окончания.
  if (m === 'POST' && p === '/api/refresh') {
    const job = cache.refresh();
    if (q.get('wait') === '1') { await job; }
    send(res, 200, cache.status());
    return;
  }

  // ----- для страницы настроек -----
  // pl — плейлист, чьи группы, каналы и Избранное показать
  if (p === '/api/status' && m === 'GET') {
    if (!authorized(req)) { needAuth(res); return; }
    dropClosedFavs();
    const st = store.getState(), id = plOf(q, true), x = id ? cache.S(id) : null, ps = id ? store.plSettings(id) : null;
    send(res, 200, {
      version: VERSION, cache: cache.status(), pl: id,
      devices: store.listDevices(),
      favorites: id ? store.favOf(id) : [], saves: st.saves,
      plNames: Object.fromEntries(store.getSettings().SOURCES.map((y) => [y.id, y.name])),
      // группы в своём порядке (для выбора основная / расширенная / закрытая / скрытая)
      groups: id ? Array.from(new Set(orderedChannels(id).map((c) => c.group))) : [],
      groupsOrig: x && x.parsed ? Array.from(new Set(x.parsed.channels.map((c) => c.group))) : [],
      channels: x && x.parsed ? m3u.numbered(orderedChannels(id), (g) => kindOf(ps, g), (c) => isHidden(ps, c)).map((c) => ({ n: c.num, name: c.name, id: c.tvgId, g: c.group, rec: c.rec, cl: c.closed, k: c.kind, h: c.hid })) : []
    });
    return;
  }

  if (p === '/api/settings') {
    if (!authorized(req)) { needAuth(res); return; }
    const id = plOf(q, true);
    if (m === 'GET') { send(res, 200, settingsForPage(id)); return; }
    if (m === 'POST') {
      const snap = () => JSON.stringify([store.getSettings().SOURCES, store.getSettings().EPG_PAST_HOURS, store.getSettings().EPG_FUTURE_HOURS]);
      const before = snap(), idsBefore = store.getSettings().SOURCES.map((x) => x.id);
      const b = await readBody(req);
      // свои имена групп: два одинаковых имени (в том числе с именем другой группы у провайдера) — нельзя
      if (b.GROUP_NAMES && (+b.pl || id)) {
        const clash = nameClashes(+b.pl || id, b.GROUP_NAMES);
        if (clash.length) { send(res, 400, { error: 'Одинаковые имена групп: ' + clash.join(', ') + '. Имена групп не должны повторяться.' }); return; }
      }
      const doorWas = JSON.stringify(store.getSettings().DOOR);
      store.saveSettings(b, +b.pl || id);
      if (JSON.stringify(store.getSettings().DOOR) !== doorWas) { door.check(); }   // домофон включили — вдруг вызов уже идёт
      // удалённые плейлисты: их настройки, Избранное, сохранения и файлы
      const idsAfter = new Set(store.getSettings().SOURCES.map((x) => x.id));
      for (const old of idsBefore) { if (!idsAfter.has(old)) { store.dropPl(old); cache.forget(old); } }
      // сменились плейлисты или окно программы — обновляем сразу
      if (snap() !== before) { cache.refresh(); } else { cache.schedule(); }
      send(res, 200, settingsForPage(+b.pl || id));
      return;
    }
  }

  // Телевизор со страницы: {dev, name, set: {...}} или {dev, remove: true}
  if (m === 'POST' && p === '/api/device') {
    if (!authorized(req)) { needAuth(res); return; }
    const b = await readBody(req);
    const r = store.saveDevice(String(b.dev || ''), b);
    if (!r) { send(res, 404, { error: 'Нет такого телевизора' }); return; }
    send(res, 200, { ok: true, devices: store.listDevices() });
    return;
  }

  send(res, 404, { error: 'Нет такого адреса' });
}

function srcById(id) { return store.getSettings().SOURCES.find((x) => x.id === +id) || null; }

// Номер плейлиста из запроса: включённый плейлист pl, иначе первый включённый.
// any=true (страница сервера) — можно и выключенный, а если включённых нет — первый в списке.
function plOf(q, any) {
  const list = store.getSettings().SOURCES, want = +(q.get('pl') || 0);
  const x = list.find((y) => y.id === want && (y.on || any));
  if (x) { return x.id; }
  const on = list.find((y) => y.on);
  return on ? on.id : (any && list[0] ? list[0].id : 0);
}

// Плейлисты для телевизора: включённые, в порядке страницы; с тем, что нужно ему без сервера
function tvPlaylists() {
  // ещё ни разу не скачанный плейлист телевизору не показываем
  return sources.enabled(store.getSettings().SOURCES).filter((src) => cache.S(src.id).gz).map((src) => {
    const x = cache.S(src.id), ps = store.plSettings(src.id);
    return { id: src.id, name: src.name, at: x.at, epgAt: x.epgAt,
      channels: x.parsed ? x.parsed.channels.filter((c) => !isHidden(ps, c)).length : 0,
      CLOSED_GROUPS: tvGroups(src.id, ps.CLOSED_GROUPS, true), EXT_GROUPS: tvGroups(src.id, ps.EXT_GROUPS), EPG_URL: src.epg[0] || '' };
  });
}

// Своё имя группы (0.7.2) или имя провайдера
function gName(ps, g) { return (ps.GROUP_NAMES && ps.GROUP_NAMES[g]) || g; }

// Списки групп для телевизора — со своими именами. Закрытые (closed = true): ещё и закрытые по словам,
// если группа переименована (телевизор ищет слова уже в своём имени и сам её не узнает).
function tvGroups(id, list, closed) {
  const ps = store.plSettings(id), out = (list || []).map((g) => gName(ps, g));
  if (closed) {
    for (const g of new Set(channelsOf(id).map((c) => c.group))) {
      if (ps.GROUP_NAMES[g] && isClosed(ps, g) && out.indexOf(gName(ps, g)) < 0) { out.push(gName(ps, g)); }
    }
  }
  return out;
}

// Одинаковые имена групп после переименования (у плейлиста id с новыми именами names) — список повторов
function nameClashes(id, names) {
  const seen = new Map(), clash = [];
  for (const g of new Set(channelsOf(id).map((c) => c.group))) {
    const n = (names && names[g]) || g, low = n.toLowerCase();
    if (seen.has(low) && clash.indexOf(n) < 0) { clash.push(n); }
    seen.set(low, g);
  }
  return clash;
}

function stateFor(id) {
  const st = store.getState();
  return { now: Date.now(), rev: st.rev, fav: st.fav, favorites: store.favOf(id), saves: st.saves, pl: id };
}

// Закрытая группа: отмечена вручную или есть слово из ADULT_KEYWORDS (как на телевизоре)
function isClosed(ps, name) {
  const low = String(name).toLowerCase();
  if ((ps.CLOSED_GROUPS || []).indexOf(name) >= 0) { return true; }
  return (store.getSettings().ADULT_KEYWORDS || []).some((k) => k && low.indexOf(String(k).toLowerCase()) >= 0);
}

// Вид группы: скрытая, закрытая (по словам или вручную), расширенная (вручную), основная (все остальные, в том числе новые)
function kindOf(ps, name) {
  if ((ps.HIDDEN_GROUPS || []).indexOf(name) >= 0) { return 'hidden'; }
  if (isClosed(ps, name)) { return 'closed'; }
  return (ps.EXT_GROUPS || []).indexOf(name) >= 0 ? 'ext' : 'main';
}

// Скрыт ли канал (скрыта его группа или он сам)
function isHidden(ps, c) {
  return (ps.HIDDEN_GROUPS || []).indexOf(c.group) >= 0 || (ps.HIDDEN_CHANNELS || []).indexOf(m3u.chKey(c)) >= 0;
}

function channelsOf(id) { const x = cache.S(id); return x.parsed ? x.parsed.channels : []; }

// tvg-id, которые есть только у каналов, для которых test(канал) — true
function onlyIds(id, test) {
  const yes = new Set(), other = new Set();
  for (const c of channelsOf(id)) { if (c.tvgId) { (test(c) ? yes : other).add(c.tvgId); } }
  for (const k of other) { yes.delete(k); }
  return yes;
}
function extIds(id) { const ps = store.plSettings(id); return onlyIds(id, (c) => kindOf(ps, c.group) === 'ext'); }
function closedOnlyIds(id) { const ps = store.plSettings(id); return onlyIds(id, (c) => isClosed(ps, c.group)); }
function hiddenOnlyIds(id) { const ps = store.plSettings(id); return onlyIds(id, (c) => isHidden(ps, c)); }

// Каналы плейлиста в своём порядке (группы и каналы внутри групп)
function orderedChannels(id) {
  const ps = store.plSettings(id);
  return m3u.ordered(channelsOf(id), ps.GROUP_ORDER, ps.CHANNEL_ORDER);
}

// Плейлист для телевизора (сжатый): без скрытых групп и каналов; телевизору без закрытых групп — и без них.
// Готовые варианты хранятся до следующего обновления плейлиста или смены настроек групп.
const plCache = new Map();
function tvPlaylist(id, dev) {
  const x = cache.S(id), ps = store.plSettings(id), noCl = !store.closedAllowed(dev), noExt = !store.extAllowed(dev),
    hidG = ps.HIDDEN_GROUPS, hidC = ps.HIDDEN_CHANNELS, gOrd = ps.GROUP_ORDER, cOrd = ps.CHANNEL_ORDER;
  if (!noCl && !noExt && !hidG.length && !hidC.length && !gOrd.length && !Object.keys(cOrd).length && !Object.keys(ps.GROUP_NAMES).length) { return x.gz; }
  const key = [id, x.at, noCl, noExt, store.getSettings().ADULT_KEYWORDS.join(','), JSON.stringify(ps)].join('|');
  if (!plCache.has(key)) {
    if (plCache.size > 8) { plCache.clear(); }
    const hc = new Set(hidC), gr = new Map(), cr = new Map();
    // свой порядок групп и каналов (GROUP_ORDER, CHANNEL_ORDER)
    for (const c of orderedChannels(id)) {
      if (!gr.has(c.group)) { gr.set(c.group, gr.size); }
      cr.set(c.group + '\n' + m3u.chKey(c), cr.size);
    }
    const big = 1e9;
    plCache.set(key, zlib.gzipSync(m3u.applyNames(m3u.rebuild(x.text || '',
      (g, k) => hidG.indexOf(g) < 0 && !hc.has(k) && !(noCl && isClosed(ps, g)) && !(noExt && kindOf(ps, g) === 'ext'),
      (g, k) => [gr.has(g) ? gr.get(g) : big, cr.has(g + '\n' + k) ? cr.get(g + '\n' + k) : big]), ps.GROUP_NAMES)));
  }
  return plCache.get(key);
}

// Для других плееров: только основные группы (без расширенных, закрытых и скрытых), без скрытых каналов,
// в своём порядке, с номерами как на телевизоре (tvg-chno), программа — с этого сервера
function exportKeep(id) {
  const ps = store.plSettings(id), hc = new Set(ps.HIDDEN_CHANNELS);
  return (g, k) => kindOf(ps, g) === 'main' && !hc.has(k);
}
function exportM3u(id, epgUrl) {
  const x = cache.S(id), ps = store.plSettings(id), gr = new Map(), cr = new Map(), num = new Map();
  for (const c of orderedChannels(id)) {
    if (!gr.has(c.group)) { gr.set(c.group, gr.size); }
    cr.set(c.group + '\n' + m3u.chKey(c), cr.size);
  }
  for (const c of m3u.numbered(orderedChannels(id), (g) => kindOf(ps, g), (c) => isHidden(ps, c))) {
    if (c.num && !num.has(c.group + '\n' + m3u.chKey(c))) { num.set(c.group + '\n' + m3u.chKey(c), c.num); }
  }
  const big = 1e9;
  // свои имена групп — уже после номеров (номера считаются по именам провайдера)
  return m3u.applyNames(m3u.exportText(x.text || '', exportKeep(id),
    (g, k) => [gr.has(g) ? gr.get(g) : big, cr.has(g + '\n' + k) ? cr.get(g + '\n' + k) : big],
    (g, k) => num.get(g + '\n' + k) || 0, epgUrl), ps.GROUP_NAMES);
}
// Программа для других плееров: только каналы из exportM3u; готовая хранится до новой программы или смены групп
const exCache = new Map();
function exportEpg(id) {
  const x = cache.S(id), keep = exportKeep(id), chans = new Map(), sh = Math.round((+store.getSettings().EPG_SHIFT_MIN || 0) * 60);
  for (const c of orderedChannels(id)) { if (c.tvgId && keep(c.group, m3u.chKey(c)) && !chans.has(c.tvgId)) { chans.set(c.tvgId, c.name); } }
  const key = [id, x.epgAt, sh, Array.from(chans.keys()).join('\n')].join('|');
  if (!exCache.has(key)) {
    if (exCache.size > 6) { exCache.clear(); }
    exCache.set(key, zlib.gzipSync(epg.toXmltv(chans, x.epg, x.desc, sh)));
  }
  return exCache.get(key);
}

// Ключи Избранного (tvg-id|название) каналов закрытых групп плейлиста
function closedKeys(id) {
  const ps = store.plSettings(id), out = new Set();
  for (const c of channelsOf(id)) { if (isClosed(ps, c.group)) { out.add(m3u.chKey(c)); } }
  return out;
}

// Каналы закрытых групп в Избранном не держим (например, группу закрыли галочкой после добавления)
function dropClosedFavs() {
  for (const src of store.getSettings().SOURCES) {
    const closed = closedKeys(src.id), bad = store.favOf(src.id).filter((k) => closed.has(k));
    if (bad.length) { store.changeFavorites(src.id, [], bad); }
  }
}

function settingsForPage(id) {
  const s = store.getSettings(), o = {};
  for (const k of store.SOURCE_KEYS.concat(store.COMMON_KEYS)) { o[k] = s[k]; }
  if (id) { Object.assign(o, store.plSettings(id)); }
  return { values: o, pl: id, deviceKeys: store.DEVICE_KEYS, accents: store.ACCENTS };
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    cache.log('Ошибка запроса', req.method, req.url, e.message);
    if (!res.headersSent) { send(res, 500, { error: e.message }); }
  });
});

cache.restore();
server.listen(PORT, () => {
  cache.log('ArcTV server ' + VERSION + ' слушает порт ' + PORT + ', данные в ' + store.DIR);
  cache.startup();
  // домофон: вдруг вызов уже идёт (сервер перезапустили во время звонка); ключ для HA создаётся сам
  door.key();
  setTimeout(() => { door.check(); }, 5000);
});

function shutdown() {
  store.flush();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
