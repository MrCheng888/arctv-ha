'use strict';
// Вход на страницу настроек: логин и пароль (пароль хранится солёным хэшем scrypt), сессии в cookie.
// Телевизорам вход не нужен: они меняют только настройки из Tools.
const crypto = require('crypto');
const store = require('./store');

const SESSION_HOURS = 3;     // вход на страницу действует 3 часа
let auth = store.readJson('auth.json', null);

function save() { store.writeAtomic('auth.json', JSON.stringify(auth, null, 2)); }

function hash(pass, salt) { return crypto.scryptSync(String(pass), salt, 32).toString('hex'); }

function setAccount(user, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  auth = { user: String(user).trim().slice(0, 40), salt, hash: hash(pass, salt), sessions: (auth && auth.sessions) || {} };
  save();
}

// Перенос: в 0.3.x был только пароль страницы — становится логином admin с тем же паролем
const legacy = store.getSettings()._legacyPassword;
if (!auth && legacy) { setAccount('admin', legacy); }

function hasAccount() { return !!(auth && auth.user && auth.hash); }
function user() { return hasAccount() ? auth.user : ''; }

function check(u, pass) {
  if (!hasAccount()) { return false; }
  const h = hash(pass, auth.salt);
  return String(u).trim() === auth.user && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(auth.hash, 'hex'));
}

function newSession() {
  const token = crypto.randomBytes(24).toString('hex'), now = Date.now();
  for (const t of Object.keys(auth.sessions)) { if (auth.sessions[t] < now) { delete auth.sessions[t]; } }
  auth.sessions[token] = now + SESSION_HOURS * 3600 * 1000;
  save();
  return token;
}

function validSession(token) {
  if (!(token && hasAccount() && auth.sessions[token])) { return false; }
  // старые входы (до 0.5.1 — на 90 дней) укорачиваем до 3 часов от сейчас
  const lim = Date.now() + SESSION_HOURS * 3600 * 1000;
  if (auth.sessions[token] > lim) { auth.sessions[token] = lim; save(); }
  return auth.sessions[token] > Date.now();
}

function dropSession(token) { if (auth && auth.sessions && auth.sessions[token]) { delete auth.sessions[token]; save(); } }

// Сменили логин или пароль — выходим везде, кроме текущей сессии
function keepOnly(token) { auth.sessions = token && auth.sessions[token] ? { [token]: auth.sessions[token] } : {}; save(); }

module.exports = { hasAccount, user, check, setAccount, newSession, validSession, dropSession, keepOnly, SESSION_HOURS };
