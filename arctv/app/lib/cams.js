'use strict';
// Камеры (0.8.1): плитка «Камеры» на телевизорах — картинки с домашних камер через Home Assistant.
// Список сущностей camera.* сервер берёт из HA сам (ничего не добавляется руками): на странице сервера
// в разделе «Камеры» выбирают галочками, какие показывать, дают имена («Вход», «Сад») и порядок.
// Кадры сервер тянет из HA только пока кто-то смотрит: по запросу телевизора, с единым полётом
// (несколько ТВ смотрят одну камеру — кадр из HA берётся один раз) и кэшем под частоту кадров.
// Доступ к HA — как у домофона: собственный доступ дополнения. Без HA (сервер на NAS) камер нет.
const store = require('./store');

const BASE = process.env.HA_API_URL || 'http://supervisor/core/api';
const TOKEN = () => process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const DEAD = ['unavailable', 'unknown'];   // такие состояния HA считаем «офлайн»

const cache = {};   // ent → {buf, at, inflight} — последний кадр камеры

function cfg() { return store.getSettings().CAMS || { fps: 2, items: [] }; }
function haReady() { return !!TOKEN(); }
function fps() { const f = +cfg().fps; return isNaN(f) ? 2 : Math.min(10, Math.max(1, f)); }
function frameMs() { return Math.round(1000 / fps()); }

async function ha(path, raw) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + TOKEN() }, signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) { throw new Error('Home Assistant ответил ' + r.status); }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

// Включённые камеры в порядке настроек
function enabled() { return (cfg().items || []).filter((x) => x.on); }

// Сколько камер показывать этому телевизору (уходит в /api/config как CONFIG.CAMS; 0 — плитки нет)
function countFor(dev) { return haReady() && store.camsAllowed(dev) ? enabled().length : 0; }

// Все camera.* из HA: ent → состояние
async function haStates() {
  const all = await ha('/states');
  const out = {};
  for (const s of all) { if (s.entity_id && s.entity_id.indexOf('camera.') === 0) { out[s.entity_id] = s; } }
  return out;
}

// Список для телевизора: включённые камеры, онлайн/офлайн
async function tvList() {
  const st = await haStates();
  return enabled().map((x, i) => ({ i, name: x.name, online: !!st[x.ent] && DEAD.indexOf(st[x.ent].state) < 0 }));
}

// Список для страницы: сохранённые камеры (в т.ч. пропавшие из HA — missing, их можно удалить),
// затем остальные camera.* из HA; живые выше. Повторы одной камеры от разных интеграций не склеиваются:
// это просто строки без галочки, выбирают рабочую по кнопке «Снимок».
async function pageList() {
  const st = await haStates();
  const items = cfg().items || [], rows = [], seen = {};
  const info = (s) => ({
    state: s ? s.state : null, online: !!s && DEAD.indexOf(s.state) < 0,
    ha: s ? String(s.attributes.friendly_name || '') : '',
    brand: s ? [s.attributes.brand, s.attributes.model_name].filter(Boolean).join(' ') : ''
  });
  for (const x of items) { rows.push(Object.assign({ ent: x.ent, on: !!x.on, name: x.name, saved: true, missing: !st[x.ent] }, info(st[x.ent]))); seen[x.ent] = 1; }
  const rest = Object.keys(st).filter((e) => !seen[e]).sort();
  rest.sort((a, b) => (DEAD.indexOf(st[b].state) < 0 ? 1 : 0) - (DEAD.indexOf(st[a].state) < 0 ? 1 : 0));
  for (const ent of rest) { rows.push(Object.assign({ ent, on: false, name: '', saved: false, missing: false }, info(st[ent]))); }
  return { fps: fps(), ha: haReady(), rows };
}

// Кадр камеры: свежий из кэша, иначе один полёт в HA на всех ждущих
function frame(ent) {
  const c = cache[ent] || (cache[ent] = { buf: null, at: 0, inflight: null });
  if (c.buf && Date.now() - c.at < frameMs() * 0.8) { return Promise.resolve(c.buf); }
  if (!c.inflight) {
    c.inflight = ha('/camera_proxy/' + encodeURIComponent(ent), true)
      .then((b) => { c.buf = b; c.at = Date.now(); c.inflight = null; return b; })
      .catch((e) => { c.inflight = null; throw e; });
  }
  return c.inflight;
}

// Камера по номеру в списке включённых (телевизор знает только номер, не сущность)
function entOf(i) { const e = enabled()[+i]; return e ? e.ent : null; }

module.exports = { countFor, tvList, pageList, frame, entOf, haReady, fps };
