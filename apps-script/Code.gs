/**
 * 旅程共編 — Google 試算表後端
 * 貼到「擴充功能 → Apps Script」，執行一次 setup()，再部署成網頁應用程式。
 * 試算表有三個工作表：行程設定、每日、地點。同伴可以直接在試算表編輯。
 */

const DEF = {
  trip: { name: '行程設定', cols: [['項目', 'label'], ['值', 'value']] },
  days: { name: '每日', cols: [['天', 'day'], ['日期', 'date'], ['標題', 'title']] },
  spots: {
    name: '地點',
    cols: [
      ['ID', 'id'], ['天', 'day'], ['順序', 'order'], ['名稱', 'name'], ['行程關鍵字', 'keyword'], ['類型', 'type'],
      ['時間', 'time'], ['停留(分)', 'duration'], ['地址', 'address'],
      ['緯度', 'lat'], ['經度', 'lng'], ['營業時間', 'hours'],
      ['訂位狀態', 'bookStatus'], ['訂位時間', 'bookTime'], ['人數', 'bookPeople'],
      ['訂位編號', 'bookNo'], ['聯絡電話/連結', 'bookContact'], ['費用', 'cost'],
      ['備註', 'note'], ['PlaceID', 'placeId'], ['更新者', 'editor'], ['更新時間', 'updatedAt']
    ]
  }
};
const TRIP_LABELS = { name: '旅程名稱', startDate: '開始日期', dayCount: '天數' };
const GEOCODE_PER_REQUEST = 8;

/* ---------- 入口 ---------- */

function setup() {
  Object.keys(DEF).forEach(k => sheet_(DEF[k]));
  const t = readTrip_();
  if (!t.name) {
    writeTrip_({
      name: '我的旅程',
      startDate: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
      dayCount: 3
    });
  }
  syncDays_(readTrip_());
}

function doGet() {
  try {
    return json_({ ok: true, data: all_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const op = JSON.parse(e.postData.contents || '{}');
    switch (op.action) {
      case 'saveSpot': writeSpot_(op.spot); break;
      case 'deleteSpot': deleteSpot_(op.id); break;
      case 'reorder': reorder_(op.items || []); break;
      case 'saveTrip': writeTrip_(op.trip); syncDays_(readTrip_()); break;
      case 'saveDay': writeDayTitle_(Number(op.day), op.title || ''); break;
      default: throw new Error('未知的動作：' + op.action);
    }
    SpreadsheetApp.flush();
    return json_({ ok: true, data: all_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 讀取 ---------- */

function all_() {
  const trip = readTrip_();
  return {
    trip: trip,
    days: readDays_(),
    spots: readSpots_(true),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
    serverTime: new Date().toISOString()
  };
}

function readTrip_() {
  const sh = sheet_(DEF.trip);
  const vals = sh.getDataRange().getValues();
  const t = { name: '', startDate: '', dayCount: 1 };
  for (let r = 1; r < vals.length; r++) {
    const label = String(vals[r][0]).trim();
    for (const k in TRIP_LABELS) if (TRIP_LABELS[k] === label) t[k] = cell_(vals[r][1]);
  }
  t.dayCount = Math.max(1, parseInt(t.dayCount, 10) || 1);
  return t;
}

function readDays_() {
  const sh = sheet_(DEF.days);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const hm = hmap_(vals[0], DEF.days);
  const out = [];
  for (let r = 1; r < vals.length; r++) {
    const day = Number(vals[r][hm.day]);
    if (!day) continue;
    out.push({ day: day, date: cell_(vals[r][hm.date]), title: cell_(vals[r][hm.title]) });
  }
  return out;
}

function readSpots_(withGeocode) {
  const sh = sheet_(DEF.spots);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const hm = hmap_(vals[0], DEF.spots);
  const out = [];
  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];
    const o = { _row: r + 1 };
    for (const k in hm) o[k] = cell_(row[hm[k]]);
    if (!o.name && !o.address) continue;
    if (!o.id) {
      // 同伴在試算表新增的列：自動補 ID
      o.id = Utilities.getUuid().slice(0, 8);
      sh.getRange(r + 1, hm.id + 1).setNumberFormat('@').setValue(o.id);
    }
    out.push(o);
  }
  if (withGeocode) geocodeMissing_(sh, hm, out);
  out.forEach(o => delete o._row);
  return out;
}

/* 沒有座標的地點用地址（或名稱）查座標，查不到寫「查無」避免重複查詢 */
function geocodeMissing_(sh, hm, spots) {
  let n = 0;
  const geocoder = Maps.newGeocoder().setLanguage('zh-TW');
  for (const s of spots) {
    if (n >= GEOCODE_PER_REQUEST) break;
    if (s.lat !== '' || s.lng !== '') continue;
    const q = s.address || s.name;
    if (!q) continue;
    n++;
    try {
      const res = geocoder.geocode(q);
      if (res.status === 'OK' && res.results.length) {
        const loc = res.results[0].geometry.location;
        s.lat = String(loc.lat);
        s.lng = String(loc.lng);
        sh.getRange(s._row, hm.lat + 1).setNumberFormat('@').setValue(s.lat);
        sh.getRange(s._row, hm.lng + 1).setNumberFormat('@').setValue(s.lng);
        if (!s.address) {
          s.address = res.results[0].formatted_address;
          sh.getRange(s._row, hm.address + 1).setValue(s.address);
        }
      } else {
        s.lat = '查無';
        sh.getRange(s._row, hm.lat + 1).setValue('查無');
      }
    } catch (err) {
      break; // 配額用完等狀況，下次再試
    }
  }
}

/* ---------- 寫入 ---------- */

function writeSpot_(spot) {
  if (!spot || !spot.id) throw new Error('缺少地點 ID');
  const sh = sheet_(DEF.spots);
  const lastCol = sh.getLastColumn();
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hm = hmap_(header, DEF.spots);
  let row = findRow_(sh, hm.id, spot.id);
  let values;
  if (row) {
    values = sh.getRange(row, 1, 1, lastCol).getValues()[0].map(cell_);
  } else {
    row = sh.getLastRow() + 1;
    values = new Array(lastCol).fill('');
  }
  for (const k in hm) {
    if (Object.prototype.hasOwnProperty.call(spot, k)) values[hm[k]] = spot[k] == null ? '' : String(spot[k]);
  }
  const range = sh.getRange(row, 1, 1, lastCol);
  range.setNumberFormat('@');
  range.setValues([values]);
  if (spot.lat === '' || spot.lng === '') readSpots_(true); // 補座標
}

function deleteSpot_(id) {
  const sh = sheet_(DEF.spots);
  const hm = hmap_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], DEF.spots);
  const row = findRow_(sh, hm.id, id);
  if (row) sh.deleteRow(row);
}

function reorder_(items) {
  const sh = sheet_(DEF.spots);
  const hm = hmap_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], DEF.spots);
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, hm.id + 1, last - 1, 1).getValues().map(r => String(r[0]));
  const now = new Date().toISOString();
  items.forEach(it => {
    const i = ids.indexOf(String(it.id));
    if (i < 0) return;
    const r = i + 2;
    sh.getRange(r, hm.day + 1).setNumberFormat('@').setValue(String(it.day));
    sh.getRange(r, hm.order + 1).setNumberFormat('@').setValue(String(it.order));
    sh.getRange(r, hm.updatedAt + 1).setNumberFormat('@').setValue(now);
  });
}

function writeTrip_(trip) {
  const sh = sheet_(DEF.trip);
  const vals = sh.getDataRange().getValues();
  for (const k in TRIP_LABELS) {
    if (trip[k] === undefined) continue;
    let r = -1;
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]).trim() === TRIP_LABELS[k]) r = i + 1;
    if (r < 0) { r = sh.getLastRow() + 1; sh.getRange(r, 1).setValue(TRIP_LABELS[k]); }
    sh.getRange(r, 2).setNumberFormat('@').setValue(String(trip[k]));
  }
}

/* 每日工作表保持 1..天數 的列，日期依開始日期計算，標題保留 */
function syncDays_(trip) {
  const sh = sheet_(DEF.days);
  const existing = {};
  readDays_().forEach(d => existing[d.day] = d.title);
  const rows = [];
  for (let d = 1; d <= trip.dayCount; d++) {
    let date = '';
    if (trip.startDate) {
      const p = String(trip.startDate).split('-').map(Number);
      const dt = new Date(p[0], p[1] - 1, p[2] + d - 1);
      date = Utilities.formatDate(dt, tz_(), 'yyyy-MM-dd');
    }
    rows.push([String(d), date, existing[d] || '']);
  }
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
  sh.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
}

function writeDayTitle_(day, title) {
  const sh = sheet_(DEF.days);
  const row = findRow_(sh, 0, day);
  if (row) sh.getRange(row, 3).setValue(title);
  else sh.appendRow([String(day), '', title]);
}

/* ---------- 工具 ---------- */

function sheet_(def) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(def.name);
  const labels = def.cols.map(c => c[0]);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, labels.length).setValues([labels]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, sh.getMaxRows() - 1, labels.length).setNumberFormat('@');
    return sh;
  }
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) {
    sh.getRange(1, 1, 1, labels.length).setValues([labels]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  const hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim());
  const missing = labels.filter(l => hdr.indexOf(l) < 0);
  if (missing.length) sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  return sh;
}

/* 用表頭文字找欄位（同伴調整欄位順序也沒關係） */
function hmap_(headerRow, def) {
  const hdr = headerRow.map(v => String(v).trim());
  const hm = {};
  def.cols.forEach(c => {
    let i = hdr.indexOf(c[0]);
    if (i < 0) i = hdr.indexOf(c[1]);
    if (i >= 0) hm[c[1]] = i;
  });
  return hm;
}

function findRow_(sh, colIdx, value) {
  const last = sh.getLastRow();
  if (last < 2 || colIdx == null) return 0;
  const vals = sh.getRange(2, colIdx + 1, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return 0;
}

/* 同伴手動輸入的日期/時間會被試算表轉成日期物件，這裡轉回文字 */
function cell_(v) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1900) return Utilities.formatDate(v, tz_(), 'HH:mm');
    if (v.getHours() === 0 && v.getMinutes() === 0) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm');
  }
  return v == null ? '' : String(v).trim();
}

function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
