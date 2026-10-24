// MVV4Dummies – Fahrtbegleiter für MVV/MVG.
// Datenquelle: MVG-Fahrplanauskunft (inoffiziell, erlaubt CORS-Abfragen direkt aus dem Browser).

const API = 'https://www.mvg.de/api/bgw-pt/v3';
const TRANSPORT_TYPES = 'SCHIFF,RUFTAXI,BAHN,UBAHN,TRAM,SBAHN,BUS,REGIONAL_BUS';
const REFRESH_MS = 30_000;
const MESSAGES_REFRESH_MS = 5 * 60_000;
const ALT_STOPS_AHEAD = 3;          // an so vielen kommenden Halten Umsteigen prüfen
const AUTO_ALT_DELAY_MIN = 5;       // ab dieser Verspätung automatisch Alternativen prüfen
const MAX_GPS_DISTANCE_M = 1500;    // weiter weg = nicht auf dieser Strecke
const AT_STOP_M = 250;              // so nah = "ich bin am Halt"
const MIN_USEFUL_GAIN_MIN = -2;     // langsamere Alternativen nur bis hierhin zeigen
const TYPE_COLORS = { SBAHN: '#408335', UBAHN: '#0065ae', TRAM: '#d82020', BUS: '#00586a', REGIONAL_BUS: '#00586a', BAHN: '#555', SCHIFF: '#0a7ea4', RUFTAXI: '#777' };
const DEFAULT_FAVORITES = [{
  from: { id: 'de:09184:2260', name: 'Aying' },
  to: { id: 'de:09162:5', name: 'München, Ostbahnhof' },
}];

// ---------- Hilfsfunktionen ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const minutes = (ms) => Math.round(ms / 60_000);

function store(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privater Modus */ }
}

async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MVG-Schnittstelle antwortet mit ${res.status}`);
  return res.json();
}

const searchStations = async (q) =>
  (await api('/locations', { query: q })).filter((l) => l.type === 'STATION' && l.globalId);

async function fetchRoutes(fromId, toId, date) {
  const raw = await api('/routes', {
    originStationGlobalId: fromId,
    destinationStationGlobalId: toId,
    routingDateTime: date.toISOString(),
    routingDateTimeIsArrival: false,
    transportTypes: TRANSPORT_TYPES,
  });
  return raw.map(toConnection).filter(Boolean);
}

// Planzeit + Verspätung. Beim Ziel eines Abschnitts steht die Ankunft in plannedDeparture.
const depTime = (s) => Date.parse(s.plannedDeparture) + (s.departureDelayInMinutes ?? s.arrivalDelayInMinutes ?? 0) * 60_000;
const arrTime = (s) => Date.parse(s.plannedDeparture) + (s.arrivalDelayInMinutes ?? s.departureDelayInMinutes ?? 0) * 60_000;
const delayOf = (s) => s.departureDelayInMinutes ?? s.arrivalDelayInMinutes ?? 0;

const isTransit = (part) => Boolean(part.line?.label) && part.line.transportType !== 'PEDESTRIAN';
const legStops = (part) => [part.from, ...(part.intermediateStops ?? []), part.to];

function toConnection(raw) {
  const parts = raw.parts ?? [];
  if (!parts.length) return null;
  const first = parts.find(isTransit) ?? parts[0];
  return {
    raw,
    parts,
    depart: depTime(parts[0].from),
    arrive: arrTime(parts.at(-1).to),
    firstTransitDepart: depTime(first.from),
    cancelled: parts.some((p) => p.isCancelled),
    key: `${first.line?.label}|${first.from.stationGlobalId}|${first.from.plannedDeparture}`,
  };
}

// Kodierte Polylinie (Google-Format) -> [[lat, lon], ...]
function decodePolyline(str) {
  const points = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

// Abstand Punkt–Strecke in Metern (lokal flache Erde, reicht für ein paar Kilometer).
function distToSegment(p, a, b) {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180), ky = 110_540;
  const ax = (a.longitude - p.lon) * kx, ay = (a.latitude - p.lat) * ky;
  const bx = (b.longitude - p.lon) * kx, by = (b.latitude - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { dist: Math.hypot(ax + t * dx, ay + t * dy), t };
}

// ---------- Position auf der Fahrt ----------

// Liefert {partIdx, seg, atStop, source}. seg = Index des letzten passierten Halts im Abschnitt
// (-1 = noch nicht abgefahren), atStop = Index des Halts, an dem ich gerade stehe (oder null). Ohne brauchbares GPS wird die Position aus der Echtzeit geschätzt.
function locate(conn, gps, now) {
  const transit = conn.parts.map((p, i) => [p, i]).filter(([p]) => isTransit(p));
  if (gps) {
    let best = null;
    for (const [part, partIdx] of transit) {
      const stops = legStops(part);
      for (let s = 0; s < stops.length - 1; s++) {
        const { dist, t } = distToSegment(gps, stops[s], stops[s + 1]);
        if (!best || dist < best.dist) best = { partIdx, seg: t > 0.98 ? s + 1 : s, dist };
      }
    }
    if (best && best.dist <= MAX_GPS_DISTANCE_M) {
      const stops = legStops(conn.parts[best.partIdx]);
      // Am Starthalt und Zug noch nicht abgefahren -> "wartet"
      if (best.seg === 0 && now < depTime(stops[0])) best.seg = -1;
      if (best.seg >= stops.length - 1) best.seg = stops.length - 2;
      const near = stops.findIndex((s) => distToSegment(gps, s, s).dist <= AT_STOP_M);
      return { ...best, atStop: near >= 0 ? near : null, source: 'gps' };
    }
  }
  for (const [part, partIdx] of transit) {
    const stops = legStops(part);
    if (now < depTime(stops[0])) return { partIdx, seg: -1, source: 'time' };
    if (now < arrTime(stops.at(-1))) {
      let seg = 0;
      while (seg < stops.length - 2 && now >= depTime(stops[seg + 1])) seg++;
      return { partIdx, seg, source: 'time' };
    }
  }
  const [lastPart, lastIdx] = transit.at(-1) ?? [conn.parts.at(-1), conn.parts.length - 1];
  return { partIdx: lastIdx, seg: legStops(lastPart).length - 2, source: 'time', arrived: true };
}

// Zeitabstand zwischen "jetzt" und dem Moment, zu dem ein Zug laut Echtzeit an Position pos ist.
function timeMismatch(conn, pos, now) {
  const stops = legStops(conn.parts[pos.partIdx]);
  if (pos.atStop != null) {
    // Am Bahnsteig: passt jeder Zug, der noch kommt oder gerade steht – nicht einer, der schon weg ist.
    const s = stops[pos.atStop];
    if (now < arrTime(s)) return arrTime(s) - now;
    return now <= depTime(s) + 2 * 60_000 ? 0 : Infinity;
  }
  if (pos.seg < 0) {
    const dep = depTime(stops[0]);
    return dep >= now - 60_000 ? dep - now : Infinity;   // schon weg -> kann nicht meiner sein
  }
  const t0 = depTime(stops[pos.seg]), t1 = arrTime(stops[pos.seg + 1]);
  if (now < t0) return t0 - now;
  if (now > t1) return now - t1;
  return 0;
}

// Welcher Zug ist es? Mit GPS: der, der laut Echtzeit jetzt am besten an meiner Stelle sein sollte.
// Ohne GPS: die nächste Abfahrt ab Start.
function pickTrain(candidates, gps, now) {
  const running = candidates.filter((c) => c.arrive >= now && !c.cancelled);
  if (!running.length) return candidates[0] ?? null;
  if (gps) {
    let best = null;
    for (const c of running) {
      const pos = locate(c, gps, now);
      if (pos.source !== 'gps') continue;
      const score = timeMismatch(c, pos, now);
      if (!best || score < best.score) best = { c, score };
    }
    if (best && best.score < Infinity) return best.c;
  }
  return running.find((c) => c.depart >= now - 60_000) ?? running[0];
}

// Passt der gewählte Zug noch zum GPS? Sonst neu zuordnen (z. B. einen Zug später genommen).
function plausible(conn, now) {
  if (!state.gps) return true;
  const pos = locate(conn, state.gps, now);
  return pos.source !== 'gps' || timeMismatch(conn, pos, now) < 5 * 60_000;
}

// ---------- Störungen ----------

const normName = (n) => String(n ?? '').toLowerCase().replace(/^münchen,\s*/, '').trim();

// Abschnitt aus Titeln wie "Sendlinger Tor <> Implerstraße: ..." -> ['sendlinger tor', 'implerstraße']
function sectionOf(title) {
  const m = /^(.+?)\s*<>\s*(.+?)(?::|$)/.exec(htmlToText(title));
  return m ? [normName(m[1]), normName(m[2])] : null;
}

// Meldungen, die meine Fahrt wirklich betreffen.
// incidents = akute Störungen (rot), notices = Baustellen/Fahrplanänderungen (meist schon im Fahrplan).
function relevantMessages(messages, conn, now) {
  const legs = conn.parts.filter(isTransit);
  const stopsOfLine = new Map();   // Linie -> Namen meiner Halte auf dieser Linie
  for (const p of legs) {
    const names = stopsOfLine.get(p.line.label) ?? new Set();
    for (const s of legStops(p)) names.add(normName(s.name));
    stopsOfLine.set(p.line.label, names);
  }
  const stations = new Set(conn.parts.flatMap((p) => legStops(p).map((s) => s.stationGlobalId)));

  const affects = (m) => {
    const myLines = (m.lines ?? []).map((l) => l.label).filter((l) => stopsOfLine.has(l));
    const hasLines = (m.lines ?? []).length > 0;
    // Bahnhofsmeldung: nur wenn sie eine meiner Linien oder gar keine Linie nennt (z. B. Aufzug defekt)
    const atMyStation = (m.stationGlobalIds ?? []).some((id) => stations.has(id));
    if (atMyStation && (!hasLines || myLines.length)) return true;
    if (!myLines.length) return false;
    // Linienmeldung mit Abschnitt: nur wenn meine Strecke den Abschnitt berührt
    const section = sectionOf(m.title);
    if (!section) return true;
    const text = normName(htmlToText(m.description));
    return myLines.some((l) => [...stopsOfLine.get(l)].some((n) => section.includes(n) || text.includes(n)));
  };

  const incidents = [], notices = [];
  for (const m of messages) {
    if (!affects(m)) continue;
    const ranges = m.incidentDurations?.length ? m.incidentDurations : [{ from: m.validFrom, to: m.validTo }];
    const isActive = ranges.some((r) => (r.from ?? 0) <= now && now <= (r.to ?? Infinity));
    const startsSoon = ranges.some((r) => r.from > now && r.from - now < 24 * 3600_000);
    if (m.type === 'INCIDENT' && isActive) incidents.push(m);
    else if (isActive || startsSoon) notices.push({ ...m, upcoming: !isActive });
  }
  // Meldungen direkt an meinem Zug/Abschnitt
  for (const p of conn.parts) for (const m of [...(p.messages ?? []), ...(p.infos ?? [])]) incidents.push(m);
  return { incidents, notices };
}

const htmlToText = (html) => {
  const div = document.createElement('div');
  div.innerHTML = String(html ?? '').replace(/<br\s*\/?>/gi, '\n');
  return div.textContent.trim();
};

// ---------- Alternativen ----------

// Für jeden der nächsten Halte: Was bringt Aussteigen dort, und was kostet es, den Anschluss zu verpassen?
async function computeAlternatives(conn, pos) {
  const part = conn.parts[pos.partIdx];
  const stops = legStops(part);
  const dest = conn.parts.at(-1).to;
  const ahead = stops.slice(pos.seg + 1).filter((s) => s.stationGlobalId !== dest.stationGlobalId).slice(0, ALT_STOPS_AHEAD);

  const results = await Promise.all(ahead.map(async (stop) => {
    const reach = arrTime(stop);
    let options;
    try { options = await fetchRoutes(stop.stationGlobalId, dest.stationGlobalId, new Date(reach)); }
    catch (e) { return { stop, error: e.message }; }
    // Gleiche Linie in gleicher Richtung ist keine Alternative (das ist dein Zug oder der nächste),
    // außer dein Zug fällt aus.
    const isSameLine = (o) => {
      const t = o.parts.find(isTransit);
      return t && t.line.label === part.line.label && t.line.destination === part.line.destination;
    };
    const others = options.filter((o) => !o.cancelled && o.firstTransitDepart >= reach && (conn.cancelled || !isSameLine(o)));
    if (!others.length) return { stop, best: null };
    const best = others.reduce((a, b) => (b.arrive < a.arrive ? b : a));
    // Verpasst man den ersten Anschluss, nimmt man die beste Verbindung, die später losfährt.
    const later = others.filter((o) => o.firstTransitDepart > best.firstTransitDepart);
    const fallback = later.length ? later.reduce((a, b) => (b.arrive < a.arrive ? b : a)) : null;
    return { stop, reach, best, fallback };
  }));
  return { base: conn, results };
}

// ---------- Zustand ----------

const state = {
  trip: null,        // { from, to }
  candidates: [],
  conn: null,
  manualKey: null,
  gps: null,
  gpsError: null,
  messages: [],
  messagesAt: 0,
  alternatives: null,
  altKey: null,
  timer: null,
  watchId: null,
  map: null,
  layers: null,
};

// ---------- Startseite ----------

const favorites = () => store('favorites', DEFAULT_FAVORITES);

function renderFavorites() {
  const list = $('#favorites');
  const favs = favorites();
  list.innerHTML = favs.length ? '' : '<li class="muted">Noch keine Favoriten.</li>';
  favs.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${esc(f.from.name)} → ${esc(f.to.name)}</span>
      <button class="primary go">Los</button><button class="del" aria-label="Löschen">✕</button>`;
    li.querySelector('.go').onclick = () => startTrip(f);
    li.querySelector('.del').onclick = () => {
      const next = favorites(); next.splice(i, 1); save('favorites', next); renderFavorites();
    };
    list.append(li);
  });
}

const picked = { from: null, to: null };

function setupStationInput(which) {
  const input = $(`#${which}-input`), list = $(`#${which}-suggest`);
  let timer;
  input.addEventListener('input', () => {
    picked[which] = null; updateNewButtons();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const res = (await searchStations(q)).slice(0, 6);
        list.innerHTML = '';
        for (const s of res) {
          const li = document.createElement('li');
          li.textContent = s.place && !s.name.includes(s.place) ? `${s.name} (${s.place})` : s.name;
          li.onclick = () => {
            picked[which] = { id: s.globalId, name: s.name };
            input.value = s.name; list.innerHTML = ''; updateNewButtons();
          };
          list.append(li);
        }
      } catch { list.innerHTML = '<li class="muted">Suche gerade nicht möglich</li>'; }
    }, 250);
  });
}

function updateNewButtons() {
  const ok = picked.from && picked.to && picked.from.id !== picked.to.id;
  $('#start-new').disabled = $('#save-new').disabled = !ok;
}

// ---------- Fahrt ----------

function startTrip(trip) {
  state.trip = trip;
  state.candidates = [];
  state.conn = null;
  state.manualKey = null;
  state.alternatives = null;
  state.altKey = null;
  $('#home').hidden = true;
  $('#trip').hidden = false;
  $('#back').hidden = false;
  $('#status').innerHTML = '<span class="muted">Suche deinen Zug …</span>';
  initMap();
  startGps();
  refresh();
  clearInterval(state.timer);
  state.timer = setInterval(refresh, REFRESH_MS);
  window.scrollTo(0, 0);
}

function stopTrip() {
  clearInterval(state.timer);
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.trip = null;
  $('#trip').hidden = true;
  $('#home').hidden = false;
  $('#back').hidden = true;
  $('#updated').textContent = '';
}

function startGps() {
  const sim = new URLSearchParams(location.search).get('pos');   // Test: ?pos=48.11,11.59
  if (sim) {
    const [lat, lon] = sim.split(',').map(Number);
    state.gps = { lat, lon, accuracy: 10 };
    return;
  }
  if (!('geolocation' in navigator)) { state.gpsError = 'Dieses Gerät bietet keinen Standort.'; return; }
  if (state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.gps = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
      state.gpsError = null;
      if (state.conn) render();
    },
    (e) => { state.gpsError = e.code === 1 ? 'Standort nicht freigegeben – Position wird aus dem Fahrplan geschätzt.' : 'Kein GPS-Signal – Position wird aus dem Fahrplan geschätzt.'; render(); },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
  );
}

async function refresh() {
  if (!state.trip) return;
  const now = Date.now();
  try {
    // 90 Minuten zurück, damit bereits fahrende Züge dabei sind
    const [early, late] = await Promise.all([
      fetchRoutes(state.trip.from.id, state.trip.to.id, new Date(now - 90 * 60_000)),
      fetchRoutes(state.trip.from.id, state.trip.to.id, new Date(now)),
    ]);
    const byKey = new Map();
    for (const c of [...early, ...late]) byKey.set(c.key, c);
    state.candidates = [...byKey.values()].sort((a, b) => a.depart - b.depart);

    const manual = state.manualKey && state.candidates.find((c) => c.key === state.manualKey);
    const previous = state.conn && state.candidates.find((c) => c.key === state.conn.key);
    state.conn = manual || (previous && plausible(previous, now) ? previous : pickTrain(state.candidates, state.gps, now));

    if (now - state.messagesAt > MESSAGES_REFRESH_MS) {
      try { state.messages = await api('/messages'); state.messagesAt = now; } catch { /* alte behalten */ }
    }
    $('#updated').textContent = `Stand ${fmtTime(now)}`;
    render();
    maybeAutoAlternatives();
  } catch (e) {
    $('#updated').textContent = 'offline?';
    if (!state.conn) $('#status').innerHTML = `<span class="delay">Keine Daten: ${esc(e.message)}</span>`;
  }
}

function maybeAutoAlternatives() {
  const conn = state.conn;
  if (!conn) return;
  const pos = locate(conn, state.gps, Date.now());
  if (pos.seg < 0 || pos.arrived) return;
  const { incidents } = relevantMessages(state.messages, conn, Date.now());
  const delayed = minutes(conn.arrive - Date.parse(conn.parts.at(-1).to.plannedDeparture)) >= AUTO_ALT_DELAY_MIN;
  const trouble = conn.cancelled || delayed || incidents.length > 0;
  const key = `${conn.key}|${pos.partIdx}|${pos.seg}`;
  if (trouble && state.altKey !== key) runAlternatives();
}

async function runAlternatives() {
  const conn = state.conn;
  if (!conn) return;
  const pos = locate(conn, state.gps, Date.now());
  state.altKey = `${conn.key}|${pos.partIdx}|${pos.seg}`;
  $('#alternatives').innerHTML = '<span class="muted">Rechne …</span>';
  state.alternatives = await computeAlternatives(conn, pos);
  renderAlternatives();
}

// ---------- Darstellung ----------

function badge(line) {
  const color = TYPE_COLORS[line?.transportType] ?? '#555';
  return `<span class="line-badge" style="background:${color}">${esc(line?.label ?? '?')}</span>`;
}

function delayText(min) {
  if (min > 0) return ` <span class="delay">+${min}</span>`;
  if (min < 0) return ` <span class="ontime">${min}</span>`;
  return '';
}

function render() {
  const conn = state.conn;
  if (!conn) return;
  const now = Date.now();
  const pos = locate(conn, state.gps, now);
  const part = conn.parts[pos.partIdx];
  const stops = legStops(part);
  const destTo = conn.parts.at(-1).to;
  const arrDelay = minutes(conn.arrive - Date.parse(destTo.plannedDeparture));

  let where;
  if (pos.arrived) where = 'Angekommen.';
  else if (pos.seg < 0) where = `Abfahrt in ${Math.max(0, minutes(depTime(stops[0]) - now))} min ab ${esc(stops[0].name)}${stops[0].platform ? `, Gleis ${esc(stops[0].platform)}` : ''}`;
  else if (pos.atStop != null && pos.atStop > 0) where = `In <b>${esc(stops[pos.atStop].name)}</b>`;
  else where = `Zwischen <b>${esc(stops[pos.seg].name)}</b> und <b>${esc(stops[pos.seg + 1].name)}</b>`;
  const source = pos.source === 'gps' ? 'per GPS' : 'geschätzt aus Fahrplan';

  $('#status').innerHTML = `
    <div>${badge(part.line)}<b>${esc(part.line.destination)}</b>${conn.cancelled ? ' <span class="delay">fällt aus</span>' : ''}</div>
    <div class="big">Ankunft ${fmtTime(conn.arrive)}${delayText(arrDelay)}</div>
    <div class="muted">${esc(destTo.name)}</div>
    <div style="margin-top:6px">${where} <span class="muted small">(${source})</span></div>`;

  const { incidents, notices } = relevantMessages(state.messages, conn, now);
  const openNotices = $('#alerts .notices')?.open ? ' open' : '';
  $('#alerts').innerHTML = incidents.map(alertHtml).join('') + (notices.length ? `
    <details class="notices card"${openNotices}>
      <summary>${notices.length} ${notices.length === 1 ? 'Hinweis' : 'Hinweise'} zu Baustellen &amp; Fahrplanänderungen</summary>
      ${notices.map(noticeHtml).join('')}
    </details>` : '');

  $('#stops').innerHTML = stops.map((s, i) => {
    const cls = i <= pos.seg ? 'past' : i === pos.seg + 1 ? 'next' : '';
    return `<li class="${cls}"><span class="t">${fmtTime(Date.parse(s.plannedDeparture))}${delayText(delayOf(s))}</span><span>${esc(s.name)}</span></li>`;
  }).join('') + (conn.parts.length > 1 ? `<li class="muted small">Weitere Abschnitte: ${conn.parts.filter(isTransit).map((p) => esc(p.line.label)).join(' → ')}</li>` : '');

  $('#position-hint').textContent = state.gpsError ?? (state.gps ? `GPS-Genauigkeit ca. ${Math.round(state.gps.accuracy)} m` : 'Warte auf Standort …');
  renderMap(conn, pos, stops);
}

function alertHtml(m) {
  const text = htmlToText(m.description ?? m.text ?? '');
  return `<div class="alert">
    <h3>${esc(m.title ?? htmlToText(m.text) ?? 'Störung')}</h3>
    ${text ? `<details><summary>Details</summary>${esc(text)}</details>` : ''}
  </div>`;
}

function noticeHtml(m) {
  const text = htmlToText(m.description ?? '');
  return `<div class="notice">
    <b>${m.upcoming ? 'Ab demnächst: ' : ''}${esc(htmlToText(m.title))}</b>
    ${text ? `<details><summary>Details</summary>${esc(text)}</details>` : ''}
  </div>`;
}

function legsText(conn) {
  return conn.parts.filter(isTransit).map((p) => `${esc(p.line.label)} ${fmtTime(depTime(p.from))} ab ${esc(p.from.name)}`).join(' · ');
}

function renderAlternatives() {
  const alt = state.alternatives;
  if (!alt) return;
  const base = alt.base;
  const stayLabel = base.parts.filter(isTransit).length > 1 ? 'Wie geplant weiterfahren' : 'Sitzen bleiben';
  const html = [`<div class="alt stay"><div class="head">${stayLabel}: an ${fmtTime(base.arrive)}</div></div>`];
  let any = false;
  for (const r of alt.results) {
    if (r.error) { html.push(`<div class="alt muted">${esc(r.stop.name)}: ${esc(r.error)}</div>`); continue; }
    if (!r.best) continue;
    const gain = minutes(base.arrive - r.best.arrive);
    if (!base.cancelled && gain < MIN_USEFUL_GAIN_MIN) continue;
    any = true;
    const buffer = minutes(r.best.firstTransitDepart - r.reach);
    const gainText = gain > 0 ? `${gain} min schneller` : gain < 0 ? `${-gain} min langsamer` : 'gleich schnell';
    const missText = r.fallback
      ? `Verpasst du den Anschluss: an ${fmtTime(r.fallback.arrive)} (+${minutes(r.fallback.arrive - r.best.arrive)} min)`
      : 'Verpasst du den Anschluss: keine spätere Verbindung gefunden';
    html.push(`<div class="alt ${gain > 0 ? 'better' : ''}">
      <div class="head">In ${esc(r.stop.name)} aussteigen: an ${fmtTime(r.best.arrive)} – ${gainText}</div>
      <div class="legs">${legsText(r.best)}</div>
      <div class="risk">Umstiegszeit ${buffer} min${buffer <= 2 ? ' – knapp!' : ''} · ${missText}</div>
    </div>`);
  }
  if (!any) html.push(`<div class="muted small">An den nächsten ${alt.results.length || ''} Halten gibt es keine schnellere Verbindung.</div>`);
  html.push(`<div class="muted small" style="margin-top:6px">Stand ${fmtTime(Date.now())}. Prognosen bei Störungen sind oft ungenau.</div>`);
  $('#alternatives').innerHTML = html.join('');
}

function initMap() {
  if (state.map || !window.L) return;
  state.map = L.map('map', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap',
  }).addTo(state.map);
  state.layers = L.layerGroup().addTo(state.map);
  state.map.setView([48.137, 11.575], 11);
}

function renderMap(conn, pos, stops) {
  if (!state.map) return;
  state.layers.clearLayers();
  const bounds = [];
  conn.parts.forEach((p, i) => {
    const pts = p.pathPolyline ? decodePolyline(p.pathPolyline) : legStops(p).map((s) => [s.latitude, s.longitude]);
    if (!pts.length) return;
    const color = isTransit(p) ? TYPE_COLORS[p.line.transportType] ?? '#555' : '#888';
    L.polyline(pts, { color, weight: i === pos.partIdx ? 6 : 4, opacity: i === pos.partIdx ? 0.9 : 0.5, dashArray: isTransit(p) ? null : '4 6' }).addTo(state.layers);
    bounds.push(...pts);
  });
  stops.forEach((s, i) => {
    L.circleMarker([s.latitude, s.longitude], {
      radius: i === pos.seg + 1 ? 7 : 4, color: '#fff', weight: 2,
      fillColor: i <= pos.seg ? '#999' : TYPE_COLORS[conn.parts[pos.partIdx].line.transportType] ?? '#555', fillOpacity: 1,
    }).bindTooltip(s.name).addTo(state.layers);
  });
  if (state.gps) {
    L.circleMarker([state.gps.lat, state.gps.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(state.layers);
  }
  if (!state.mapFitted && bounds.length) {
    state.map.fitBounds(bounds, { padding: [20, 20] });
    state.mapFitted = true;
  }
}

function cycleTrain() {
  const now = Date.now();
  const running = state.candidates.filter((c) => c.arrive >= now && !c.cancelled);
  if (!running.length) return;
  const i = running.findIndex((c) => c.key === state.conn?.key);
  state.conn = running[(i + 1) % running.length];
  state.manualKey = state.conn.key;
  state.alternatives = null;
  state.altKey = null;
  $('#alternatives').innerHTML = '<span class="muted small">Zug gewechselt – tippe auf „Prüfen“.</span>';
  render();
}

// ---------- Start ----------

setupStationInput('from');
setupStationInput('to');
$('#start-new').onclick = () => startTrip({ from: picked.from, to: picked.to });
$('#save-new').onclick = () => {
  save('favorites', [...favorites(), { from: picked.from, to: picked.to }]);
  renderFavorites();
};
$('#back').onclick = stopTrip;
$('#stop-trip').onclick = stopTrip;
$('#check-alt').onclick = runAlternatives;
$('#other-train').onclick = cycleTrain;
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.trip) refresh(); });
renderFavorites();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
