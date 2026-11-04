'use strict';
// Хранение на диске (папка /data в контейнере): настройки, телевизоры, Избранное и сохранения, кэш.
const fs = require('fs');
const path = require('path');
const { hostName } = require('./sources');
const holidays = require('./holidays');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });

const file = (name) => path.join(DIR, name);

// Запись через временный файл: при сбое питания старый файл остаётся целым
function writeAtomic(name, data) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file(name));
}

function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return def; }
}

function readText(name) {
  try { return fs.readFileSync(file(name), 'utf8'); } catch (e) { return null; }
}

function remove(name) {
  try { fs.unlinkSync(file(name)); } catch (e) { /* нет файла — и не надо */ }
}

function readBuf(name) {
  try { return fs.readFileSync(file(name)); } catch (e) { return null; }
}

// ----- настройки -----
// Имена — как в js/config.js приложения. Три вида:
//   SOURCE_KEYS — источники, только на странице сервера (адрес плейлиста телевизору не передаётся);
//   COMMON_KEYS — общие для всех телевизоров, меняются и на странице, и в Tools на телевизоре;
//   DEVICE_KEYS — свои у каждого телевизора (значения здесь — по умолчанию для новых телевизоров).
// Для общих и своих настроек хранится время изменения: при расхождении побеждает последнее изменение.
const DEFAULTS = {
  // Плейлисты (0.6.0–0.6.1): [{id, name, type: 'm3u' | 'xtream', url, user, pass, on, epg: [адреса программы]}].
  // id постоянный и не повторяется. У каждого плейлиста свои группы, Избранное, программа, настройки групп (PL).
  SOURCES: [],
  PLAYLIST_URL: '',            // до 0.6.0: адрес плейлиста (переносится в SOURCES, дальше не используется)
  EPG_URL: '',                 // до 0.6.0: адрес программы (переносится в программу плейлиста)
  REFRESH_HOURS: 6,            // как часто сервер обновляет плейлисты и программу
  EPG_PAST_HOURS: 24,          // прошлое для каналов без архива
  EPG_FUTURE_HOURS: 36,        // будущее
  ADULT_KEYWORDS: ['взросл', '18+'],
  EPG_SHIFT_MIN: 0,            // сдвиг времени программы передач, минут (+ позже, − раньше)
  ADULT_PIN: '0000',
  ARCHIVE_STEP_SEC: 120,       // шаг перемотки одним нажатием влево/вправо
  ARCHIVE_BIG_STEP_SEC: 600,   // быстрая перемотка: удержание влево/вправо, RW/FF
  LIVE_EDGE_SEC: 30,
  START_BUFFER_SEC: 2,
  START_LOW_BITRATE: false,
  ZAP_DELAY_MS: 400,
  CHLIST_HIDE_SEC: 20,
  ACCENT: 'crimson',           // цвет оформления на телевизоре
  OVERLAY_OPACITY: 75,         // непрозрачность окон, %; заголовок окна на 10 плотнее
  HOLIDAYS: []                 // значки праздников (0.6.8): правила дат, lib/holidays.js; время изменения — _holAt
};
// Свои у каждого плейлиста (settings.PL[id]); до 0.6.1 были общими — переносятся в плейлист № 1
const PL_DEFAULTS = {
  CLOSED_GROUPS: [],           // группы, закрытые вручную (кроме закрытых по словам)
  EXT_GROUPS: [],              // расширенные группы (видны в расширенном режиме), только вручную
  HIDDEN_GROUPS: [],           // скрытые группы — телевизорам не отдаются вовсе
  HIDDEN_CHANNELS: [],         // скрытые каналы (ключ tvg-id|название) — телевизорам не отдаются
  GROUP_ORDER: [],             // свой порядок групп (названия); остальные — после, в порядке плейлиста
  CHANNEL_ORDER: {},           // свой порядок каналов: {группа: [ключи]}; новые каналы — в конце группы
  GROUP_NAMES: {}              // свои имена групп (0.7.2): {имя у провайдера: своё}; остальные настройки — по имени провайдера
};
const PL_KEYS = Object.keys(PL_DEFAULTS);
const SOURCE_KEYS = ['SOURCES', 'REFRESH_HOURS', 'EPG_PAST_HOURS', 'EPG_FUTURE_HOURS', 'ADULT_KEYWORDS', 'HOLIDAYS'];
const COMMON_KEYS = ['EPG_SHIFT_MIN', 'ADULT_PIN', 'ARCHIVE_STEP_SEC', 'ARCHIVE_BIG_STEP_SEC', 'LIVE_EDGE_SEC'];
const DEVICE_KEYS = ['START_BUFFER_SEC', 'START_LOW_BITRATE', 'ZAP_DELAY_MS', 'CHLIST_HIDE_SEC', 'ACCENT', 'OVERLAY_OPACITY'];
// источники, которые нужны телевизору как запасной путь без сервера (группы и программа — по плейлистам, server.js)
const TV_SOURCE_KEYS = ['EPG_PAST_HOURS', 'EPG_FUTURE_HOURS', 'ADULT_KEYWORDS'];
const ACCENTS = ['crimson', 'blue', 'teal', 'green', 'orange', 'violet'];
const TYPES = Object.assign({}, DEFAULTS, PL_DEFAULTS);

const LIMITS = {
  REFRESH_HOURS: [1, 48], EPG_PAST_HOURS: [1, 168], EPG_FUTURE_HOURS: [6, 240], EPG_SHIFT_MIN: [-720, 720, 5],
  ARCHIVE_STEP_SEC: [30, 300, 30], ARCHIVE_BIG_STEP_SEC: [60, 600, 60], LIVE_EDGE_SEC: [5, 300, 5],
  START_BUFFER_SEC: [1, 30], ZAP_DELAY_MS: [0, 2000], CHLIST_HIDE_SEC: [5, 120], OVERLAY_OPACITY: [50, 95, 5]
};

const urlList = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim().slice(0, 2000)).filter(Boolean).slice(0, 10);

// Проверенное значение настройки или undefined
function cleanValue(k, v) {
  const def = TYPES[k];
  if (def === undefined) { return undefined; }
  if (k === 'SOURCES') {                             // [{id, name, type, url, user, pass, on, epg}]
    if (!Array.isArray(v)) { return undefined; }
    const ids = new Set(), names = new Set(), out = [];
    for (const x of v.slice(0, 20)) {
      if (!x || typeof x !== 'object') { continue; }
      let id = Math.floor(+x.id || 0);
      if (!(id > 0) || ids.has(id)) { id = 0; }          // новый — номер даст saveSettings
      if (id) { ids.add(id); }
      const type = x.type === 'xtream' ? 'xtream' : 'm3u';
      let name = String(x.name || '').replace(/[\t\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
      if (!name) { name = 'Плейлист'; }
      // имена разные: по ним плейлисты различают на телевизоре
      let nm = name, n = 2;
      while (names.has(nm.toLowerCase())) { nm = (name.slice(0, 17) + ' ' + n++).trim(); }
      names.add(nm.toLowerCase());
      out.push({ id, name: nm, type, url: String(x.url || '').trim().slice(0, 2000),
        user: type === 'xtream' ? String(x.user || '').trim().slice(0, 200) : '',
        pass: type === 'xtream' ? String(x.pass || '').slice(0, 200) : '', on: x.on !== false && x.on !== 'false',
        epg: urlList(x.epg),
        // открытая ссылка для других плееров (0.6.2), по умолчанию выключена
        share: x.share === true || x.share === 'true',
        // в плейлисте для других плееров — программа провайдера вместо программы с сервера (0.6.3)
        epgProv: x.epgProv === true || x.epgProv === 'true' });
    }
    return out;
  }
  if (k === 'HOLIDAYS') { return holidays.clean(v); }
  if (k === 'GROUP_NAMES') {                         // {имя у провайдера: своё имя}; пустое или то же — не храним
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
    const o = {};
    for (const g of Object.keys(v).slice(0, 1000)) {
      const n = String(v[g] == null ? '' : v[g]).replace(/[\t\r\n"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (n && n !== g) { o[String(g).slice(0, 300)] = n; }
    }
    return o;
  }
  if (k === 'CHANNEL_ORDER') {                       // {группа: [ключи каналов]}
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return undefined; }
    const o = {};
    for (const g of Object.keys(v).slice(0, 500)) {
      if (Array.isArray(v[g]) && v[g].length) { o[String(g).slice(0, 300)] = v[g].slice(0, 3000).map((x) => String(x).slice(0, 300)); }
    }
    return o;
  }
  if (typeof def === 'number') {
    v = Math.round(Number(v));
    if (!isFinite(v)) { return undefined; }
    const l = LIMITS[k];
    if (!l) { return v; }
    if (l[2]) { v = Math.round(v / l[2]) * l[2]; }      // до шага (30 с, 1 мин, 5 с, 5 %)
    return Math.max(l[0], Math.min(l[1], v));
  }
  if (typeof def === 'boolean') { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }
  if (Array.isArray(def)) {
    const names = k !== 'ADULT_KEYWORDS';
    if (typeof v === 'string') { v = names ? v.split('\n') : v.split(','); }
    if (!Array.isArray(v)) { return undefined; }
    // названия групп — как в плейлисте; слова взрослых групп — строчными
    return v.map((x) => (names ? String(x).trim().slice(0, 300) : String(x).trim().toLowerCase())).filter(Boolean);
  }
  v = String(v == null ? '' : v).trim();
  if (k === 'ADULT_PIN' && !/^\d{4,8}$/.test(v)) { return undefined; }
  if (k === 'ACCENT' && ACCENTS.indexOf(v) < 0) { return undefined; }
  return v;
}

function cleanPl(o) {
  const out = {};
  for (const k of PL_KEYS) {
    const v = o && k in o ? cleanValue(k, o[k]) : undefined;
    out[k] = v === undefined ? JSON.parse(JSON.stringify(PL_DEFAULTS[k])) : v;
  }
  return out;
}

function loadSettings() {
  let s = readJson('settings.json', null);
  const fresh = !s;
  if (fresh) {
    // первый запуск: начальные значения можно передать переменными окружения контейнера
    s = {};
    for (const k of Object.keys(DEFAULTS)) { if (process.env[k] !== undefined) { s[k] = process.env[k]; } }
  }
  const out = { _at: s._at && typeof s._at === 'object' ? s._at : {} };
  for (const k of Object.keys(DEFAULTS)) {
    const v = k in s ? cleanValue(k, s[k]) : undefined;
    out[k] = v === undefined ? JSON.parse(JSON.stringify(DEFAULTS[k])) : v;
  }
  if (s.ADMIN_PASSWORD) { out._legacyPassword = s.ADMIN_PASSWORD; }   // перенос в логин и пароль (lib/auth.js)
  // до 0.6.0 плейлист был один: он становится плейлистом № 1 (ключи каналов прежние), его программа — в плейлист
  if (!('SOURCES' in s)) {
    out.SOURCES = out.PLAYLIST_URL ? [{ id: 1, name: hostName(out.PLAYLIST_URL) || 'Плейлист', type: 'm3u', url: out.PLAYLIST_URL,
      user: '', pass: '', on: true, epg: out.EPG_URL ? [out.EPG_URL] : [] }] : [];
  } else if (Array.isArray(s.EPG_URLS) && s.EPG_URLS.length && out.SOURCES[0] && !out.SOURCES[0].epg.length) {
    out.SOURCES[0].epg = urlList(s.EPG_URLS);            // 0.6.0: программа была общей
  }
  out._holAt = +s._holAt || 0;
  out._srcNext = Math.max(+s._srcNext || 1, ...out.SOURCES.map((x) => x.id + 1));
  // настройки групп: до 0.6.1 общие — теперь у плейлиста № 1 (или первого)
  out.PL = {};
  if (s.PL && typeof s.PL === 'object') {
    for (const id of Object.keys(s.PL)) { out.PL[id] = cleanPl(s.PL[id]); }
  } else {
    const first = out.SOURCES.some((x) => x.id === 1) || !out.SOURCES.length ? 1 : out.SOURCES[0].id;
    out.PL[first] = cleanPl(s);
  }
  return out;
}

let settings = loadSettings();
function writeSettings() {
  const o = Object.assign({}, settings);
  delete o._legacyPassword;
  writeAtomic('settings.json', JSON.stringify(o, null, 2));
}
writeSettings();

function getSettings() { return settings; }

// Настройки групп плейлиста (с умолчаниями)
function plSettings(id) {
  if (!settings.PL[id]) { settings.PL[id] = cleanPl({}); }
  return settings.PL[id];
}

// Номера новым источникам (0 — новый). Номера не повторяются, даже у удалённых.
function numberSources(list) {
  for (const x of list) {
    if (!x.id) { x.id = settings._srcNext++; }
    if (x.id >= settings._srcNext) { settings._srcNext = x.id + 1; }
  }
  return list;
}

// Плейлист удалён: его настройки групп, Избранное и сохранения — тоже
function dropPl(id) {
  delete settings.PL[id];
  writeSettings();
  if (state.fav[id]) { delete state.fav[id]; touch(); }
  const n = state.saves.length;
  state.saves = state.saves.filter((v) => v.pl !== id);
  if (state.saves.length !== n) { touch(); }
}

// Со страницы сервера: источники и общие настройки
// pl — номер плейлиста для его настроек групп (CLOSED_GROUPS и т. д.)
function saveSettings(input, pl) {
  const now = Date.now();
  if (pl) {
    const p = plSettings(pl);
    for (const k of PL_KEYS) {
      if (!(k in input)) { continue; }
      const v = cleanValue(k, input[k]);
      if (v !== undefined) { p[k] = v; }
    }
  }
  for (const k of SOURCE_KEYS.concat(COMMON_KEYS)) {
    if (!(k in input)) { continue; }
    let v = cleanValue(k, input[k]);
    if (v === undefined) { continue; }
    if (k === 'SOURCES') { v = numberSources(v); }
    if (JSON.stringify(v) !== JSON.stringify(settings[k])) {
      settings[k] = v;
      if (COMMON_KEYS.indexOf(k) >= 0) { settings._at[k] = now; }
      if (k === 'HOLIDAYS') { settings._holAt = now; }   // телевизоры заберут новый календарь
    }
  }
  writeSettings();
  return settings;
}

// ----- телевизоры -----
// devices.json: dev -> {name, model, ip, ver, seen, set: {свои настройки}, at: {время изменения}}
let devices = readJson('devices.json', {});
// Плейлист отдаётся только разрешённым телевизорам. Телевизоры, которые уже были в списке до 0.5.6, — разрешены.
for (const id of Object.keys(devices)) { if (devices[id].allowed === undefined) { devices[id].allowed = true; } }
let devTimer = null;
function saveDevices(now) {
  if (now) { if (devTimer) { clearTimeout(devTimer); devTimer = null; } writeAtomic('devices.json', JSON.stringify(devices, null, 2)); return; }
  if (!devTimer) { devTimer = setTimeout(() => { devTimer = null; writeAtomic('devices.json', JSON.stringify(devices, null, 2)); }, 3000); }
}

function device(dev) {
  let d = devices[dev];
  if (!d) {
    d = devices[dev] = { name: '', model: '', ip: '', ver: '', seen: 0, allowed: false, set: {}, at: {} };
    for (const k of DEVICE_KEYS) { d.set[k] = settings[k]; d.at[k] = 0; }   // по умолчанию — как для новых
    saveDevices(true);
  }
  for (const k of DEVICE_KEYS) { if (!(k in d.set)) { d.set[k] = settings[k]; d.at[k] = 0; } }
  return d;
}

function seenDevice(dev, info) {
  const d = device(dev);
  Object.assign(d, { ip: info.ip || d.ip, model: info.model || d.model, ver: info.ver || d.ver, seen: Date.now() });
  saveDevices(false);
  return d;
}

// Разрешён ли телевизору плейлист (новые — после «Разрешить» на странице сервера)
// Можно ли этому телевизору закрытые группы (по умолчанию — да)
function closedAllowed(dev) { return !(dev && devices[dev] && devices[dev].closedAllowed === false); }
// Расширенные группы этому телевизору (0.7.2): по умолчанию да; меняется только на странице сервера
function extAllowed(dev) { return !(dev && devices[dev] && devices[dev].extAllowed === false); }

function isAllowed(dev) { return !!(dev && devices[dev] && devices[dev].allowed); }

function listDevices() {
  return Object.keys(devices).map((id) => Object.assign({ id }, devices[id])).sort((a, b) => b.seen - a.seen);
}

// Настройки для телевизора: источники для запасного пути, общие, свои; и время изменения каждой
function deviceConfig(dev) {
  const d = device(dev), config = {}, stamps = {};
  for (const k of TV_SOURCE_KEYS) { config[k] = settings[k]; }
  for (const k of COMMON_KEYS) { config[k] = settings[k]; stamps[k] = settings._at[k] || 0; }
  for (const k of DEVICE_KEYS) { config[k] = d.set[k]; stamps[k] = d.at[k] || 0; }
  // закрытые группы на этом телевизоре (меняется только на странице сервера)
  config.CLOSED_ALLOWED = d.closedAllowed !== false;
  config.EXT_ALLOWED = d.extAllowed !== false;          // расширенные группы (0.7.2)
  return { config, stamps, name: d.name };
}

// Изменения из Tools на телевизоре: {key: {v, at}}. Побеждает более позднее изменение.
function applyTvChanges(dev, changes) {
  const d = device(dev);
  let common = false, own = false;
  for (const k of Object.keys(changes || {})) {
    const c = changes[k], at = +(c && c.at) || 0, v = cleanValue(k, c && c.v);
    if (v === undefined || !at) { continue; }
    if (k === 'ADULT_PIN') { continue; }               // PIN меняется только на странице сервера
    if (COMMON_KEYS.indexOf(k) >= 0 && at > (settings._at[k] || 0)) { settings[k] = v; settings._at[k] = at; common = true; }
    else if (DEVICE_KEYS.indexOf(k) >= 0 && at > (d.at[k] || 0)) { d.set[k] = v; d.at[k] = at; own = true; }
  }
  if (common) { writeSettings(); }
  if (own) { saveDevices(true); }
  return deviceConfig(dev);
}

// Со страницы сервера: имя телевизора и его свои настройки, или удалить
function saveDevice(dev, input) {
  if (!devices[dev]) { return null; }
  const d = device(dev), now = Date.now();
  if (input.remove) { delete devices[dev]; saveDevices(true); return true; }
  if (typeof input.name === 'string') { d.name = input.name.trim().slice(0, 40); }
  if (typeof input.allow === 'boolean') { d.allowed = input.allow; }
  if (typeof input.closedAllowed === 'boolean') { d.closedAllowed = input.closedAllowed; }
  if (typeof input.extAllowed === 'boolean') { d.extAllowed = input.extAllowed; }
  for (const k of DEVICE_KEYS) {
    if (!input.set || !(k in input.set)) { continue; }
    const v = cleanValue(k, input.set[k]);
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(d.set[k])) { d.set[k] = v; d.at[k] = now; }
  }
  saveDevices(true);
  return d;
}

// ----- Избранное и сохранения (общие для всех телевизоров) -----
// favorites: ключи «tvg-id|название» по порядку добавления
// saves: сохранённые синей кнопкой места, новые первыми:
//   {id, ck (ключ канала), ch («12 Канал»), t (передача), ps, pe (её начало и конец), pos (сохранённая минута),
//    rec (глубина архива канала, дней), at (когда сохранено, мс)}
const SAVES_MAX = 100;
// fav: {номер плейлиста: [ключи]} (с 0.6.1; до этого одно Избранное — теперь у плейлиста № 1 или первого)
let state = readJson('state.json', { rev: 0, fav: {}, saves: [] });
if (!state.fav || typeof state.fav !== 'object') {
  const first = settings.SOURCES.some((x) => x.id === 1) || !settings.SOURCES.length ? 1 : settings.SOURCES[0].id;
  state.fav = {};
  if (Array.isArray(state.favorites) && state.favorites.length) { state.fav[first] = state.favorites; }
  delete state.favorites;
  // сохранения тоже были одного плейлиста
  for (const v of Array.isArray(state.saves) ? state.saves : []) { if (v && !v.pl) { v.pl = first; } }
}
if (!Array.isArray(state.saves)) { state.saves = []; }
delete state.positions;   // автосохранение позиций из 0.3.0–0.3.1 больше не используется

let saveTimer = null;
function touch() {
  state.rev = (state.rev || 0) + 1;
  state.updated = Date.now();
  // несколько изменений подряд пишутся на диск одним разом
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = null; writeAtomic('state.json', JSON.stringify(state)); }, 500);
  }
}
function flush() {
  if (devTimer) { saveDevices(true); }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeAtomic('state.json', JSON.stringify(state)); }
}

// Сохранение живёт, пока его место есть в архиве канала; всего не больше SAVES_MAX
function pruneSaves() {
  const now = Math.floor(Date.now() / 1000);
  const before = state.saves.length;
  state.saves = state.saves.filter((v) => v && v.pos && v.pos >= now - (v.rec > 0 ? v.rec : 7) * 86400);
  if (state.saves.length > SAVES_MAX) { state.saves.length = SAVES_MAX; }
  if (state.saves.length !== before) { touch(); }
}

function getState() { pruneSaves(); return state; }

function favOf(pl) { return state.fav[pl] || []; }

function changeFavorites(pl, add, remove) {
  let changed = false;
  const list = state.fav[pl] || (state.fav[pl] = []);
  for (const k of remove || []) {
    const i = list.indexOf(k);
    if (i >= 0) { list.splice(i, 1); changed = true; }
  }
  for (const k of add || []) {
    if (typeof k === 'string' && k && list.indexOf(k) < 0) { list.push(k); changed = true; }
  }
  if (changed) { touch(); }
  return changed;
}

function addSave(v) {
  if (!v || typeof v.id !== 'string' || !v.id || !v.ck || !(+v.pos > 0)) { return false; }
  if (state.saves.some((x) => x.id === v.id)) { return false; }
  state.saves.unshift({
    id: v.id.slice(0, 40), ck: String(v.ck).slice(0, 300), ch: String(v.ch || '').slice(0, 200),
    t: String(v.t || '').slice(0, 200), ps: Math.floor(+v.ps || 0), pe: Math.floor(+v.pe || 0),
    pos: Math.floor(+v.pos), rec: Math.floor(+v.rec || 0), at: Math.floor(+v.at || Date.now()), pl: Math.floor(+v.pl || 0)
  });
  state.saves.sort((a, b) => b.at - a.at);
  if (state.saves.length > SAVES_MAX) { state.saves.length = SAVES_MAX; }
  touch();
  return true;
}

function removeSave(id) {
  const n = state.saves.length;
  state.saves = state.saves.filter((x) => x.id !== id);
  if (state.saves.length === n) { return false; }
  touch();
  return true;
}

module.exports = {
  DIR, writeAtomic, readText, readBuf, readJson, remove,
  getSettings, saveSettings, plSettings, dropPl, PL_KEYS, SOURCE_KEYS, COMMON_KEYS, DEVICE_KEYS, ACCENTS,
  seenDevice, listDevices, isAllowed, closedAllowed, extAllowed, deviceConfig, applyTvChanges, saveDevice,
  getState, favOf, changeFavorites, addSave, removeSave, flush
};
