'use strict';
// Потоковый разбор XMLTV (обычный или .gz). Хранится только окно времени, нужное каналам плейлиста.
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const fetch = require('./fetch');

function parseTime(str) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+\-]\d{4})?/.exec(str || '');
  if (!m) { return 0; }
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) / 1000;
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    t -= sign * (parseInt(m[7].slice(1, 3), 10) * 3600 + parseInt(m[7].slice(3, 5), 10) * 60);
  }
  return t;
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return isNaN(code) ? m : String.fromCodePoint(code);
  });
}

const RE_CH = /channel="([^"]*)"/;
const RE_START = /start="([^"]*)"/;
const RE_STOP = /stop="([^"]*)"/;
const RE_TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;
const RE_DESC = /<desc[^>]*>([\s\S]*?)<\/desc>/;

const RE_ID = /\bid="([^"]*)"/;
const RE_DN = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;

// Название канала для сравнения: строчными, ё → е, без HD/FHD/UHD/SD/4K, только буквы и цифры
function normName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/(^|[^a-z0-9])(hd|fhd|uhd|sd|4k)(?=$|[^a-z0-9])/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Блок <channel id=…><display-name>…</display-name></channel>: запоминаем id и, если название совпало
// с каналом плейлиста, — кандидата для поиска по названию
function onChannel(block, ctx) {
  const im = RE_ID.exec(block);
  if (!im) { return; }
  const id = im[1].indexOf('&') >= 0 ? decodeEntities(im[1]) : im[1];
  ctx.seenIds.add(id);
  if (!ctx.names.size) { return; }
  RE_DN.lastIndex = 0;
  let m;
  while ((m = RE_DN.exec(block)) !== null) {
    const list = ctx.names.get(normName(decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, ''))));
    if (list) { ctx.alias.push([id, list]); }
  }
}

// Каналы описаны (они всегда перед передачами) — по названию берём только те каналы плейлиста,
// чьего tvg-id в этом файле нет; один канал плейлиста — к одному каналу программы
function finishChannels(ctx) {
  ctx.chDone = true;
  const used = new Set();
  for (const [id, list] of ctx.alias) {
    for (const t of list) {
      if (used.has(t.out) || (t.orig && ctx.seenIds.has(t.orig))) { continue; }
      used.add(t.out);
      let arr = ctx.ids.get(id);
      if (!arr) { arr = []; ctx.ids.set(id, arr); }
      if (!arr.some((x) => x.out === t.out)) { arr.push(t); ctx.byName++; }
    }
  }
  ctx.alias = [];
}

// Разбирает накопленный текст, возвращает необработанный хвост
function consume(buf, ctx) {
  let pos = 0;
  while (!ctx.chDone) {
    const i = buf.indexOf('<channel', pos), p = buf.indexOf('<programme', pos);
    if (p >= 0 && (i < 0 || p < i)) { finishChannels(ctx); pos = p; break; }
    if (i < 0) { return buf.length - pos > 20 ? buf.slice(buf.length - 20) : buf.slice(pos); }
    const j = buf.indexOf('</channel>', i);
    if (j < 0) { return buf.slice(i); }
    onChannel(buf.slice(i, j), ctx);
    pos = j + 10;
  }
  for (;;) {
    const i = buf.indexOf('<programme', pos);
    if (i < 0) { return buf.length - pos > 20 ? buf.slice(buf.length - 20) : buf.slice(pos); }
    const j = buf.indexOf('</programme>', i);
    if (j < 0) { return buf.slice(i); }
    pos = j + 12;
    ctx.total++;
    const gt = buf.indexOf('>', i);
    const head = buf.slice(i, gt);
    let ch = RE_CH.exec(head);
    if (!ch) { continue; }
    ch = ch[1].indexOf('&') >= 0 ? decodeEntities(ch[1]) : ch[1];
    const outs = ctx.ids.get(ch);
    if (outs === undefined) { continue; }
    const s0 = RE_START.exec(head), e0 = RE_STOP.exec(head);
    if (!s0 || !e0) { continue; }
    const s = parseTime(s0[1]), e = parseTime(e0[1]);
    if (!s || !e || s > ctx.to) { continue; }
    const body = buf.slice(gt, j);
    let title = null, desc = null;
    for (const t of outs) {
      if (e < t.from) { continue; }
      if (title === null) {
        const tm = RE_TITLE.exec(body);
        title = tm ? decodeEntities(tm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
        // описание передачи — отдельно, телевизор запрашивает его по одной передаче (кнопка Info)
        const dm = RE_DESC.exec(body);
        desc = dm ? decodeEntities(dm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
      }
      if (desc) {
        let dd = ctx.desc.get(t.out);
        if (!dd) { dd = {}; ctx.desc.set(t.out, dd); }
        dd[s] = desc;
      }
      let arr = ctx.data.get(t.out);
      if (!arr) { arr = []; ctx.data.set(t.out, arr); }
      arr.push([s, e, title]);
    }
  }
}

// targets — [{out, orig, name, rec}]: out — tvg-id канала в плейлисте для телевизора, orig — tvg-id у провайдера,
// name — название (поиск по названию, если tvg-id в программе нет). Возвращает
// {data: Map(out -> [[s,e,t]]), desc, total, kept, byName}
async function load(url, targets, opt) {
  const now = Math.floor(Date.now() / 1000);
  const baseFrom = now - (opt.pastHours || 24) * 3600;
  const ctx = { ids: new Map(), names: new Map(), seenIds: new Set(), alias: [], chDone: false, byName: 0,
    data: new Map(), desc: new Map(), to: now + (opt.futureHours || 36) * 3600, total: 0 };
  const byOut = new Map();
  for (const c of targets) {
    if (!c.out) { continue; }
    const from = c.rec > 0 ? Math.min(baseFrom, now - c.rec * 86400) : baseFrom;
    const t = byOut.get(c.out);
    if (t) { t.from = Math.min(t.from, from); continue; }
    const n = { out: c.out, orig: c.orig || '', from };
    byOut.set(c.out, n);
    if (n.orig) {
      let arr = ctx.ids.get(n.orig);
      if (!arr) { arr = []; ctx.ids.set(n.orig, arr); }
      arr.push(n);
    }
    const nn = normName(c.name);
    if (nn && opt.byName !== false) {
      let arr = ctx.names.get(nn);
      if (!arr) { arr = []; ctx.names.set(nn, arr); }
      arr.push(n);
    }
  }
  if (!byOut.size) { throw new Error('В плейлисте нет каналов для программы'); }

  const src = await fetch.openP(url, { timeout: opt.timeout || 120000 });
  // ход скачивания: байты исходного ответа и его длина (если провайдер её сообщил)
  if (opt.onProgress) {
    const total = parseInt((src.headers && src.headers['content-length']) || '0', 10) || 0;
    let got = 0;
    (src.raw || src).on('data', (c) => { got += c.length; opt.onProgress(got, total); });
  }
  const dec = new StringDecoder('utf8');
  let rest = '', first = true, inflater = null;

  await new Promise((resolve, reject) => {
    const onText = (chunk) => { rest = consume(rest + dec.write(chunk), ctx); };
    src.on('error', reject);
    src.on('data', (chunk) => {
      if (first) {
        first = false;
        // файл .gz, который сервер отдал без Content-Encoding
        if (chunk.length > 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
          inflater = zlib.createGunzip();
          inflater.on('data', onText);
          inflater.on('error', reject);
          inflater.on('end', () => { rest = consume(rest + dec.end(), ctx); resolve(); });
        }
      }
      if (inflater) { inflater.write(chunk); } else { onText(chunk); }
    });
    src.on('end', () => {
      if (inflater) { inflater.end(); } else { rest = consume(rest + dec.end(), ctx); resolve(); }
    });
  });

  let kept = 0;
  for (const arr of ctx.data.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    // убираем повторы (один канал в нескольких местах программы)
    for (let k = arr.length - 1; k > 0; k--) { if (arr[k][0] === arr[k - 1][0]) { arr.splice(k, 1); } }
    kept += arr.length;
  }
  return { data: ctx.data, desc: ctx.desc, total: ctx.total, kept, byName: ctx.byName };
}

// Текст для телевизора: строка на канал «tvgId<TAB>JSON-массив [[s,e,t],...]».
// Телевизор разбирает его по строкам порциями, не замирая.
function toLines(data, from, to) {
  const out = [];
  for (const [id, arr] of data) {
    const part = from || to ? arr.filter((p) => p[1] > (from || 0) && p[0] < (to || Infinity)) : arr;
    if (part.length) { out.push(id.replace(/[\t\n]/g, ' ') + '\t' + JSON.stringify(part)); }
  }
  return out.join('\n');
}

function fromLines(text) {
  const data = new Map();
  for (const line of text.split('\n')) {
    const t = line.indexOf('\t');
    if (t < 0) { continue; }
    try { data.set(line.slice(0, t), JSON.parse(line.slice(t + 1))); } catch (e) { /* пропускаем битую строку */ }
  }
  return data;
}

// XMLTV для других плееров (0.6.2): channels — Map(tvg-id → название), data/desc — программа и описания плейлиста,
// shift — сдвиг программы, секунд (EPG_SHIFT_MIN — как на телевизоре)
function toXmltv(channels, data, desc, shift) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const t = (sec) => {
    const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ' +0000';
  };
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="ArcTV">'];
  for (const [id, name] of channels) { if (data.has(id)) { out.push('<channel id="' + x(id) + '"><display-name>' + x(name) + '</display-name></channel>'); } }
  for (const id of channels.keys()) {
    const arr = data.get(id), dd = desc.get(id) || {};
    if (!arr) { continue; }
    for (const p of arr) {
      out.push('<programme start="' + t(p[0] + shift) + '" stop="' + t(p[1] + shift) + '" channel="' + x(id) + '"><title>' + x(p[2]) + '</title>' +
        (dd[p[0]] ? '<desc>' + x(dd[p[0]]) + '</desc>' : '') + '</programme>');
    }
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}

module.exports = { load, toLines, fromLines, parseTime, decodeEntities, normName, toXmltv };
