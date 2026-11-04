'use strict';
// HTTP(S) GET с переходами по redirect и таймаутом. Без зависимостей.
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1';

// Открывает ответ как поток. cb(err, res) — res уже без Content-Encoding (если сервер сжал сам).
function open(url, opts, cb, depth) {
  depth = depth || 0;
  let u;
  try { u = new URL(url); } catch (e) { cb(new Error('Неверный адрес: ' + url)); return; }
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.get(u, {
    headers: { 'User-Agent': opts.ua || UA, 'Accept': '*/*', 'Accept-Encoding': 'gzip' },
    timeout: opts.timeout || 30000
  }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (depth >= 5) { cb(new Error('Слишком много перенаправлений')); return; }
      open(new URL(res.headers.location, u).toString(), opts, cb, depth + 1);
      return;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      cb(new Error('HTTP ' + res.statusCode));
      return;
    }
    let stream = res;
    if (/gzip/i.test(res.headers['content-encoding'] || '')) { stream = res.pipe(zlib.createGunzip()); }
    stream.headers = res.headers;
    stream.raw = res;          // исходный ответ: по нему считается, сколько скачано
    cb(null, stream);
  });
  req.on('timeout', () => req.destroy(new Error('Таймаут')));
  req.on('error', (e) => cb(e));
}

function openP(url, opts) {
  return new Promise((resolve, reject) => open(url, opts || {}, (e, s) => (e ? reject(e) : resolve(s))));
}

// Весь ответ строкой (UTF-8)
async function text(url, opts) {
  const s = await openP(url, opts);
  const chunks = [];
  for await (const c of s) { chunks.push(c); }
  let t = Buffer.concat(chunks).toString('utf8');
  if (t.charCodeAt(0) === 0xFEFF) { t = t.slice(1); }
  return t;
}

module.exports = { openP, text };
