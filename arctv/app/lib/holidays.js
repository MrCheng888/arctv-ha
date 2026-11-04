'use strict';
// Значки праздников (0.6.8): набор рисунков, правила дат, православная Пасха.
// Правило: {kind: 'year' | 'once' | 'easter', d: 'MM-DD' | 'YYYY-MM-DD' | '', off: дни от Пасхи, icon, name, on}
//   year   — каждый год в этот день (d = 'MM-DD');
//   once   — один раз (d = 'YYYY-MM-DD');
//   easter — православная Пасха + off дней (off = 0 — сама Пасха, 49 — Троица, −7 — Вербное воскресенье).
// Телевизор получает правила и рисунки и сам считает, какой сегодня день (тот же расчёт — в js/holidays.js приложения).

// Рисунки 48×48, свои. anim — как значок «оживает» на телевизоре: spin, pulse, swing, float, twinkle.
const ICONS = {
  tree: { title: 'Ёлка', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="21" y="38" width="6" height="7" fill="#8a5a2b"/>' +
    '<polygon points="24,12 9,30 39,30" fill="#2e9e4f"/><polygon points="24,20 6,40 42,40" fill="#23853f"/>' +
    '<polygon points="24,4 14,20 34,20" fill="#3bb35e"/>' +
    '<polygon points="24,0 25.8,4.2 30.3,4.6 26.9,7.5 27.9,11.9 24,9.6 20.1,11.9 21.1,7.5 17.7,4.6 22.2,4.2" fill="#ffd23f"/>' +
    '<circle cx="18" cy="27" r="2" fill="#e8384f"/><circle cx="29" cy="34" r="2" fill="#4aa8ff"/><circle cx="27" cy="17" r="1.8" fill="#ffd23f"/>' +
    '<circle cx="15" cy="37" r="1.8" fill="#ffd23f"/><circle cx="33" cy="25" r="1.8" fill="#e8384f"/></svg>' },
  snowflake: { title: 'Снежинка', anim: 'spin', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g stroke="#9fd8ff" stroke-width="3" stroke-linecap="round" fill="none">' +
    [0, 60, 120, 180, 240, 300].map((r) => '<g transform="rotate(' + r + ' 24 24)"><line x1="24" y1="24" x2="24" y2="4"/>' +
      '<polyline points="18,8 24,13 30,8"/><polyline points="20,15 24,18 28,15"/></g>').join('') +
    '</g><circle cx="24" cy="24" r="3" fill="#dff3ff"/></svg>' },
  star: { title: 'Звезда', anim: 'twinkle', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><polygon points="24,3 30,17.5 45.5,18.6 33.6,28.6 37.4,43.7 24,35.5 10.6,43.7 14.4,28.6 2.5,18.6 18,17.5" ' +
    'fill="#ffd23f" stroke="#f0a500" stroke-width="2" stroke-linejoin="round"/><polygon points="24,11 27,19.5 24,23 21,19.5" fill="#fff3b0"/></svg>' },
  heart: { title: 'Сердце', anim: 'pulse', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 43 C10 33 3 25 3 16 C3 9 8 4 14.5 4 C19 4 22.5 6.5 24 10 C25.5 6.5 29 4 33.5 4 C40 4 45 9 45 16 C45 25 38 33 24 43 Z" fill="#e8384f"/>' +
    '<path d="M11 12 C12.5 9.5 15 8.5 17 9" stroke="#ff9aa8" stroke-width="3" stroke-linecap="round" fill="none"/></svg>' },
  flower: { title: 'Цветок', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 26 L24 46" stroke="#3a9d4a" stroke-width="3"/><path d="M24 38 C18 37 15 33 15 30 C20 30 23 33 24 38 Z" fill="#4cb85c"/>' +
    '<g fill="#ff6fa8"><circle cx="24" cy="9" r="7"/><circle cx="33.5" cy="15.5" r="7"/><circle cx="30" cy="26" r="7"/><circle cx="18" cy="26" r="7"/><circle cx="14.5" cy="15.5" r="7"/></g>' +
    '<circle cx="24" cy="18" r="5.5" fill="#ffd23f"/></svg>' },
  egg: { title: 'Пасхальное яйцо', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 3 C34 3 41 18 41 29 C41 39 33.5 45 24 45 C14.5 45 7 39 7 29 C7 18 14 3 24 3 Z" fill="#e8384f"/>' +
    '<path d="M8.5 22 L14 18 L19 22 L24 18 L29 22 L34 18 L39.5 22" stroke="#ffd23f" stroke-width="3" fill="none" stroke-linejoin="round"/>' +
    '<path d="M7.5 32 L40.5 32" stroke="#ffffff" stroke-width="3"/><g fill="#ffd23f"><circle cx="16" cy="38" r="2"/><circle cx="24" cy="39.5" r="2"/><circle cx="32" cy="38" r="2"/></g>' +
    '<path d="M17 9 C19 7 21 6 23 6" stroke="#ff9aa8" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>' },
  kulich: { title: 'Кулич', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="10" y="20" width="28" height="25" rx="3" fill="#c9843e"/><rect x="10" y="38" width="28" height="7" rx="2" fill="#a96a2c"/>' +
    '<path d="M8 21 C8 10 16 5 24 5 C32 5 40 10 40 21 C40 23 38 24 37 22 C36 26 33 26 32 22 C31 27 27 27 26 22 C25 26 21 26 20 22 C19 27 15 27 14 22 C13 25 10 25 10 22 C9 23 8 22.5 8 21 Z" fill="#fffaf0"/>' +
    '<g fill="#e8384f"><circle cx="18" cy="12" r="1.5"/><circle cx="28" cy="10" r="1.5"/></g><g fill="#4aa8ff"><circle cx="23" cy="15" r="1.5"/><circle cx="32" cy="15" r="1.5"/></g><circle cx="15" cy="17" r="1.5" fill="#ffd23f"/></svg>' },
  cake: { title: 'Торт', anim: 'pulse', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="13.5" y="11" width="3" height="9" rx="1" fill="#7fc4ff"/><path d="M15 5 C17.2 7.5 17.2 9 15 10 C12.8 9 12.8 7.5 15 5 Z" fill="#ffb02e"/><rect x="22.5" y="11" width="3" height="9" rx="1" fill="#ff8fb8"/><path d="M24 5 C26.2 7.5 26.2 9 24 10 C21.8 9 21.8 7.5 24 5 Z" fill="#ffb02e"/><rect x="31.5" y="11" width="3" height="9" rx="1" fill="#7fc4ff"/><path d="M33 5 C35.2 7.5 35.2 9 33 10 C30.8 9 30.8 7.5 33 5 Z" fill="#ffb02e"/>' +
    '<rect x="8" y="20" width="32" height="11" rx="3" fill="#ff8fb8"/><path d="M8 24 C11.5 28 14.5 21 18 25 C21.5 29 24.5 21 28 25 C31.5 29 34.5 21 40 24" stroke="#fff" stroke-width="2.5" fill="none"/>' +
    '<rect x="4" y="30" width="40" height="14" rx="3" fill="#c9843e"/><path d="M4 35 L44 35" stroke="#fffaf0" stroke-width="2"/>' +
    '<rect x="2" y="43" width="44" height="3" rx="1.5" fill="#ddd"/></svg>' },
  balloons: { title: 'Шарики', anim: 'float', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M17 30 C18 36 22 40 24 47 M31 28 C29 35 26 40 24 47" stroke="#ccc" stroke-width="1.5" fill="none"/>' +
    '<ellipse cx="16" cy="17" rx="10" ry="12" fill="#ffd23f"/><ellipse cx="32" cy="15" rx="10" ry="12" fill="#2f7fe0"/>' +
    '<polygon points="16,29 14,32 18,32" fill="#ffd23f"/><polygon points="32,27 30,30 34,30" fill="#2f7fe0"/>' +
    '<ellipse cx="12" cy="12" rx="2.5" ry="4" fill="#fff3b0"/><ellipse cx="28" cy="10" rx="2.5" ry="4" fill="#8fc0ff"/></svg>' },
  gift: { title: 'Подарок', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="20" width="36" height="25" rx="2" fill="#4aa8ff"/><rect x="3" y="14" width="42" height="9" rx="2" fill="#7fc4ff"/>' +
    '<rect x="21" y="14" width="6" height="31" fill="#e8384f"/><path d="M24 14 C18 4 9 6 12 12 C13.5 14.5 20 14 24 14 C28 14 34.5 14.5 36 12 C39 6 30 4 24 14 Z" fill="none" stroke="#e8384f" stroke-width="3"/></svg>' },
  candle: { title: 'Свеча', anim: 'pulse', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><ellipse cx="24" cy="12" rx="9" ry="10" fill="#ffd23f" opacity="0.25"/>' +
    '<path d="M24 3 C29 9 29 14 24 17 C19 14 19 9 24 3 Z" fill="#ffb02e"/><path d="M24 8 C26 11 26 13.5 24 15 C22 13.5 22 11 24 8 Z" fill="#fff3b0"/>' +
    '<line x1="24" y1="17" x2="24" y2="20" stroke="#555" stroke-width="1.5"/><rect x="17" y="20" width="14" height="25" rx="2" fill="#fffaf0"/>' +
    '<path d="M17 24 C20 24 21 28 21 30 C21 28 22 24 25 24" fill="#f1e6d0"/><rect x="13" y="44" width="22" height="3" rx="1.5" fill="#c9a76a"/></svg>' },
  pumpkin: { title: 'Тыква', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 12 C25 7 27 5 30 4" stroke="#3a7d2c" stroke-width="3.5" stroke-linecap="round" fill="none"/>' +
    '<ellipse cx="15" cy="29" rx="11" ry="15" fill="#e8742a"/><ellipse cx="33" cy="29" rx="11" ry="15" fill="#e8742a"/><ellipse cx="24" cy="29" rx="9" ry="16" fill="#f58b3a"/>' +
    '<path d="M24 14 C21 22 21 36 24 45 M24 14 C27 22 27 36 24 45" stroke="#c95f1c" stroke-width="1.5" fill="none"/>' +
    '<path d="M28 10 C33 8 36 10 37 13 C33 12.5 30 12 28 10 Z" fill="#4cb85c"/></svg>' },
  // герб Украины — картинка пользователя (вырезана из белого фона, 80x112 PNG)
  trident: { title: 'Тризуб', anim: 'pulse', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48">' +
    '<image x="6.86" y="0" width="34.29" height="48" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,' +
    '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' +
    '"/></svg>' },
  palm: { title: 'Пальма', anim: 'swing', svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><ellipse cx="25" cy="44" rx="18" ry="3.5" fill="#f2d28b"/>' +
    '<path d="M27 44 C27 34 25 24 21 15" stroke="#9a6a35" stroke-width="4" fill="none" stroke-linecap="round"/>' +
    '<g stroke="#7b5226" stroke-width="1.2"><path d="M24.6 36 L28 35.5"/><path d="M24 30 L27.3 29.3"/><path d="M22.8 24 L26 23"/></g>' +
    '<g fill="#3bb35e"><path d="M21 15 C15 9 8 9 3 14 C9 12 15 13 21 15 Z"/><path d="M21 15 C17 7 11 4 5 6 C11 7 16 10 21 15 Z"/>' +
    '<path d="M21 15 C24 7 31 4 38 6 C31 8 26 10 21 15 Z"/><path d="M21 15 C28 10 37 11 42 17 C35 14 28 14 21 15 Z"/>' +
    '<path d="M21 15 C23 19 22 25 18 29 C19 24 20 19 21 15 Z"/></g>' +
    '<g fill="#8a5a2b"><circle cx="19.5" cy="17.5" r="2.2"/><circle cx="23" cy="17.8" r="2.2"/></g></svg>' }
};

// Православная Пасха (дата по григорианскому календарю), годы 1900–2099: алгоритм Меёса для юлианского + 13 дней
function easter(y) {
  const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31), day = ((d + e + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day + 13));
}

const pad = (n) => (n < 10 ? '0' : '') + n;
const ymd = (dt) => dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());

// Дата праздника в году y ('YYYY-MM-DD') или '' (once — не в этот год)
function dateIn(h, y) {
  if (h.kind === 'year') { return y + '-' + h.d; }
  if (h.kind === 'once') { return h.d.slice(0, 4) === String(y) ? h.d : ''; }
  const e = easter(y);
  e.setUTCDate(e.getUTCDate() + (h.off || 0));
  return ymd(e);
}

// Проверенный список правил (со страницы сервера)
function clean(list) {
  if (!Array.isArray(list)) { return undefined; }
  const out = [];
  for (const x of list.slice(0, 100)) {
    if (!x || typeof x !== 'object') { continue; }
    const kind = ['year', 'once', 'easter'].indexOf(x.kind) >= 0 ? x.kind : 'year';
    let d = String(x.d || '').trim();
    if (kind === 'year') {
      const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(d);
      if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) { continue; }
      d = m[1] + '-' + m[2];
    } else if (kind === 'once') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { continue; }
    } else { d = ''; }
    const off = kind === 'easter' ? Math.max(-100, Math.min(100, Math.round(+x.off || 0))) : 0;
    const icon = ICONS[x.icon] ? x.icon : 'star';
    out.push({ kind, d, off, icon, name: String(x.name || '').replace(/[\t\r\n]/g, ' ').trim().slice(0, 60), on: x.on !== false && x.on !== 'false' });
  }
  return out;
}

// Для телевизора: включённые правила и рисунки только тех значков, что в них есть
function forTv(list, at) {
  const rules = (list || []).filter((h) => h.on).map((h) => ({ kind: h.kind, d: h.d, off: h.off, icon: h.icon }));
  const icons = {};
  for (const h of rules) { icons[h.icon] = { svg: ICONS[h.icon].svg, anim: ICONS[h.icon].anim }; }
  return { at: at || 0, list: rules, icons };
}

// Для страницы: ближайшие даты (от сегодня на год вперёд), по порядку
function upcoming(list, now) {
  const today = ymd(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  const out = [];
  (list || []).forEach((h, i) => {
    if (!h.on) { return; }
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
      const d = dateIn(h, y);
      if (d && d >= today) { out.push({ i, d }); break; }
    }
  });
  return out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i));
}

function iconList() {
  return Object.keys(ICONS).map((k) => ({ id: k, title: ICONS[k].title, anim: ICONS[k].anim, svg: ICONS[k].svg }));
}

// Номер набора рисунков: менять при изменении рисунков — телевизоры заберут новые (входит в holAt)
const REV = 2;

module.exports = { REV, ICONS, easter, dateIn, clean, forTv, upcoming, iconList };
