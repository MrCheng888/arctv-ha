'use strict';
const { decodeEntities } = require('./epg');
// Короткий разбор M3U на сервере: только то, что нужно для отбора программы передач и страницы настроек.
// Правила те же, что в приложении (js/playlist.js).

function attrs(head) {
  const out = {};
  const re = /([A-Za-z0-9_\-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(head)) !== null) { out[m[1].toLowerCase()] = m[2]; }
  return out;
}

function splitExtinf(line) {
  const i = line.indexOf(':');
  const s = i >= 0 ? line.slice(i + 1) : line;
  let inQ = false, cut = -1;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '"') { inQ = !inQ; } else if (ch === ',' && !inQ) { cut = k; break; }
  }
  return { head: cut >= 0 ? s.slice(0, cut) : s, name: (cut >= 0 ? s.slice(cut + 1) : '').trim() };
}

function parse(text) {
  const res = { epgUrl: '', catchupDays: 0, catchupType: '', channels: [] };
  let pending = null, pendingGroup = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { continue; }
    if (line.startsWith('#EXTM3U')) {
      const a = attrs(line);
      res.epgUrl = a['url-tvg'] || a['x-tvg-url'] || '';
      res.catchupType = (a['catchup-type'] || a['catchup'] || '').toLowerCase();
      res.catchupDays = parseInt(a['catchup-days'] || a['tvg-rec'] || '0', 10) || 0;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const p = splitExtinf(line);
      pending = { a: attrs(p.head), name: decodeEntities(p.name) };
      pendingGroup = '';
      continue;
    }
    if (line.startsWith('#EXTGRP:')) { pendingGroup = line.slice(8).trim(); continue; }
    if (line[0] === '#') { continue; }
    if (!pending) { continue; }
    const a = pending.a;
    let rec = parseInt(a['tvg-rec'] || a['catchup-days'] || a['timeshift'] || '0', 10) || 0;
    const cType = (a['catchup'] || a['catchup-type'] || '').toLowerCase();
    if (!rec && res.catchupDays && (cType || res.catchupType) && cType !== 'disabled') { rec = res.catchupDays; }
    res.channels.push({
      num: res.channels.length + 1,
      name: pending.name || a['tvg-name'] || 'Канал',
      group: a['group-title'] || pendingGroup || 'Без группы',
      tvgId: a['tvg-id'] || '',
      logo: a['tvg-logo'] || '',
      rec
    });
    pending = null;
  }
  return res;
}

// Сквозные номера по группам (как на телевизоре): сначала основные группы, потом расширенные, потом
// закрытые; внутри — в порядке плейлиста, каналы группы подряд. kindOf(имя группы) → 'main' | 'ext' | 'closed' | 'hidden'.
// hidden(канал) → true — канал скрыт: номера не получает (num 0, номера остальных сдвигаются), но остаётся на своём месте.
// Возвращает каналы в порядке номеров (с полями num, kind, closed, hid).
function numbered(channels, kindOf, hidden) {
  const groups = [], byName = new Map();
  for (const c of channels) {
    if (!byName.has(c.group)) { const g = { name: c.group, kind: kindOf(c.group), list: [] }; byName.set(c.group, g); groups.push(g); }
    byName.get(c.group).list.push(c);
  }
  const out = [];
  let n = 0;
  for (const kind of ['main', 'ext', 'closed', 'hidden']) {
    for (const g of groups.filter((x) => x.kind === kind)) {
      for (const c of g.list) {
        const o = Object.assign({}, c, { num: 0, kind, closed: kind === 'closed', hid: kind === 'hidden' || !!(hidden && hidden(c)) });
        if (!o.hid) { o.num = ++n; }
        out.push(o);
      }
    }
  }
  return out;
}

// Ключ канала, как в Избранном: tvg-id|название
function chKey(c) { return (c.tvgId || '') + '|' + c.name; }

// Плейлист без некоторых каналов: keep(имя группы, ключ канала) → true/false. Заголовок и прочие строки — как были.
function filterText(text, keep) {
  const out = [];
  let entry = null, group = '', key = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      entry = [raw];
      const p = splitExtinf(line), a = attrs(p.head);
      group = a['group-title'] || '';
      key = (a['tvg-id'] || '') + '|' + (decodeEntities(p.name) || a['tvg-name'] || 'Канал');
      continue;
    }
    if (entry) {
      entry.push(raw);
      if (line.startsWith('#EXTGRP:') && !group) { group = line.slice(8).trim(); }
      if (line && line[0] !== '#') {                 // адрес потока — конец записи канала
        if (keep(group || 'Без группы', key)) { out.push(...entry); }
        entry = null;
      }
      continue;
    }
    out.push(raw);
  }
  return out.join('\n');
}

// Свой порядок: каналы, переставленные по GROUP_ORDER (группы) и CHANNEL_ORDER ({группа: [ключи]}).
// Группы не из списка — после, в порядке плейлиста; каналы не из списка — в конце своей группы.
function ordered(channels, groupOrder, chOrder) {
  const groups = [], byName = new Map();
  for (const c of channels) {
    if (!byName.has(c.group)) { byName.set(c.group, []); groups.push(c.group); }
    byName.get(c.group).push(c);
  }
  const gRank = new Map((groupOrder || []).map((g, i) => [g, i]));
  const gs = groups.map((g, i) => ({ g, r: gRank.has(g) ? gRank.get(g) : 1e6 + i }));
  gs.sort((a, b) => a.r - b.r);
  const out = [];
  for (const { g } of gs) {
    const list = byName.get(g), ord = (chOrder || {})[g];
    if (ord && ord.length) {
      const r = new Map(ord.map((k, i) => [k, i]));
      const ranked = list.map((c, i) => ({ c, r: r.has(chKey(c)) ? r.get(chKey(c)) : 1e6 + i }));
      ranked.sort((a, b) => a.r - b.r);
      for (const x of ranked) { out.push(x.c); }
    } else { out.push(...list); }
  }
  return out;
}

// Плейлист в своём порядке и без лишних каналов: keep(группа, ключ) → оставить ли; rank(группа, ключ) → [группа, канал]
// для сортировки. Строки до первого канала (заголовок) остаются вверху.
function rebuild(text, keep, rank) {
  const head = [], entries = [];
  let entry = null, n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const p = splitExtinf(line), a = attrs(p.head);
      entry = { lines: [raw], group: a['group-title'] || '', key: (a['tvg-id'] || '') + '|' + (decodeEntities(p.name) || a['tvg-name'] || 'Канал'), n: n++ };
      continue;
    }
    if (entry) {
      entry.lines.push(raw);
      if (line.startsWith('#EXTGRP:') && !entry.group) { entry.group = line.slice(8).trim(); }
      if (line && line[0] !== '#') {
        entry.group = entry.group || 'Без группы';
        if (keep(entry.group, entry.key)) { entry.r = rank(entry.group, entry.key); entries.push(entry); }
        entry = null;
      }
      continue;
    }
    if (!entries.length) { head.push(raw); }
  }
  entries.sort((a, b) => (a.r[0] - b.r[0]) || (a.r[1] - b.r[1]) || (a.n - b.n));
  const out = head.slice();
  for (const e of entries) { out.push(...e.lines); }
  return out.join('\n');
}

// Заменить или дописать атрибут в заголовке строки (#EXTINF:… или #EXTM3U …)
function setAttr(head, k, v) {
  const re = new RegExp('(^|\\s)' + k.replace(/-/g, '\\-') + '="[^"]*"', 'i');
  const val = k + '="' + String(v).replace(/["\r\n]/g, "'") + '"';
  return re.test(head) ? head.replace(re, (m, sp) => sp + val) : head + ' ' + val;
}
function dropAttr(head, k) { return head.replace(new RegExp('\\s' + k.replace(/-/g, '\\-') + '="[^"]*"', 'gi'), ''); }

// Плейлист для других плееров (0.6.2): keep/rank — как в rebuild; chno(группа, ключ) — номер канала (tvg-chno);
// epgUrl — программа с этого сервера (url-tvg в заголовке; адрес программы провайдера убирается)
function exportText(text, keep, rank, chno, epgUrl) {
  const lines = rebuild(text, keep, rank).split('\n'), out = [];
  let hasHead = false, pend = -1, grp = '', key = '', head = '', name = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTM3U')) {
      let h = dropAttr(dropAttr(line.slice(7), 'x-tvg-url'), 'url-tvg');
      if (epgUrl) { h = setAttr(h, 'url-tvg', epgUrl); }
      out.push('#EXTM3U' + h);
      hasHead = true;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const p = splitExtinf(line), a = attrs(p.head);
      pend = out.length; head = p.head; name = p.name; grp = a['group-title'] || '';
      key = (a['tvg-id'] || '') + '|' + (decodeEntities(p.name) || a['tvg-name'] || 'Канал');
      out.push(raw);
      continue;
    }
    if (pend >= 0 && line.startsWith('#EXTGRP:') && !grp) { grp = line.slice(8).trim(); }
    if (pend >= 0 && line && line[0] !== '#') {        // адрес потока — номер канала в его строку #EXTINF
      const n = chno(grp || 'Без группы', key);
      if (n) { out[pend] = '#EXTINF:' + setAttr(head, 'tvg-chno', n) + ',' + name; }
      pend = -1;
    }
    out.push(raw);
  }
  if (!hasHead) { out.unshift('#EXTM3U' + (epgUrl ? ' url-tvg="' + epgUrl + '"' : '')); }
  return out.join('\n') + '\n';
}

// Свои имена групп (0.7.2): names — {имя у провайдера: своё}. Меняет group-title в #EXTINF и строку #EXTGRP.
function applyNames(text, names) {
  if (!names || !Object.keys(names).length) { return text; }
  const lines = text.split('\n');
  let start = -1, group = '', grpLine = -1;
  const fix = (end) => {
    const g = group || 'Без группы', n = names[g];
    if (!n) { return; }
    const p = splitExtinf(lines[start].trim());
    lines[start] = '#EXTINF:' + setAttr(p.head, 'group-title', n) + ',' + p.name;
    if (grpLine >= 0) { lines[grpLine] = '#EXTGRP:' + n; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF')) {
      start = i; grpLine = -1;
      group = attrs(splitExtinf(line).head)['group-title'] || '';
      continue;
    }
    if (start < 0) { continue; }
    if (line.startsWith('#EXTGRP:')) { grpLine = i; if (!group) { group = line.slice(8).trim(); } continue; }
    if (line && line[0] !== '#') { fix(i); start = -1; }
  }
  return lines.join('\n');
}

module.exports = { parse, numbered, filterText, chKey, ordered, rebuild, exportText, applyNames };
