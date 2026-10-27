// XIAO IoT API dashboard: login / sign-up, live sensor values, LED control.
// Every call goes to the FastAPI backend (window.API_BASE from config.js) over HTTP(S).

const API = window.API_BASE;
const POLL_DEVICE_MS = 1000;
const POLL_HISTORY_MS = 5000;
const HISTORY_MINUTES = 10;

const $ = id => document.getElementById(id);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let token = load('token');
let mode = 'login';            // or 'signup'
let device = null;
let history = [];
let timers = [];

$('apiBase').textContent = API;
$('docsLink').href = API + '/docs';

function load(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function save(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) {}
}

// ---------- API ----------

// quiet: polling calls are only logged when they fail
async function api(method, path, body, { quiet = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const started = performance.now();
  let status = 0, data = null;
  try {
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch (e) {
    data = { detail: '서버에 연결할 수 없습니다 (' + e.message + ')' };
  }
  const ms = Math.round(performance.now() - started);
  const ok = status >= 200 && status < 300;
  if (!quiet || !ok) log(method, path, body, status, ms, data, ok);
  if (status === 401 && token) logout('로그인이 만료되었습니다. 다시 로그인하세요');
  if (!ok) throw new Error(errorText(data, status));
  return data;
}

function errorText(data, status) {
  const d = data && data.detail;
  if (Array.isArray(d)) return d.map(x => x.msg).join(', ');  // FastAPI validation errors
  return d || ('HTTP ' + status);
}

function log(method, path, body, status, ms, data, ok) {
  const row = document.createElement('div');
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  // Never show passwords or tokens in the log
  const shownBody = body && body.password ? { ...body, password: '••••••••' } : body;
  const shownData = data && data.token ? { ...data, token: data.token.slice(0, 12) + '…' } : data;
  row.innerHTML = '<span></span> <b></b> <b></b><br><span></span>';
  const [t, m, s, , rest] = row.children;
  t.textContent = time;
  m.textContent = method + ' ' + path;
  s.textContent = (status || 'ERR') + ' · ' + ms + 'ms';
  s.className = ok ? 'ok' : 'fail';
  rest.textContent = (shownBody ? '→ ' + JSON.stringify(shownBody) + '  ' : '') + '← ' + JSON.stringify(shownData);
  const box = $('log');
  box.prepend(row);
  while (box.children.length > 50) box.lastChild.remove();
}

// ---------- Auth ----------

function setMode(next) {
  mode = next;
  $('loginTab').classList.toggle('active', mode === 'login');
  $('signupTab').classList.toggle('active', mode === 'signup');
  $('authBtn').textContent = mode === 'login' ? '로그인' : '회원가입';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').textContent = '';
}

$('loginTab').onclick = () => setMode('login');
$('signupTab').onclick = () => setMode('signup');

$('authForm').onsubmit = async e => {
  e.preventDefault();
  $('authBtn').disabled = true;
  $('authError').textContent = '';
  try {
    const data = await api('POST', '/api/auth/' + mode, { email: $('email').value, password: $('password').value });
    token = data.token;
    save('token', token);
    $('password').value = '';
    showDashboard(data.user);
  } catch (err) {
    $('authError').textContent = err.message;
  } finally {
    $('authBtn').disabled = false;
  }
};

$('logoutBtn').onclick = () => logout();

function logout(message) {
  token = null;
  save('token', null);
  timers.forEach(clearInterval);
  timers = [];
  device = null;
  history = [];
  $('dashView').hidden = true;
  $('who').hidden = true;
  $('authView').hidden = false;
  $('authError').textContent = message || '';
}

async function start() {
  if (!token) return logout();
  try {
    showDashboard(await api('GET', '/api/auth/me'));
  } catch (err) {
    if (token) logout(err.message);  // 401 already logged out
  }
}

function showDashboard(user) {
  $('authView').hidden = true;
  $('dashView').hidden = false;
  $('who').hidden = false;
  $('userEmail').textContent = user.email;
  refreshDevice();
  refreshHistory();
  timers.push(setInterval(refreshDevice, POLL_DEVICE_MS));
  timers.push(setInterval(refreshHistory, POLL_HISTORY_MS));
}

// ---------- Device ----------

async function refreshDevice() {
  try {
    device = await api('GET', '/api/device', null, { quiet: true });
    $('dashError').textContent = '';
    render();
  } catch (err) {
    $('dashError').textContent = err.message;
  }
}

async function refreshHistory() {
  try {
    history = await api('GET', '/api/device/history?minutes=' + HISTORY_MINUTES, null, { quiet: true });
  } catch (err) {
    $('dashError').textContent = err.message;
  }
}

async function sendLed(state) {
  setButtons(false);
  try {
    device = await api('POST', '/api/device/led', { state });
    render();
  } catch (err) {
    $('dashError').textContent = err.message;
  } finally {
    setButtons(true);
  }
}

function setButtons(enabled) {
  $('onBtn').disabled = $('offBtn').disabled = $('toggleBtn').disabled = !enabled;
}

$('onBtn').onclick = () => sendLed('on');
$('offBtn').onclick = () => sendLed('off');
$('toggleBtn').onclick = () => sendLed('toggle');

function render() {
  if (!device) return;
  const d = device;
  $('board').className = 'conn ' + (d.online ? 'live' : 'stale');
  $('boardText').textContent = d.online ? '보드 온라인' : '보드 오프라인';
  $('seen').textContent = '마지막 보고 ' + new Date(d.updated_at).toLocaleTimeString('ko-KR', { hour12: false }) +
    ' · Wi-Fi ' + d.rssi + ' dBm';
  $('ledCard').classList.toggle('on', d.led);
  // The LED value is the command; the board applies it on its next report (about 1 s)
  $('ledState').textContent = (d.led ? '켜짐' : '꺼짐') + (d.online ? '' : ' (대기)');
  $('touchCard').classList.toggle('on', d.touched && d.online);
  $('touchState').textContent = d.online ? (d.touched ? '터치됨' : '대기') : '-';
  const max = Math.max(1, d.threshold * 2);
  $('bar').style.width = Math.min(100, d.touch_value / max * 100) + '%';
  $('mark').style.left = (d.threshold / max * 100) + '%';
  $('touchValue').textContent = '값 ' + d.touch_value + ' / 기준 ' + d.threshold;
}

// ---------- Chart ----------

const canvas = $('chart');
const ctx = canvas.getContext('2d');
const PAD = { l: 44, r: 8, t: 8, b: 18 };
const WINDOW_MS = HISTORY_MINUTES * 60 * 1000;
let hoverX = null;

canvas.addEventListener('pointermove', e => { hoverX = e.offsetX; });
canvas.addEventListener('pointerleave', () => { hoverX = null; });

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = Date.now();
  const points = history.map(p => ({ t: new Date(p.created_at).getTime(), v: p.touch_value }));
  const ref = device ? device.threshold : null;
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  if (ref) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const pad = Math.max(500, (hi - lo) * 0.1);
  lo -= pad; hi += pad;

  const x = t => PAD.l + (1 - (now - t) / WINDOW_MS) * (w - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = css('--muted');
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke();
    ctx.fillText(Math.round(v / 100) / 10 + 'k', PAD.l - 6, yy);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('-' + HISTORY_MINUTES + '분', PAD.l, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText('지금', w - PAD.r, h - 4);

  if (ref) {
    const ty = Math.round(y(ref)) + 0.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css('--muted');
    ctx.beginPath(); ctx.moveTo(PAD.l, ty); ctx.lineTo(w - PAD.r, ty); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (points.length > 1) {
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v)));
    ctx.stroke();
  }

  const tip = $('tip');
  if (hoverX !== null && points.length) {
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.t) - hoverX) < Math.abs(x(best.t) - hoverX)) best = p;
    const bx = x(best.t), by = y(best.v);
    ctx.strokeStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(bx) + 0.5, PAD.t); ctx.lineTo(Math.round(bx) + 0.5, h - PAD.b); ctx.stroke();
    ctx.fillStyle = css('--line');
    ctx.strokeStyle = css('--card');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    tip.style.display = 'block';
    tip.textContent = best.v + ' · ' + new Date(best.t).toLocaleTimeString('ko-KR', { hour12: false });
    tip.style.left = Math.min(w - tip.offsetWidth, Math.max(0, bx - tip.offsetWidth / 2)) + 'px';
  } else {
    tip.style.display = 'none';
  }
}

function frame() {
  drawChart();
  requestAnimationFrame(frame);
}

setMode('login');
start();
requestAnimationFrame(frame);
