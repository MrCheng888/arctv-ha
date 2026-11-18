'use strict';
// Запасной сервер (1.0.1). Только в одну сторону: основной (HA) → запасной (NAS).
//  • раз в 30 с HA спрашивает NAS (/api/peer/info): на связи ли, версия, ключ, когда была полная отправка;
//  • закрытые группы (слова, PIN, закрытые вручную, флажок «Закрытые группы» у ТВ) расходятся — HA сразу
//    отправляет на NAS только их, в обе стороны (закрыли — закрываются, открыли — открываются); время
//    синхронизации на NAS это не меняет;
//  • полная отправка (Избранное, сохранения, настройки, телевизоры, логин): раз в час, если NAS работает без
//    перерыва с прошлой полной отправки; NAS был выключен или перезапущен — только кнопкой «Отправить на NAS»
//    (после неё — снова раз в час).
// На NAS (вписан ключ основного — REPLICA.key) закрытые группы — только просмотр (lib/store.js).
const crypto = require('crypto');
const store = require('./store');
const auth = require('./auth');

const PROTO = 1;                 // номер протокола: разный — NAS «другой версии», ничего не отправляется
const CHECK_MS = +process.env.ARCTV_PEER_CHECK_MS || 30000;     // переменные — только для проверки
const HOUR_MS = +process.env.ARCTV_PEER_HOUR_MS || 3600000;
const DEFAULT_URL = 'http://192.168.1.250:18090';

const st = { state: '', msg: '', ver: '', checkedAt: 0, startedAt: 0, syncAt: 0, dataAt: 0, closedOk: null, closedAt: 0, push: null };
let log = () => {};

function cfg() { return store.getSettings().PEER || { url: '', key: '' }; }
function active() { return !store.isReplica() && !!cfg().url; }
function key() {
  if (!cfg().key) { store.setPeer({ key: crypto.randomBytes(18).toString('base64url') }); }
  return cfg().key;
}
function set(state, msg) { st.state = state; st.msg = msg || ''; }

async function call(method, p, body, ms) {
  const r = await fetch(cfg().url + p, {
    method, headers: { 'Content-Type': 'application/json', 'X-ArcTV-Key': key() },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms || 5000)
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* не JSON */ }
  return { status: r.status, j };
}

// Полная отправка (внутри уже занятой очереди)
async function doPush(manual) {
  const data = store.snapshot();
  data.auth = auth.exportAccount();
  let r;
  try { r = await call('POST', '/api/peer/import', { proto: PROTO, kind: 'full', data }, 60000); } catch (e) { r = { status: 0, j: { error: 'NAS не ответил' } }; }
  const ok = r.status === 200 && !!r.j.ok;
  st.push = { at: Date.now(), ok, manual: !!manual, msg: ok ? '' : (r.j.error || 'Ответ NAS: ' + r.status) };
  if (ok) {
    st.syncAt = r.j.syncAt; st.dataAt = r.j.dataAt;
    st.closedOk = store.closedSame(store.closedConfig(), r.j.closed);
  }
  log('Запасной: ' + (manual ? 'отправка кнопкой' : 'отправка раз в час') + ' — ' + (ok ? 'NAS принял' : 'ошибка: ' + st.push.msg));
  return ok;
}

async function doCheck() {
  let r;
  try { r = await call('GET', '/api/peer/info'); } catch (e) { set('off', 'NAS не отвечает'); st.checkedAt = Date.now(); return; }
  st.checkedAt = Date.now();
  if (r.status === 404) { set('old', 'На NAS старая версия сервера — обновите его'); return; }
  if (r.status === 403) {
    if (r.j.nokey) { set('nokey', 'На странице NAS не вписан ключ основного сервера'); } else { set('badkey', 'Ключ не совпадает — впишите на странице NAS ключ с этой страницы'); }
    return;
  }
  if (r.status !== 200 || !r.j.ok) { set('err', r.j.error || 'Ответ NAS: ' + r.status); return; }
  if (r.j.proto !== PROTO) { set('old', 'На NAS другая версия сервера (' + (r.j.version || '?') + ') — обновите его'); return; }
  set('ok');
  Object.assign(st, { ver: r.j.version, startedAt: +r.j.startedAt || 0, syncAt: +r.j.syncAt || 0, dataAt: +r.j.dataAt || 0 });
  // закрытые группы — сразу, в обе стороны
  const mine = store.closedConfig();
  if (store.closedSame(mine, r.j.closed)) { st.closedOk = true; } else {
    let c;
    try { c = await call('POST', '/api/peer/import', { proto: PROTO, kind: 'closed', closed: mine }, 10000); } catch (e) { c = { status: 0, j: {} }; }
    st.closedAt = Date.now();
    st.closedOk = c.status === 200 && store.closedSame(mine, c.j.closed);
    log('Запасной: закрытые группы на NAS ' + (st.closedOk ? 'обновлены' : 'не обновились (ответ ' + c.status + ')'));
  }
  // раз в час — только если NAS работает без перерыва с прошлой полной отправки
  if (st.syncAt && st.startedAt && st.startedAt < st.syncAt && Date.now() - st.syncAt >= HOUR_MS) { await doPush(false); }
}

// Одна операция за раз: проверка и отправка не идут одновременно
let chain = Promise.resolve();
function queue(fn) { const run = chain.then(fn).catch((e) => { set('err', e.message); }); chain = run; return run; }

function check() { if (!active()) { return Promise.resolve(); } return queue(doCheck); }

// Кнопка «Отправить на NAS»: сначала проверка (NAS на связи, версия, ключ), потом отправка
async function pushNow() {
  if (!active()) { return { error: 'Запасной сервер не настроен' }; }
  let res = null;
  await queue(async () => {
    await doCheck();
    if (st.state !== 'ok') { res = { error: st.msg || 'NAS недоступен' }; return; }
    res = (await doPush(true)) ? { ok: true } : { error: st.push.msg };
  });
  return Object.assign(res || { error: 'Не получилось' }, { status: status() });
}

function status() {
  const s = store.getSettings();
  return Object.assign({}, st, {
    role: store.isReplica() ? 'replica' : (cfg().url ? 'primary' : ''),
    url: cfg().url, key: store.isReplica() ? '' : (cfg().url ? key() : ''),
    // на NAS: когда была последняя полная отправка с HA
    mySyncAt: s._syncAt || 0, myDataAt: s._dataAt || 0, now: Date.now(),
    // для окна подтверждения: что уйдёт на NAS
    counts: (() => {
      const stt = store.getState();
      return { fav: Object.keys(stt.fav || {}).reduce((n, k) => n + (stt.fav[k] || []).length, 0), saves: (stt.saves || []).length,
        tvs: store.listDevices().length, pls: s.SOURCES.length };
    })()
  });
}

function setUrl(url) { store.setPeer({ url: url || '' }); if (active()) { key(); setTimeout(check, 100); } return status(); }

// Сравнение ключа без утечки по времени
function keyOk(given) {
  const want = (store.getSettings().REPLICA || {}).key || '';
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return !!want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function start(logger) {
  log = logger || log;
  // в дополнении Home Assistant — основной сервер, NAS по умолчанию
  if (!store.isReplica() && !cfg().url && process.env.SUPERVISOR_TOKEN) { store.setPeer({ url: DEFAULT_URL }); }
  if (active()) { key(); log('Запасной сервер: ' + cfg().url); }
  setTimeout(check, 5000);
  setInterval(check, CHECK_MS);
}

module.exports = { PROTO, start, check, pushNow, status, setUrl, keyOk };
