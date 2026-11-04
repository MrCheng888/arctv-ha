'use strict';
// Плейлисты (0.6.0–0.6.1): скачивание M3U по ссылке и Xtream Codes (player_api.php → M3U).
// Каждый плейлист живёт отдельно: свои группы, Избранное, программа (lib/cache.js, server.js).
const fetch = require('./fetch');

function attrs(head) {
  const out = {};
  const re = /([A-Za-z0-9_\-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(head)) !== null) { out[m[1].toLowerCase()] = m[2]; }
  return out;
}

const clean = (v) => String(v == null ? '' : v).replace(/["\r\n]/g, "'").trim();

function enabled(list) { return (list || []).filter((s) => s.on); }

// Короткое имя по адресу: http://pl.cbilling.tv/… → cbilling
function hostName(url) {
  try {
    const h = new URL(url).hostname;
    if (/^[\d.]+$/.test(h) || h.indexOf(':') >= 0) { return ''; }
    const p = h.split('.').filter((x) => x && x !== 'www');
    return (p.length >= 2 ? p[p.length - 2] : p[0] || '').slice(0, 20);
  } catch (e) { return ''; }
}

// ----- Xtream Codes: список каналов через player_api.php, превращаем в M3U -----
function xtBase(src) {
  let b = String(src.url || '').trim().replace(/\/+$/, '').replace(/\/(player_api|get|xmltv)\.php.*$/, '');
  if (b && !/^https?:\/\//i.test(b)) { b = 'http://' + b; }
  return b;
}

async function xtJson(url) {
  const t = await fetch.text(url, { timeout: 30000 });
  try { return JSON.parse(t); } catch (e) { throw new Error('ответ не JSON (это точно Xtream?)'); }
}

async function xtream(src) {
  const base = xtBase(src);
  if (!base) { throw new Error('не задан адрес'); }
  const u = encodeURIComponent(src.user || ''), p = encodeURIComponent(src.pass || '');
  const api = base + '/player_api.php?username=' + u + '&password=' + p;
  const info = await xtJson(api);
  if (!info || !info.user_info || String(info.user_info.auth) === '0') { throw new Error('неверный логин или пароль'); }
  const cats = await xtJson(api + '&action=get_live_categories');
  const streams = await xtJson(api + '&action=get_live_streams');
  if (!Array.isArray(streams)) { throw new Error('нет списка каналов'); }
  const cat = new Map((Array.isArray(cats) ? cats : []).map((c) => [String(c.category_id), c.category_name || '']));
  const list = streams.map((s, i) => ({ s, i })).sort((a, b) => ((+a.s.num || 0) - (+b.s.num || 0)) || (a.i - b.i));
  // архив Xtream (timeshift: длительность в минутах, время провайдера) пока не включаем —
  // нужна доработка приложения; сделаем, когда будет настоящий провайдер
  const out = ['#EXTM3U url-tvg="' + base + '/xmltv.php?username=' + u + '&password=' + p + '"'];
  for (const { s } of list) {
    if (s.stream_id === undefined || s.stream_id === null) { continue; }
    out.push('#EXTINF:-1 tvg-id="' + clean(s.epg_channel_id) + '" tvg-name="' + clean(s.name) + '" tvg-logo="' + clean(s.stream_icon) +
      '" group-title="' + clean(cat.get(String(s.category_id)) || 'Без группы') + '",' + clean(s.name).replace(/,/g, ' '));
    out.push(base + '/live/' + u + '/' + p + '/' + encodeURIComponent(s.stream_id) + '.m3u8');
  }
  return out.join('\n') + '\n';
}

// Скачать плейлист источника (текст M3U)
async function download(src) {
  if (src.type === 'xtream') { return xtream(src); }
  if (!src.url) { throw new Error('не задан адрес'); }
  return fetch.text(src.url, { timeout: 30000 });
}

// Программа по заголовку плейлиста: url-tvg (бывает несколько через запятую)
function headerEpg(text) {
  const first = String(text || '').slice(0, 4000).split(/\r?\n/).find((l) => l.trim().startsWith('#EXTM3U'));
  if (!first) { return []; }
  const a = attrs(first), v = a['url-tvg'] || a['x-tvg-url'] || '';
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

module.exports = { enabled, hostName, download, headerEpg };
