'use strict';
// Камеры (0.8.1; поток кадров для медленных камер — 0.8.4): плитка «Камеры» на телевизорах — картинки с домашних камер через Home Assistant.
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

// Поток кадров (0.8.4). Снимок camera_proxy у некоторых камер идёт 3–5 с (сад, Dahua IPC-HFW1230S:
// 510 КБ за 3,3–5,5 с — 1 кадр в 3–4 с на ТВ). Поэтому, пока камеру смотрят, сервер держит открытым
// MJPEG-поток HA (/camera_proxy_stream: у ONVIF — ffmpeg из RTSP, ~25 кадров/с после ~3,5 с разгона)
// и отдаёт телевизорам последний кадр. Никто не спрашивает кадр STREAM_IDLE_MS — поток закрывается.
// Пока поток разгоняется или если он не работает — как раньше, снимок.
const STREAM_IDLE_MS = 8000;    // поток закрывается, если кадры не спрашивали столько времени
const STREAM_FRESH_MS = 3000;   // кадр из потока старше — не годится, берём снимок
const STREAM_RETRY_MS = 30000;
const STREAM_WARM_MS = 8000;   // столько ждём первый кадр потока, отдавая прежний снимок  // поток оборвался с ошибкой — снова пробуем не раньше чем через столько

function streamOpen(ent, c) {
  if (c.stream || Date.now() < (c.streamFailAt || 0) + STREAM_RETRY_MS) { return; }
  const ctl = new AbortController();
  const st = c.stream = { ctl, used: Date.now(), at: Date.now(), frames: 0 };
  const idle = setInterval(() => { if (Date.now() - st.used > STREAM_IDLE_MS) { ctl.abort(); } }, 1000);
  (async () => {
    const r = await fetch(BASE + '/camera_proxy_stream/' + encodeURIComponent(ent), {
      headers: { Authorization: 'Bearer ' + TOKEN() }, signal: ctl.signal
    });
    if (!r.ok) { throw new Error('поток: Home Assistant ответил ' + r.status); }
    let buf = Buffer.alloc(0);
    for await (const chunk of r.body) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      // кадры JPEG в потоке: от FF D8 до FF D9; берём все целые, держим последний
      for (;;) {
        const s = buf.indexOf(SOI);
        if (s < 0) { buf = buf.length > 3 ? buf.subarray(buf.length - 3) : buf; break; }
        const e = buf.indexOf(EOI, s + 2);
        if (e < 0) { if (s > 0) { buf = buf.subarray(s); } break; }
        c.sbuf = Buffer.from(buf.subarray(s, e + 2)); c.sat = Date.now(); st.frames++;
        buf = buf.subarray(e + 2);
      }
      if (buf.length > 8 * 1024 * 1024) { buf = Buffer.alloc(0); }   // мусор вместо JPEG — не копим
    }
  })().catch((e) => {
    if (!ctl.signal.aborted) { c.streamFailAt = Date.now(); c.streamErr = e.message; }
  }).finally(() => { clearInterval(idle); if (c.stream === st) { c.stream = null; } });
}
const SOI = Buffer.from([0xff, 0xd8, 0xff]), EOI = Buffer.from([0xff, 0xd9]);

function snapshot(ent, c) {
  if (c.buf && Date.now() - c.at < frameMs() * 0.8) { return Promise.resolve(c.buf); }
  if (!c.inflight) {
    const t0 = Date.now();
    c.inflight = ha('/camera_proxy/' + encodeURIComponent(ent), true)
      .then((b) => {
        c.buf = b; c.at = Date.now(); c.snapMs = c.at - t0; c.inflight = null;
        if (c.snapMs > SLOW_SNAP_MS) { streamOpen(ent, c); }   // медленный снимок — сразу открываем поток
        return b;
      })
      .catch((e) => { c.inflight = null; throw e; });
  }
  return c.inflight;
}

// Кадр камеры: из потока, если он свежий; иначе снимок (один полёт в HA на всех ждущих, кэш под частоту).
// Поток — только для камер с медленным снимком (дольше SLOW_SNAP_MS): у быстрых (вход, ~0,3 с) хватает
// снимков, и HA не гоняет ffmpeg зря.
const SLOW_SNAP_MS = 1000;
function frame(ent) {
  const c = cache[ent] || (cache[ent] = { buf: null, at: 0, inflight: null });
  if (c.stream || c.snapMs > SLOW_SNAP_MS) { streamOpen(ent, c); }
  if (c.stream) { c.stream.used = Date.now(); }
  if (c.sbuf && Date.now() - c.sat < STREAM_FRESH_MS) { return Promise.resolve(c.sbuf); }
  // поток разгоняется (~3,5 с) — отдаём прежний снимок, не заказывая новый медленный
  if (c.stream && !c.stream.frames && c.buf && Date.now() - c.stream.at < STREAM_WARM_MS) { return Promise.resolve(c.buf); }
  return snapshot(ent, c);
}

// Камера по номеру в списке включённых (телевизор знает только номер, не сущность)
function entOf(i) { const e = enabled()[+i]; return e ? e.ent : null; }

module.exports = { countFor, tvList, pageList, frame, entOf, haReady, fps };
