'use strict';

/* ================= 工具 ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const uid = () => Math.random().toString(36).slice(2, 10);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } }
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

const COLORS = ['#e4572e', '#2e86ab', '#3bb273', '#e0a100', '#8e5ccf', '#d6457a', '#139aa0', '#7a8b2c', '#a0522d', '#4b5bd6'];
const UNPLANNED = '#8a8f98';
const TYPES = ['景點', '餐廳', '咖啡', '購物', '住宿', '交通', '其他'];
const BOOK = ['', '未訂', '已訂', '候補', '不需訂位'];
const WD = '日一二三四五六';

/* ================= 連線設定 ================= */
const CFG = window.TRIP_CONFIG || {};
const conn = { scriptUrl: CFG.SCRIPT_URL || '', mapsKey: CFG.MAPS_API_KEY || '', mapId: CFG.MAP_ID || 'DEMO_MAP_ID', myName: '' };
(() => {
  const saved = LS.get('tp.conn', {});
  for (const k in saved) if (saved[k]) conn[k] = saved[k];
  const p = new URLSearchParams(location.search);
  let changed = false;
  if (p.get('api')) { conn.scriptUrl = p.get('api'); changed = true; }
  if (p.get('key')) { conn.mapsKey = p.get('key'); changed = true; }
  if (changed) { LS.set('tp.conn', conn); history.replaceState(null, '', location.pathname); }
})();
const isRemote = () => !!conn.scriptUrl;

/* ================= 資料 ================= */
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDate(s) { const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; }

function normalize(d) {
  d = d || {};
  const trip = Object.assign({ name: '我的旅程', startDate: fmtDate(new Date()), dayCount: 3 }, d.trip || {});
  trip.dayCount = Math.max(1, Math.min(60, parseInt(trip.dayCount, 10) || 1));
  return {
    trip,
    days: (d.days || []).map(x => ({ day: Number(x.day), date: x.date || '', title: x.title || '' })),
    spots: (d.spots || []).map(s => {
      const o = { ...s }; delete o._row;
      o.day = Number(o.day) || 0; o.order = Number(o.order) || 0;
      return o;
    }),
    sheetUrl: d.sheetUrl || ''
  };
}

let state = normalize(LS.get('tp.data', null));
let pending = LS.get('tp.pending', []);
const ui = { view: 'map', day: 1, mapDay: 'all', dragging: false, needFit: true, editing: null };

function persist() { LS.set('tp.data', state); LS.set('tp.pending', pending); }

const dayNums = () => Array.from({ length: state.trip.dayCount }, (_, i) => i + 1);
const effDay = s => (s.day >= 1 && s.day <= state.trip.dayCount) ? s.day : 0;
const dayColor = d => d > 0 ? COLORS[(d - 1) % COLORS.length] : UNPLANNED;
/* 地圖標記文字：行程關鍵字（沒填用名稱），最多四個字 */
const pinLabel = s => [...String(s.keyword || s.name || '').trim()].slice(0, 4).join('') || '•';
const hasLoc = s => s.lat !== '' && s.lng !== '' && isFinite(+s.lat) && isFinite(+s.lng) && s.lat != null;
function dayDate(n) { const d = parseDate(state.trip.startDate); if (!d || n < 1) return null; d.setDate(d.getDate() + n - 1); return d; }
function dayShort(n) { const d = dayDate(n); return d ? `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})` : ''; }
function dayTitle(n) { return (state.days.find(x => x.day === n) || {}).title || ''; }
function spotsOf(day) {
  return state.spots.filter(s => effDay(s) === day)
    .sort((a, b) => (a.order || 999) - (b.order || 999) || String(a.time || '').localeCompare(String(b.time || '')));
}

/* ================= 營業時間檢查 ================= */
function lineWeekday(line) {
  const m = line.match(/(?:星期|週|周|禮拜)([一二三四五六日天])/);
  if (m) return WD.indexOf(m[1] === '天' ? '日' : m[1]);
  const e = line.toLowerCase().match(/\b(sun|mon|tue|wed|thu|fri|sat)/);
  if (e) return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(e[1]);
  return -1;
}
function hoursLineFor(text, wd) {
  const lines = String(text || '').split(/\n|；|;/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const hasWd = lines.some(l => lineWeekday(l) >= 0);
  if (!hasWd) return lines.join(' ');
  const l = lines.find(x => lineWeekday(x) === wd);
  if (!l) return null;
  return l.replace(/(?:星期|週|周|禮拜)[一二三四五六日天]|\b(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/ig, '').replace(/^[\s:：]+/, '').trim();
}
function timeTokens(text) {
  const out = [];
  const re = /(上午|中午|下午|晚上)?\s*(\d{1,2})[:：](\d{2})\s*(am|pm)?/ig;
  let m;
  while ((m = re.exec(text))) {
    let h = +m[2]; const mi = +m[3]; const pre = m[1] || ''; const suf = (m[4] || '').toLowerCase();
    if ((pre === '下午' || pre === '晚上' || suf === 'pm') && h < 12) h += 12;
    if ((pre === '上午' || suf === 'am') && h === 12) h = 0;
    out.push({ min: h * 60 + mi, start: m.index, end: re.lastIndex });
  }
  return out;
}
function checkHours(spot) {
  const day = effDay(spot);
  if (!spot.hours || !day) return null;
  const d = dayDate(day); if (!d) return null;
  const text = hoursLineFor(spot.hours, d.getDay());
  if (text == null) return null;
  if (/休|closed|不營業/i.test(text)) return { level: 'bad', msg: '當天公休' };
  if (!spot.time || /24\s*小時|24 hours/i.test(text)) return null;
  const toks = timeTokens(text);
  const ranges = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    if (/[–\-~～至到]/.test(text.slice(toks[i].end, toks[i + 1].start))) {
      let s = toks[i].min, e = toks[i + 1].min;
      if (e <= s) e += 1440;
      ranges.push([s, e]); i++;
    }
  }
  if (!ranges.length) return null;
  const [h, m] = spot.time.split(':').map(Number);
  const t = h * 60 + m;
  const ok = ranges.some(([s, e]) => (t >= s && t < e) || (t + 1440 >= s && t + 1440 < e));
  return ok ? null : { level: 'warn', msg: '非營業時間' };
}

/* ================= 同步 ================= */
function setSync(kind, text) { $('#syncBtn').dataset.state = kind; $('#syncText').textContent = text; }

async function api(op) {
  const url = op ? conn.scriptUrl : conn.scriptUrl + (conn.scriptUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
  const r = await fetch(url, op ? { method: 'POST', body: JSON.stringify(op) } : undefined);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.ok === false) { const e = new Error(j.error || '伺服器錯誤'); e.server = true; throw e; }
  return j.data;
}

let pulling = false;
async function pull(force) {
  if (!isRemote() || pulling || flushing || pending.length) return;
  if (!force && (ui.dragging || $('#editor').open)) return;
  pulling = true; setSync('busy', '同步中');
  try { applyRemote(await api()); setSync('ok', '已同步'); }
  catch (e) { console.warn(e); setSync('err', '離線'); }
  finally { pulling = false; }
}

let flushing = false;
async function flush() {
  if (!isRemote()) { pending = []; persist(); return; }
  if (flushing || !pending.length) return;
  flushing = true; setSync('busy', '儲存中');
  let last = null, failed = false;
  while (pending.length) {
    try { last = await api(pending[0]); pending.shift(); persist(); }
    catch (e) {
      if (e.server) { pending.shift(); persist(); toast('儲存失敗：' + e.message); continue; }
      failed = true; console.warn(e); break;
    }
  }
  flushing = false;
  if (failed) { setSync('err', '未上傳'); return; }
  if (last) applyRemote(last);
  setSync('ok', '已同步');
}

function applyRemote(d) { state = normalize(d); persist(); renderAll(); }
function push(op) { pending.push(op); persist(); flush(); }

/* ================= 資料異動 ================= */
function upsertSpot(s) {
  s.updatedAt = new Date().toISOString();
  s.editor = conn.myName || '';
  const i = state.spots.findIndex(x => x.id === s.id);
  if (i >= 0) state.spots[i] = s; else state.spots.push(s);
  persist(); renderAll(); push({ action: 'saveSpot', spot: s });
}
function removeSpot(id) {
  state.spots = state.spots.filter(s => s.id !== id);
  persist(); renderAll(); push({ action: 'deleteSpot', id });
}
function reorderDay(day, ids) {
  const items = ids.map((id, i) => ({ id, day, order: i + 1 }));
  items.forEach(it => { const s = state.spots.find(x => x.id === it.id); if (s) { s.day = it.day; s.order = it.order; } });
  persist(); renderAll(); push({ action: 'reorder', items });
}
function saveTrip(trip) { state.trip = trip; persist(); renderAll(); push({ action: 'saveTrip', trip }); }
function saveDayTitle(day, title) {
  let d = state.days.find(x => x.day === day);
  if (!d) { d = { day, date: '', title: '' }; state.days.push(d); }
  d.title = title; persist(); push({ action: 'saveDay', day, title });
}
const nextOrder = day => Math.max(0, ...spotsOf(day).map(s => s.order || 0)) + 1;

/* ================= 畫面：頂部 ================= */
function renderHeader() {
  $('#tripName').textContent = state.trip.name || '旅程';
  const a = dayDate(1), b = dayDate(state.trip.dayCount);
  $('#tripRange').textContent = a ? `${a.getMonth() + 1}/${a.getDate()} – ${b.getMonth() + 1}/${b.getDate()}` : '';
  document.title = state.trip.name || '旅程共編';
}

function showView(v) {
  ui.view = v;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'map') renderMap(ui.needFit);
  if (v === 'settings') renderSettings();
}

/* ================= 畫面：地圖 ================= */
let gmap = null, AdvMarker = null, mapsReady = false, mapsLoading = null, markers = [], polylines = [];

function loadMapsScript(key) {
  /* Google 官方的動態載入程式 */
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({ key, v: 'weekly', language: 'zh-TW', region: 'TW' });
}

function mapPlaceholder(html) {
  const el = $('#mapPlaceholder');
  el.innerHTML = html; el.classList.toggle('hidden', !html);
}

function initMap() {
  if (!conn.mapsKey) {
    mapPlaceholder('<b>還沒設定 Google 地圖</b><p>到「設定」填入地圖 API 金鑰後，這裡會顯示每天的地點分布。</p><p>行程、訂位可以先照常編輯。</p>');
    return Promise.resolve();
  }
  if (mapsLoading) return mapsLoading;
  window.gm_authFailure = () => mapPlaceholder('<b>Google 地圖金鑰無效</b><p>請確認金鑰正確、已啟用 Maps JavaScript API，且網址限制包含這個網站。</p>');
  loadMapsScript(conn.mapsKey);
  mapsLoading = (async () => {
    const { Map } = await google.maps.importLibrary('maps');
    ({ AdvancedMarkerElement: AdvMarker } = await google.maps.importLibrary('marker'));
    gmap = new Map($('#map'), {
      center: { lat: 25.0478, lng: 121.5170 }, zoom: 12, mapId: conn.mapId,
      disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false
    });
    gmap.addListener('click', () => $('#mapCard').classList.add('hidden'));
    mapsReady = true;
    renderMap(true);
  })().catch(e => { console.warn(e); mapPlaceholder('<b>Google 地圖載入失敗</b><p>' + esc(e.message) + '</p>'); });
  return mapsLoading;
}

function renderMapChips() {
  const all = state.spots.length;
  const chip = (key, label, color, n) =>
    `<button class="chip ${String(ui.mapDay) === String(key) ? 'on' : ''}" data-mapday="${key}">` +
    (color ? `<i style="background:${color}"></i>` : '') + `${esc(label)}<span class="n">${n}</span></button>`;
  let html = chip('all', '全部', '', all);
  for (const d of dayNums()) html += chip(d, 'D' + d, dayColor(d), spotsOf(d).length);
  const un = spotsOf(0).length;
  if (un) html += chip(0, '待排', UNPLANNED, un);
  $('#mapChips').innerHTML = html;
}

function renderMap(fit) {
  renderMapChips();
  if (!mapsReady) return;
  if (ui.view !== 'map') { if (fit) ui.needFit = true; return; }
  markers.forEach(m => m.map = null); markers = [];
  polylines.forEach(p => p.setMap(null)); polylines = [];
  const bounds = new google.maps.LatLngBounds();
  let n = 0;
  const days = ui.mapDay === 'all' ? [...dayNums(), 0] : [Number(ui.mapDay)];
  for (const d of days) {
    const color = dayColor(d);
    const path = [];
    spotsOf(d).forEach(s => {
      if (!hasLoc(s)) return;
      const pos = { lat: +s.lat, lng: +s.lng };
      const el = document.createElement('div');
      el.className = 'pin';
      el.style.background = color;
      el.textContent = pinLabel(s);
      const mk = new AdvMarker({ map: gmap, position: pos, content: el, title: s.keyword ? `${s.keyword}｜${s.name}` : s.name });
      mk.addListener('click', () => showMapCard(s));
      markers.push(mk); bounds.extend(pos); n++;
      if (d) path.push(pos);
    });
    if (path.length > 1) polylines.push(new google.maps.Polyline({ map: gmap, path, strokeColor: color, strokeOpacity: .75, strokeWeight: 3 }));
  }
  if (fit && n) {
    if (n === 1) { gmap.setCenter(bounds.getCenter()); gmap.setZoom(15); }
    else gmap.fitBounds(bounds, { top: 70, bottom: 40, left: 30, right: 30 });
    ui.needFit = false;
  }
}

function navUrl(s) {
  const q = hasLoc(s) ? `${s.lat},${s.lng}` : (s.address || s.name);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + (s.placeId ? '&query_place_id=' + encodeURIComponent(s.placeId) : '');
}

function showMapCard(s) {
  const d = effDay(s);
  const dd = dayDate(d);
  const hrs = dd ? hoursLineFor(s.hours, dd.getDay()) : null;
  const chk = checkHours(s);
  $('#mapCard').innerHTML = `
    <div class="mc-top"><span class="daytag" style="background:${dayColor(d)}">${d ? 'D' + d : '待排'}</span>
      <b>${esc(s.keyword || s.name)}</b></div>
    ${s.keyword ? `<div class="mc-meta">${esc(s.name)}</div>` : ''}
    <div class="mc-meta">${[d ? dayShort(d) : '', s.time, s.type].filter(Boolean).map(esc).join(' · ')}</div>
    ${hrs ? `<div class="mc-meta">營業：${esc(hrs)}</div>` : ''}
    <div class="badges">${bookBadge(s)}${chk ? `<span class="badge ${chk.level}">${chk.msg}</span>` : ''}</div>
    <div class="btn-row"><button class="btn" data-edit="${esc(s.id)}">編輯</button>
      <a class="btn" href="${navUrl(s)}" target="_blank" rel="noopener">導航</a></div>`;
  $('#mapCard').classList.remove('hidden');
}

/* ================= 畫面：每日行程 ================= */
function bookBadge(s) {
  const cls = { '已訂': 'ok', '未訂': 'bad', '候補': 'warn', '不需訂位': '' }[s.bookStatus];
  if (cls === undefined) return '';
  return `<span class="badge ${cls}">${esc(s.bookStatus)}</span>`;
}

function renderPlan() {
  if (ui.day !== 0 && ui.day > state.trip.dayCount) ui.day = 1;
  const tab = d => `<button class="dtab ${d === ui.day ? 'on' : ''}" data-day="${d}" style="--c:${dayColor(d)}">
      <b>${d ? 'D' + d : '待排'}</b><small>${d ? dayShort(d) : '未安排'}</small></button>`;
  $('#dayTabs').innerHTML = [...dayNums(), 0].map(tab).join('');

  const list = spotsOf(ui.day);
  if (ui.day) {
    $('#dayHead').innerHTML = `
      <input class="day-title" id="dayTitle" placeholder="這天的主題（例：淺草・上野）" value="${esc(dayTitle(ui.day))}">
      <div class="day-meta"><span>${esc(dayShort(ui.day))}</span>
        <button class="link" id="sortTimeBtn">依抵達時間排序</button></div>`;
  } else {
    $('#dayHead').innerHTML = `<div class="day-meta"><span>還沒排進哪一天的地點，編輯時選擇「哪一天」即可移入。</span></div>`;
  }

  const color = dayColor(ui.day);
  $('#spotList').innerHTML = list.length ? list.map((s, i) => {
    const dd = dayDate(ui.day);
    const hrs = dd ? hoursLineFor(s.hours, dd.getDay()) : null;
    const chk = checkHours(s);
    const sub = [s.keyword, s.type, s.duration ? `停留 ${s.duration} 分` : '', s.bookStatus === '已訂' && s.bookTime ? '訂位 ' + s.bookTime.slice(-5) : ''].filter(Boolean);
    return `<li class="spot" data-id="${esc(s.id)}">
      <span class="handle" aria-label="拖曳排序">⋮⋮</span>
      <span class="num" style="background:${color}">${ui.day ? i + 1 : '•'}</span>
      <div class="body" data-edit="${esc(s.id)}">
        <div class="r1"><span class="time">${esc(s.time || '--:--')}</span><span class="name">${esc(s.name)}</span></div>
        <div class="r2">${sub.map(x => `<span>${esc(x)}</span>`).join('')}</div>
        <div class="badges">${bookBadge(s)}${chk ? `<span class="badge ${chk.level}">${chk.msg}</span>` : ''}
          ${!hasLoc(s) ? '<span class="badge">無座標</span>' : ''}</div>
        ${hrs ? `<div class="r3">營業 ${esc(hrs)}</div>` : ''}
      </div></li>`;
  }).join('') : `<li class="empty">這天還沒有地點。按「新增地點」加入，或從「待排」移過來。</li>`;
}

/* ================= 畫面：訂位 ================= */
function renderBook() {
  const list = state.spots.filter(s => ['未訂', '已訂', '候補'].includes(s.bookStatus));
  const count = st => list.filter(s => s.bookStatus === st).length;
  $('#bookStats').innerHTML = [['已訂', 'ok'], ['未訂', 'bad'], ['候補', 'warn']]
    .map(([k, c]) => `<div class="stat ${c}"><b>${count(k)}</b><span>${k}</span></div>`).join('');
  if (!list.length) {
    $('#bookList').innerHTML = '<p class="empty">還沒有需要訂位的地點。編輯地點時把「訂位狀態」設為未訂／已訂／候補，就會列在這裡。</p>';
    return;
  }
  let html = '';
  for (const d of [...dayNums(), 0]) {
    const items = list.filter(s => effDay(s) === d)
      .sort((a, b) => String(a.bookTime || a.time || '').localeCompare(String(b.bookTime || b.time || '')));
    if (!items.length) continue;
    html += `<h3 class="grp"><i style="background:${dayColor(d)}"></i>${d ? `D${d} ${esc(dayShort(d))}` : '待排'}</h3>`;
    html += items.map(s => {
      const contact = s.bookContact || '';
      const link = /^https?:\/\//.test(contact) ? `<a href="${esc(contact)}" target="_blank" rel="noopener">訂位連結</a>`
        : /^[+\d][\d\s-]{5,}$/.test(contact) ? `<a href="tel:${esc(contact.replace(/\s/g, ''))}">${esc(contact)}</a>` : esc(contact);
      const rows = [
        ['時間', (s.bookTime || '').replace('T', ' ')], ['人數', s.bookPeople], ['編號', s.bookNo], ['聯絡', link], ['費用', s.cost]
      ].filter(r => r[1]);
      return `<div class="book-card" data-edit="${esc(s.id)}">
        <div class="bc-top"><b>${esc(s.name)}</b>${bookBadge(s)}</div>
        <dl>${rows.map(r => `<dt>${r[0]}</dt><dd>${r[0] === '聯絡' ? r[1] : esc(r[1])}</dd>`).join('')}</dl></div>`;
    }).join('');
  }
  $('#bookList').innerHTML = html;
}

/* ================= 畫面：設定 ================= */
function renderSettings() {
  const f = $('#settingsForm');
  f.tripName.value = state.trip.name || '';
  f.startDate.value = state.trip.startDate || '';
  f.dayCount.value = state.trip.dayCount;
  f.myName.value = conn.myName || '';
  f.scriptUrl.value = conn.scriptUrl || '';
  f.mapsKey.value = conn.mapsKey || '';
  const link = $('#sheetLink');
  link.classList.toggle('hidden', !state.sheetUrl);
  if (state.sheetUrl) link.href = state.sheetUrl;
  $('#shareBtn').disabled = !isRemote();
  $('#sampleBtn').classList.toggle('hidden', isRemote());
}

function renderAll() {
  renderHeader();
  renderMap(false);
  renderPlan();
  renderBook();
}

/* ================= 編輯器 ================= */
function fillSelect(sel, opts, val) {
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  sel.value = val;
}

function openEditor(id) {
  const existing = state.spots.find(s => s.id === id);
  const s = existing ? { ...existing } : { id: uid(), day: ui.day, order: 0, type: '景點', bookStatus: '', lat: '', lng: '' };
  ui.editing = s;
  const f = $('#spotForm');
  $('#editorTitle').textContent = existing ? '編輯地點' : '新增地點';
  fillSelect($('#daySelect'), [...dayNums().map(d => [d, `D${d} ${dayShort(d)}`]), [0, '待排']], effDay(s));
  fillSelect($('#typeSelect'), TYPES.map(t => [t, t]), s.type || '其他');
  fillSelect($('#bookSelect'), BOOK.map(b => [b, b || '（不適用）']), s.bookStatus || '');
  ['name', 'keyword', 'time', 'duration', 'address', 'hours', 'bookPeople', 'bookNo', 'bookContact', 'cost', 'note'].forEach(k => f[k].value = s[k] ?? '');
  f.bookTime.value = (s.bookTime || '').replace(' ', 'T');
  $('#placeQuery').value = '';
  $('#placeResults').innerHTML = '';
  $('#searchBox').classList.toggle('hidden', !conn.mapsKey);
  $('#deleteBtn').classList.toggle('hidden', !existing);
  $('#metaHint').textContent = existing && s.updatedAt ? `最後更新：${s.editor || '未具名'}，${new Date(s.updatedAt).toLocaleString('zh-TW', { hour12: false })}` : '';
  updateEditorHints();
  $('#editor').showModal();
  $('.dlg-body').scrollTop = 0;
}

function readEditor() {
  const f = $('#spotForm');
  const s = ui.editing;
  ['name', 'keyword', 'type', 'time', 'duration', 'address', 'hours', 'bookStatus', 'bookPeople', 'bookNo', 'bookContact', 'cost', 'note'].forEach(k => s[k] = f[k].value.trim());
  s.bookTime = f.bookTime.value.replace('T', ' ');
  return s;
}

function updateEditorHints() {
  const s = readEditor();
  s.day = Number($('#daySelect').value);
  $('#coordHint').textContent = hasLoc(s) ? '✓ 已有座標，會顯示在地圖上'
    : (s.address || s.name) ? '尚無座標：儲存後會依地址自動查詢' : '';
  const chk = checkHours(s);
  $('#hoursHint').textContent = chk ? `⚠ ${chk.msg}：請確認預計抵達時間` : '';
  $('#hoursHint').className = 'hint' + (chk ? ' ' + chk.level : '');
  const nav = $('#navLink');
  nav.href = navUrl(s);
  nav.classList.toggle('hidden', !(hasLoc(s) || s.address));
}

async function searchPlaces() {
  const q = $('#placeQuery').value.trim();
  if (!q) return;
  const box = $('#placeResults');
  box.innerHTML = '<p class="hint">搜尋中…</p>';
  try {
    await initMap();
    if (!mapsReady) throw new Error('Google 地圖尚未載入');
    const { Place } = await google.maps.importLibrary('places');
    const req = { textQuery: q, fields: ['id', 'displayName', 'formattedAddress', 'location', 'regularOpeningHours'], language: 'zh-TW', maxResultCount: 6 };
    const b = gmap.getBounds();
    if (b) req.locationBias = b;
    const { places } = await Place.searchByText(req);
    if (!places.length) { box.innerHTML = '<p class="hint">找不到符合的地點</p>'; return; }
    searchPlaces.last = places;
    box.innerHTML = places.map((p, i) => `<button type="button" class="place" data-pi="${i}"><b>${esc(p.displayName)}</b><small>${esc(p.formattedAddress || '')}</small></button>`).join('');
  } catch (e) {
    console.warn(e);
    box.innerHTML = `<p class="hint bad">搜尋失敗：${esc(e.message)}（需在 Google Cloud 啟用 Places API (New)）</p>`;
  }
}

function pickPlace(p) {
  const f = $('#spotForm');
  const s = ui.editing;
  f.name.value = p.displayName || f.name.value;
  f.address.value = p.formattedAddress || '';
  s.lat = String(p.location.lat()); s.lng = String(p.location.lng());
  s.placeId = p.id || '';
  const wd = p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions;
  if (wd && wd.length) f.hours.value = wd.join('\n');
  $('#placeResults').innerHTML = '<p class="hint ok">已帶入名稱、地址、座標' + (wd ? '與營業時間' : '') + '</p>';
  updateEditorHints();
}

function submitEditor() {
  const s = readEditor();
  if (!s.name) { toast('請輸入名稱'); return; }
  const newDay = Number($('#daySelect').value);
  const original = state.spots.find(x => x.id === s.id);
  if (!original || effDay(original) !== newDay) s.order = nextOrder(newDay);
  s.day = newDay;
  $('#editor').close();
  upsertSpot(s);
  toast('已儲存');
}

/* ================= 範例資料 ================= */
function sampleData() {
  const start = new Date(); start.setDate(start.getDate() + 14);
  const S = (day, order, name, type, time, lat, lng, extra = {}) => ({ id: uid(), day, order, name, type, time, lat: String(lat), lng: String(lng), address: '', duration: '', bookStatus: '', ...extra });
  return normalize({
    trip: { name: '東京三日遊（範例）', startDate: fmtDate(start), dayCount: 3 },
    days: [{ day: 1, title: '淺草・上野' }, { day: 2, title: '原宿・澀谷' }, { day: 3, title: '築地・東京鐵塔' }],
    spots: [
      S(1, 1, '淺草寺', '景點', '09:00', 35.7148, 139.7967, { keyword: '參拜求籤',  duration: '90' }),
      S(1, 2, '東京晴空塔', '景點', '11:00', 35.7101, 139.8107, { keyword: '展望台',  duration: '120' }),
      S(1, 3, '上野恩賜公園', '景點', '15:00', 35.7156, 139.7745, { keyword: '賞楓散步' }),
      S(1, 4, '阿美橫丁晚餐', '餐廳', '18:30', 35.7100, 139.7745, { keyword: '居酒屋',  bookStatus: '已訂', bookPeople: '4', bookNo: 'A1234', hours: '星期一: 休息\n星期二: 17:00 – 23:00\n星期三: 17:00 – 23:00\n星期四: 17:00 – 23:00\n星期五: 17:00 – 23:00\n星期六: 12:00 – 23:00\n星期日: 12:00 – 22:00' }),
      S(2, 1, '明治神宮', '景點', '09:30', 35.6764, 139.6993, { keyword: '神前婚禮' }),
      S(2, 2, '竹下通', '購物', '11:30', 35.6716, 139.7031, { keyword: '可麗餅' }),
      S(2, 3, '澀谷 SKY', '景點', '17:00', 35.6585, 139.7022, { keyword: '夕陽夜景',  bookStatus: '未訂', bookPeople: '4' }),
      S(3, 1, '築地場外市場', '餐廳', '08:00', 35.6654, 139.7707, { keyword: '海鮮早餐' }),
      S(3, 2, '東京鐵塔', '景點', '13:00', 35.6586, 139.7454, { keyword: '聖誕點燈活動' }),
      S(0, 1, '新宿御苑', '景點', '', 35.6852, 139.7101, { keyword: '野餐' })
    ]
  });
}

/* ================= 事件 ================= */
function bind() {
  $('.tabbar').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });

  document.addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed && !e.target.closest('a')) { openEditor(ed.dataset.edit); return; }
    const chip = e.target.closest('[data-mapday]');
    if (chip) { ui.mapDay = chip.dataset.mapday === 'all' ? 'all' : Number(chip.dataset.mapday); $('#mapCard').classList.add('hidden'); renderMap(true); return; }
    const dt = e.target.closest('.dtab');
    if (dt) { ui.day = Number(dt.dataset.day); renderPlan(); dt.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
  });

  $('#dayHead').addEventListener('change', e => { if (e.target.id === 'dayTitle') saveDayTitle(ui.day, e.target.value.trim()); });
  $('#dayHead').addEventListener('click', e => {
    if (e.target.id !== 'sortTimeBtn') return;
    const list = spotsOf(ui.day).slice().sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    reorderDay(ui.day, list.map(s => s.id));
    toast('已依抵達時間排序');
  });

  $('#addBtn').addEventListener('click', () => openEditor(null));

  if (window.Sortable) {
    Sortable.create($('#spotList'), {
      handle: '.handle', animation: 150, filter: '.empty',
      onStart: () => { ui.dragging = true; },
      onEnd: () => {
        ui.dragging = false;
        const ids = $$('#spotList .spot').map(li => li.dataset.id);
        reorderDay(ui.day, ids);
      }
    });
  }

  /* 編輯器 */
  const f = $('#spotForm');
  f.addEventListener('submit', e => { e.preventDefault(); submitEditor(); });
  $('[data-close]').addEventListener('click', () => $('#editor').close());
  $('#deleteBtn').addEventListener('click', () => {
    if (!confirm('確定刪除「' + (ui.editing.name || '此地點') + '」？')) return;
    $('#editor').close(); removeSpot(ui.editing.id); toast('已刪除');
  });
  $('#addrInput').addEventListener('input', () => { ui.editing.lat = ''; ui.editing.lng = ''; ui.editing.placeId = ''; });
  f.addEventListener('input', updateEditorHints);
  f.addEventListener('change', updateEditorHints);
  $('#placeSearchBtn').addEventListener('click', searchPlaces);
  $('#placeQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchPlaces(); } });
  $('#placeResults').addEventListener('click', e => {
    const b = e.target.closest('[data-pi]');
    if (b) pickPlace(searchPlaces.last[Number(b.dataset.pi)]);
  });

  /* 設定 */
  $('#settingsForm').addEventListener('submit', e => {
    e.preventDefault();
    const sf = e.target;
    const oldKey = conn.mapsKey, oldUrl = conn.scriptUrl;
    conn.myName = sf.myName.value.trim();
    conn.scriptUrl = sf.scriptUrl.value.trim();
    conn.mapsKey = sf.mapsKey.value.trim();
    LS.set('tp.conn', conn);
    const trip = { name: sf.tripName.value.trim() || '我的旅程', startDate: sf.startDate.value, dayCount: Math.max(1, Math.min(60, parseInt(sf.dayCount.value, 10) || 1)) };
    const tripChanged = JSON.stringify(trip) !== JSON.stringify({ name: state.trip.name, startDate: state.trip.startDate, dayCount: state.trip.dayCount });
    if (conn.scriptUrl !== oldUrl) {
      pending = []; persist();
      if (conn.scriptUrl) { toast('已連線，正在讀取試算表'); pull(true); }
      else setSync('local', '本機');
    } else if (tripChanged) saveTrip(trip);
    if (conn.mapsKey !== oldKey) { toast('地圖金鑰已更新，重新載入中'); setTimeout(() => location.reload(), 800); return; }
    toast('設定已儲存');
    renderSettings();
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '?api=' + encodeURIComponent(conn.scriptUrl) + (conn.mapsKey ? '&key=' + encodeURIComponent(conn.mapsKey) : '');
    try {
      if (navigator.share) await navigator.share({ title: state.trip.name, text: '一起編輯行程', url });
      else { await navigator.clipboard.writeText(url); toast('邀請連結已複製'); }
    } catch (e) { if (e.name !== 'AbortError') prompt('複製這個連結：', url); }
  });

  $('#sampleBtn').addEventListener('click', () => {
    if (state.spots.length && !confirm('會覆蓋目前本機的行程，確定載入範例？')) return;
    state = sampleData(); ui.day = 1; ui.needFit = true; persist(); renderAll(); renderSettings(); toast('已載入範例');
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('清除這支手機上的行程快取與連線設定？（試算表內容不受影響）')) return;
    ['tp.data', 'tp.pending', 'tp.conn'].forEach(LS.del);
    location.reload();
  });

  $('#syncBtn').addEventListener('click', async () => {
    if (!isRemote()) { toast('目前是本機模式，到「設定」填入 Apps Script 網址即可共編'); return; }
    await flush(); await pull(true);
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); pull(); } });
  window.addEventListener('online', flush);
  setInterval(() => { if (!document.hidden) pull(); }, 30000);
}

/* ================= 啟動 ================= */
function init() {
  bind();
  renderAll();
  showView('map');
  initMap();
  if (isRemote()) { setSync('busy', '同步中'); flush().then(() => pull(true)); }
  else setSync('local', '本機');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}
init();
