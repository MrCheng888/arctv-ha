'use strict';
// Домофон (0.7.9): Home Assistant сообщает о звонке (POST /doorbell: ring / end), сервер передаёт это
// телевизорам (ожидающий запрос /api/door/wait), раздаёт кадр с камеры и передаёт в HA кнопки с пульта.
// Доступ к HA — собственный доступ дополнения: SUPERVISOR_TOKEN, http://supervisor/core/api
// (в config.yaml дополнения homeassistant_api: true). Без него (сервер на NAS) — домофон не работает.
const crypto = require('crypto');
const store = require('./store');

const BASE = process.env.HA_API_URL || 'http://supervisor/core/api';
const TOKEN = () => process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const SAFETY_MS = 150000;     // нет «end» от HA — окно закрывается само через 2,5 мин после последнего звонка
const DISMISS_MS = 10000;     // dismiss: кнопки убрать сразу, окно закрыть через 10 с после сброса
const DISMISS_OPEN_MS = 5000; // … и через 5 с после открытия двери (0.8.4)

// Кадров в секунду (настройка «Домофон» на странице, 0.8.0): 0 — без картинки, обычно 1–2
function fps() {
  const f = +(cfg() || {}).fps;
  return isNaN(f) ? 1 : Math.min(10, Math.max(0, f));
}
function frameMs() { return Math.max(100, Math.round(1000 / (fps() || 1))); }
const WAIT_MS = 25000;        // ожидающий запрос телевизора держится до 25 с

// seq растёт при каждом изменении — телевизор ждёт, пока seq станет не тем, что у него
const S = { active: false, seq: 1, ringAt: 0, endAt: 0, door: '', reason: '', status: '', statusAt: 0,
  frame: null, frameAt: 0, frameErr: '', lastEvent: '', lastEventAt: 0, haErr: '' };
let waiters = [], safety = null, frameTimer = null, dismissTimer = null;

function cfg() { return store.getSettings().DOOR; }
function enabled() { const c = cfg(); return !!(c && c.on); }
function haReady() { return !!TOKEN(); }
function log() { try { require('./cache').log.apply(null, ['Домофон:'].concat(Array.from(arguments))); } catch (e) {} }

function bump() {
  S.seq++;
  const w = waiters; waiters = [];
  for (const f of w) { try { f(); } catch (e) {} }
}

async function ha(method, path, body, raw) {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) { throw new Error('Home Assistant ответил ' + r.status); }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

function startFrames() {
  if (frameTimer || !haReady() || fps() === 0) { return; }
  const tick = async () => {
    if (!S.active) { frameTimer = null; return; }
    try {
      S.frame = await ha('GET', '/camera_proxy/' + encodeURIComponent(cfg().camera), null, true);
      S.frameAt = Date.now(); S.frameErr = '';
    } catch (e) { S.frameErr = e.message; }
    frameTimer = S.active ? setTimeout(tick, frameMs()) : null;
  };
  frameTimer = setTimeout(tick, 0);
}
function stopFrames() { if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; } S.frame = null; S.frameAt = 0; }

// В дверь позвонили. Повторный звонок во время вызова — то же окно, но время звонка обновляется:
// телевизор, где окно скрыли кнопкой Return, покажет его снова, а прежний статус («Вызов сброшен»)
// очищается, чтобы кнопки «открыть / сбросить» снова работали (замечание 12.11: после сброса
// следующий звонок приходил без кнопок — вызов в HA ещё минуту не закончен, и статус оставался).
function ring(door) {
  S.active = true; S.ringAt = Date.now(); S.door = String(door || '').slice(0, 40);
  S.status = ''; S.statusAt = 0; S.reason = '';
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  if (safety) { clearTimeout(safety); }
  safety = setTimeout(() => { log('нет сигнала об окончании вызова — окно закрыто через 2,5 мин'); end('safety'); }, SAFETY_MS);
  startFrames();
  bump();
}

// Сброс вызова или открытие двери не с телевизора (телефон, домашняя панель): кнопки убрать сразу,
// окно ещё 10 с показывает камеру. reason 'open' — «Открываю дверь…», остальное — «Вызов сброшен».
// Статус, уже поставленный кнопкой с телевизора (тот же скрипт присылает dismiss следом), не перетираем.
function dismiss(reason) {
  if (!S.active) { return; }
  // открытие двери важнее сброса: после «Вызов сброшен» дверь можно открыть (зелёная остаётся, 0.8.8)
  if (reason === 'open') { S.status = 'opening'; } else if (S.status !== 'opening') { S.status = 'hangup'; }
  S.statusAt = Date.now();
  log('dismiss', reason || '');
  bump();
  closeLater(reason || 'dismiss');
}

// Окно закрыть позже: через 5 с после открытия двери, через 10 с после сброса
function closeLater(reason) {
  if (dismissTimer) { clearTimeout(dismissTimer); }
  dismissTimer = setTimeout(() => { dismissTimer = null; end(reason); }, S.status === 'opening' ? DISMISS_OPEN_MS : DISMISS_MS);
}

function end(reason) {
  if (!S.active) { return; }
  S.active = false; S.endAt = Date.now(); S.reason = String(reason || '').slice(0, 40);
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  if (safety) { clearTimeout(safety); safety = null; }
  stopFrames();
  bump();
}

// От HA: {event: 'ring' | 'dismiss' | 'end', door, reason}. Ответ сразу, обработка — после.
function event(b) {
  b = b || {};
  const ev = String(b.event || '');
  S.lastEvent = ev; S.lastEventAt = Date.now();
  if (!enabled()) { return { ok: true, ignored: 'Домофон выключен на странице сервера' }; }
  if (ev === 'ring') { setImmediate(() => ring(b.door)); return { ok: true }; }
  if (ev === 'dismiss') { setImmediate(() => dismiss(b.reason)); return { ok: true }; }
  if (ev === 'end') { setImmediate(() => end(b.reason)); return { ok: true }; }
  return { ok: false, error: 'event: ring, dismiss или end' };
}

// Ключ для POST /doorbell (вписан в адрес rest_command); создаётся сам
function key() {
  const c = cfg();
  if (!c.key) { store.saveSettings({ DOOR: Object.assign({}, c, { key: crypto.randomBytes(9).toString('base64url') }) }); }
  return cfg().key;
}
function keyOk(k) { const c = cfg(); return !!(c.key && k && String(k) === c.key); }

// Состояние для телевизора: показывать ли окно (домофон включён, флажок в карточке телевизора)
function view(dev) {
  const show = enabled() && store.doorAllowed(dev);
  return { seq: S.seq, active: show && S.active, ringAt: S.ringAt, status: S.status, statusAt: S.statusAt, on: show, fps: fps(), now: Date.now() };
}

// Ожидающий запрос: ответ сразу, если у телевизора старый seq, иначе — при изменении или через 25 с
function wait(dev, seq, req, cb) {
  if (+seq !== S.seq) { cb(view(dev)); return; }
  let done = false;
  const fire = () => { if (done) { return; } done = true; clearTimeout(t); cb(view(dev)); };
  const t = setTimeout(() => { waiters = waiters.filter((f) => f !== fire); fire(); }, WAIT_MS);
  waiters.push(fire);
  req.on('close', () => { if (!done) { done = true; clearTimeout(t); waiters = waiters.filter((f) => f !== fire); } });
}

// Кнопка с пульта: open — открыть дверь, hangup — сбросить вызов
async function command(dev, cmd) {
  if (!enabled() || !store.doorAllowed(dev)) { return { error: 'Домофон этому телевизору не разрешён' }; }
  if (!S.active) { return { error: 'Вызова нет' }; }
  if (!haReady()) { return { error: 'Нет связи с Home Assistant' }; }
  const script = cmd === 'open' ? cfg().open : cfg().hangup;
  try {
    await ha('POST', '/services/script/turn_on', { entity_id: script });
    // сброс не перетирает «Открываю дверь…»; открытие после сброса — да (0.8.8), и окно тогда закроется через 5 с
    if (cmd === 'open') { S.status = 'opening'; if (dismissTimer) { closeLater('open'); } }
    else if (S.status !== 'opening') { S.status = 'hangup'; }
    S.statusAt = Date.now(); S.haErr = '';
    log(cmd === 'open' ? 'открыть дверь' : 'сбросить вызов', '— телевизор', dev);
    bump();
    return { ok: true };
  } catch (e) {
    S.haErr = e.message;
    S.status = 'error'; S.statusAt = Date.now(); bump();
    return { error: e.message };
  }
}

// Снимок для проверки со страницы сервера (без вызова)
async function snapshot() {
  if (!haReady()) { throw new Error('Нет доступа к Home Assistant (сервер не в дополнении HA)'); }
  return ha('GET', '/camera_proxy/' + encodeURIComponent(cfg().camera), null, true);
}

// При запуске сервера и при включении домофона: вдруг вызов уже идёт
async function check() {
  if (!enabled() || !haReady()) { return; }
  try {
    const st = await ha('GET', '/states/' + encodeURIComponent(cfg().timer));
    S.haErr = '';
    if (st && st.state === 'active' && !S.active) { log('вызов уже идёт (' + cfg().timer + ')'); ring('entrance'); }
  } catch (e) { S.haErr = e.message; log('нет ответа HA:', e.message); }
}

// Для страницы сервера
function status() {
  return { on: enabled(), ha: haReady(), active: S.active, ringAt: S.ringAt, endAt: S.endAt, reason: S.reason, status: S.status,
    frameAt: S.frameAt, frameErr: S.frameErr, lastEvent: S.lastEvent, lastEventAt: S.lastEventAt, haErr: S.haErr,
    tvs: waiters.length, key: key(), host: process.env.HOSTNAME || '' };   // в HA имя контейнера = имя дополнения (9a2b6b82-arctv)
}

module.exports = { event, ring, end, wait, view, command, snapshot, check, status, keyOk, key, frame: () => (S.active ? S.frame : null), S };
