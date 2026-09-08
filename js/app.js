/* ============================================================
   Buddy Finder — wiring.

   Screens, geolocation, heading fusion, the buddy list, the
   compass view, and all the little festival affordances.
   ============================================================ */

import { firebaseConfig, isConfigured, TUNING } from "./config.js";
import { newCrewCode, normalizeCode, formatCode, deriveCrew } from "./crypto.js";
import { Crew } from "./transport.js";
import { Compass } from "./compass.js";
import { CrewMap, BASE_LAYERS, escapeHtml } from "./map.js";
import {
  distance, bearing, fmtDistance, fmtDistanceShort, fmtWalk, fmtAge,
  compassPoint, smoothAngle, unwrap, norm360
} from "./geo.js";

/* ── constants ───────────────────────────────────────────── */

const EMOJI = ["🦊", "🐙", "🦩", "🐝", "🍄", "🌵", "🛸", "🎈", "🔥", "🐬", "🦖", "🎧"];
const COLORS = ["#ff5c7a", "#ffb046", "#ffe14d", "#5ce1a0", "#4ecdff", "#8b7cff", "#ff8a3d", "#c2f24a"];

const LS = {
  profile: "fbf.profile",
  crew: "fbf.crew",
  split: "fbf.split",
  layer: "fbf.layer",
  wake: "fbf.wake",
  hiacc: "fbf.hiacc",
  snap: (id) => `fbf.snap.${id}`
};

/* ── state ───────────────────────────────────────────────── */

const state = {
  profile: { name: "", emoji: EMOJI[0], color: COLORS[1] },
  crew: null,          // { code, pretty, crewId, key }
  transport: null,
  uid: null,

  self: null,          // { lat, lon, acc, spd, hdg, t }
  lastSent: 0,
  lastSentPos: null,
  geoError: null,

  members: {},         // uid -> payload
  pins: {},            // uid -> payload
  focusUid: null,

  heading: null,       // fused, degrees from true north
  headingSource: "none",
  arrowUnwrapped: null,
  rowUnwrapped: new Map(),

  wakeLock: null,
  tickTimer: null,
  slowTimer: null
};

const compass = new Compass();
const crewMap = new CrewMap();

/* ── tiny DOM helpers ────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const show = (el) => { if (el) el.hidden = false; };
const hide = (el) => { if (el) el.hidden = true; };

function toast(msg, ms = 2400) {
  const el = $("toast");
  el.textContent = msg;
  show(el);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(el), ms);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/* ── screens ─────────────────────────────────────────────── */

function goto(screen) {
  for (const id of ["screen-boot", "screen-setup", "screen-welcome", "screen-main"]) {
    const el = $(id);
    if (el) el.hidden = id !== screen;
  }
}

/* ── boot ────────────────────────────────────────────────── */

function boot() {
  state.profile = { ...state.profile, ...readJSON(LS.profile, {}) };

  if (!isConfigured()) {
    goto("screen-setup");
    return;
  }

  buildPickers("emoji-row", "color-row", () => {});
  buildPickers("emoji-row-2", "color-row-2", () => {
    writeJSON(LS.profile, state.profile);
    if (state.transport) sendPosition(true);
    syncRows();
  });

  // Drive the inputs from the same constant the trimming uses, so the two
  // can never drift apart.
  for (const id of ["in-name", "in-name-2"]) {
    const el = $(id);
    if (el) el.maxLength = TUNING.maxNameLength;
  }

  wireWelcome();
  wireMain();
  wireSheets();
  registerServiceWorker();

  const fromLink = normalizeCode(new URLSearchParams(location.hash.slice(1)).get("c") || "");
  const remembered = normalizeCode(localStorage.getItem(LS.crew) || "");
  const code = fromLink || remembered;

  if (code && state.profile.name) {
    enterCrew(code).catch((err) => {
      console.error(err);
      goto("screen-welcome");
      showJoinError(err.message || "Could not open that crew.");
    });
  } else {
    goto("screen-welcome");
    $("in-name").value = state.profile.name || "";
    if (code) $("in-code").value = formatCode(code);
  }
}

/**
 * Tapping an invite link while the app is already open only changes the
 * hash, which never reloads the page — so handle it by hand.
 */
window.addEventListener("hashchange", () => {
  const incoming = normalizeCode(new URLSearchParams(location.hash.slice(1)).get("c") || "");
  const stripHash = () => history.replaceState(null, "", location.pathname + location.search);
  if (!incoming) return;

  if (state.crew && incoming === state.crew.code) { stripHash(); return; }
  if (state.crew && !confirm("Open this invite? You'll leave your current crew.")) { stripHash(); return; }

  localStorage.setItem(LS.crew, incoming);
  location.reload();
});

/* ── profile pickers ─────────────────────────────────────── */

function buildPickers(emojiId, colorId, onChange) {
  const emojiRow = $(emojiId);
  const colorRow = $(colorId);
  if (!emojiRow || !colorRow) return;

  emojiRow.innerHTML = "";
  for (const e of EMOJI) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", `Emoji ${e}`);
    b.textContent = e;
    b.addEventListener("click", () => {
      state.profile.emoji = e;
      refreshPickers();
      writeJSON(LS.profile, state.profile);
      onChange();
    });
    emojiRow.appendChild(b);
  }

  colorRow.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip chip-color";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", `Colour ${c}`);
    b.style.color = c;
    const i = document.createElement("i");
    i.style.background = c;
    b.appendChild(i);
    b.addEventListener("click", () => {
      state.profile.color = c;
      refreshPickers();
      writeJSON(LS.profile, state.profile);
      onChange();
    });
    colorRow.appendChild(b);
  }

  refreshPickers();
}

function refreshPickers() {
  for (const id of ["emoji-row", "emoji-row-2"]) {
    const row = $(id);
    if (!row) continue;
    [...row.children].forEach((b, i) =>
      b.setAttribute("aria-checked", EMOJI[i] === state.profile.emoji ? "true" : "false"));
  }
  for (const id of ["color-row", "color-row-2"]) {
    const row = $(id);
    if (!row) continue;
    [...row.children].forEach((b, i) =>
      b.setAttribute("aria-checked", COLORS[i] === state.profile.color ? "true" : "false"));
  }
}

/* ── welcome screen ──────────────────────────────────────── */

function showJoinError(msg) {
  const el = $("join-error");
  el.textContent = msg;
  show(el);
}

function takeName() {
  const name = ($("in-name").value || "").trim().slice(0, TUNING.maxNameLength);
  if (!name) {
    $("in-name").focus();
    showJoinError("Pick a name first, so your crew knows which dot is you.");
    return null;
  }
  state.profile.name = name;
  writeJSON(LS.profile, state.profile);
  hide($("join-error"));
  return name;
}

function wireWelcome() {
  $("btn-create").addEventListener("click", async () => {
    if (!takeName()) return;
    const code = normalizeCode(newCrewCode());
    try {
      await enterCrew(code);
      openSheet("sheet-share");
    } catch (err) {
      showJoinError(err.message || "Could not start a crew.");
    }
  });

  $("btn-join").addEventListener("click", joinFromInput);
  $("in-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinFromInput(); });
  $("in-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("in-code").focus(); });

  // Re-format the code as it is typed, so it always reads XXXX-XXXX-...
  $("in-code").addEventListener("input", (e) => {
    const el = e.target;
    const atEnd = el.selectionStart === el.value.length;
    const raw = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    el.value = formatCode(raw);
    if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
  });

  async function joinFromInput() {
    if (!takeName()) return;
    const code = normalizeCode($("in-code").value);
    if (!code) {
      showJoinError("That code isn't complete — it should be 16 letters and numbers.");
      return;
    }
    try {
      await enterCrew(code);
    } catch (err) {
      showJoinError(err.message || "Could not join that crew.");
    }
  }
}

/* ── entering a crew ─────────────────────────────────────── */

async function enterCrew(code) {
  state.crew = await deriveCrew(code);
  localStorage.setItem(LS.crew, state.crew.code);
  history.replaceState(null, "", location.pathname + location.search);

  goto("screen-main");
  $("crew-label").textContent = `Crew ${state.crew.pretty.slice(0, 4)}`;
  $("in-name-2").value = state.profile.name;
  refreshPickers();

  applySplit(readJSON(LS.split, 46));
  await crewMap.init($("map"), localStorage.getItem(LS.layer) || "map");
  crewMap.invalidate();
  crewMap.onLongPress((pos) => dropPin(pos));

  // Show whatever we saw last time straight away, so an offline start
  // still tells you where everyone was.
  const cached = readJSON(LS.snap(state.crew.crewId), null);
  if (cached && cached.members) {
    state.members = cached.members;
    state.pins = cached.pins || {};
  }

  $("btn-layer").dataset.active = crewMap.baseName === "satellite" ? "true" : "false";
  updatePinButton();
  syncRows();

  startGeolocation();
  startCompass();
  startTicking();
  await connect();
}

async function connect() {
  setNet("connecting", "connecting…");
  const crew = new Crew({ crewId: state.crew.crewId, key: state.crew.key });
  state.transport = crew;

  crew.on("status", (s) => {
    if (s === "online") setNet("online", "live");
    else if (s === "denied") {
      setNet("offline", "database rules not published");
      toast("Firebase rejected the connection. Paste database.rules.json into the Rules tab and publish.", 7000);
    } else if (s === "offline") setNet("offline", "no connection — showing last known");
  });

  crew.on("members", (members) => {
    state.members = members;
    persistSnapshot();
    syncRows();
  });

  crew.on("pins", (pins) => {
    state.pins = pins;
    persistSnapshot();
    syncRows();
    updatePinButton();
  });

  try {
    state.uid = await crew.connect(firebaseConfig);
    if (state.self) sendPosition(true);
  } catch (err) {
    console.error("[connect]", err);
    setNet("offline", "can't reach the server");
    toast("Couldn't reach Firebase. Check config.js and your signal.", 5000);
  }
}

function setNet(stateName, label) {
  $("net-dot").dataset.state = stateName;
  $("net-label").textContent = label;
}

function persistSnapshot() {
  if (!state.crew) return;
  writeJSON(LS.snap(state.crew.crewId), { members: state.members, pins: state.pins });
}

/* ── geolocation ─────────────────────────────────────────── */

let watchId = null;

function startGeolocation() {
  if (!("geolocation" in navigator)) {
    state.geoError = "This browser has no location support.";
    return;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);

  const hiacc = readJSON(LS.hiacc, true);
  $("tg-hiacc").checked = hiacc;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      state.geoError = null;
      state.self = {
        lat: c.latitude,
        lon: c.longitude,
        acc: Number.isFinite(c.accuracy) ? c.accuracy : null,
        spd: Number.isFinite(c.speed) ? c.speed : null,
        hdg: Number.isFinite(c.heading) ? c.heading : null,
        t: Date.now()
      };
      maybeSend();
    },
    (err) => {
      state.geoError =
        err.code === 1 ? "Location permission is off. Turn it on in your browser settings."
        : err.code === 2 ? "No GPS fix yet — try stepping into the open."
        : "Location is taking a while…";
    },
    { enableHighAccuracy: hiacc, maximumAge: 2000, timeout: 30000 }
  );
}

function maybeSend() {
  if (!state.transport || !state.self) return;
  const now = Date.now();
  const since = now - state.lastSent;
  const moved = state.lastSentPos ? distance(state.lastSentPos, state.self) : Infinity;

  const worthIt = since >= TUNING.minSendMs && moved >= TUNING.moveThresholdM;
  const overdue = since >= TUNING.heartbeatMs;
  if (worthIt || overdue) sendPosition();
}

function sendPosition(force = false) {
  if (!state.transport || !state.self) return;
  if (!force && Date.now() - state.lastSent < TUNING.minSendMs) return;

  state.lastSent = Date.now();
  state.lastSentPos = { lat: state.self.lat, lon: state.self.lon };

  state.transport.sendSelf({
    v: 1,
    n: state.profile.name,
    e: state.profile.emoji,
    c: state.profile.color,
    lat: round6(state.self.lat),
    lon: round6(state.self.lon),
    a: state.self.acc == null ? null : Math.round(state.self.acc),
    s: state.self.spd == null ? null : Math.round(state.self.spd * 10) / 10,
    h: state.self.hdg == null ? null : Math.round(state.self.hdg)
  }).catch(() => { /* offline; the reconnect handler resends */ });
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/* ── heading fusion ──────────────────────────────────────── */

function startCompass() {
  const btn = $("btn-compass-perm");
  if (compass.needsPermission) {
    show(btn);
    btn.onclick = async () => {
      const ok = await compass.requestPermission();
      if (ok) { compass.start(); hide(btn); toast("Compass on"); }
      else toast("Compass permission denied");
    };
  }
  compass.start();
}

/**
 * GPS course beats the magnetometer whenever we are actually moving:
 * it is derived from successive fixes, so speaker magnets and steel
 * scaffolding cannot bend it. The magnetometer only fills in while
 * you stand still.
 */
function updateHeading() {
  const moving =
    state.self &&
    Number.isFinite(state.self.spd) &&
    state.self.spd >= TUNING.gpsHeadingMinSpeed &&
    Number.isFinite(state.self.hdg);

  if (moving) {
    state.heading = smoothAngle(state.heading, state.self.hdg, 0.35);
    state.headingSource = "gps";
  } else if (compass.live && Number.isFinite(compass.heading)) {
    state.heading = smoothAngle(state.heading, compass.heading, 0.3);
    state.headingSource = "compass";
  } else {
    state.headingSource = "none";
  }
}

/* ── the target list ─────────────────────────────────────── */

/** Everyone and everything you might navigate to, minus yourself. */
function targets() {
  const now = state.transport ? state.transport.now() : Date.now();
  const out = [];

  for (const [uid, m] of Object.entries(state.members)) {
    if (uid === state.uid) continue;
    const age = m.t ? now - m.t : 0;
    if (age > TUNING.dropMs) continue;
    out.push({
      uid, kind: "person",
      name: m.n || "Someone",
      emoji: m.e || "🙂",
      color: m.c || COLORS[4],
      lat: m.lat, lon: m.lon, acc: m.a,
      stamp: m.t, age, stale: age > TUNING.staleMs
    });
  }

  for (const [uid, p] of Object.entries(state.pins)) {
    const age = p.t ? now - p.t : 0;
    out.push({
      uid: `pin:${uid}`, kind: "pin", ownerUid: uid,
      name: p.l || "Meet here",
      emoji: "📍",
      color: "#4ecdff",
      lat: p.lat, lon: p.lon, acc: null,
      stamp: p.t, age, stale: false
    });
  }

  for (const t of out) {
    t.dist = state.self ? distance(state.self, t) : null;
    t.bear = state.self ? bearing(state.self, t) : null;
  }

  out.sort((a, b) => {
    if (a.dist == null) return 1;
    if (b.dist == null) return -1;
    return a.dist - b.dist;
  });
  return out;
}

/* ── list rendering ──────────────────────────────────────── */

const rowCache = new Map(); // uid -> { el, refs }
let appliedOrder = "";

function syncRows() {
  const list = $("buddy-list");
  if (!list) return;

  const items = targets();
  const wanted = new Set(items.map((t) => t.uid));

  const selfEntry = ensureSelfRow();

  for (const [uid, entry] of rowCache) {
    if (uid !== "__self" && !wanted.has(uid)) {
      entry.el.remove();
      rowCache.delete(uid);
      state.rowUnwrapped.delete(uid);
    }
  }

  for (const t of items) {
    let entry = rowCache.get(t.uid);
    if (!entry) {
      entry = buildRow(t);
      rowCache.set(t.uid, entry);
    }
    entry.data = t;
    entry.refs.avatar.textContent = t.emoji;
    entry.refs.avatar.style.color = t.color;
    entry.refs.name.textContent = t.name;
    entry.el.dataset.stale = t.stale ? "true" : "false";
  }

  // Only touch the DOM order when it has genuinely changed — re-appending
  // a row mid-tap would swallow the tap.
  const order = items.map((t) => t.uid).join("|");
  if (order !== appliedOrder || !selfEntry.el.parentNode) {
    appliedOrder = order;
    list.appendChild(selfEntry.el);
    for (const t of items) list.appendChild(rowCache.get(t.uid).el);
  }

  const empty = $("list-empty");
  if (items.length === 0) { show(empty); } else { hide(empty); }

  updateRows();
  updateMapItems(items);
}

function ensureSelfRow() {
  let entry = rowCache.get("__self");
  if (!entry) {
    const el = document.createElement("div");
    el.className = "row";
    el.dataset.self = "true";
    el.dataset.focusable = "false";
    el.innerHTML = `
      <div class="row-avatar"></div>
      <div class="row-mid">
        <div class="row-name"></div>
        <div class="row-meta"></div>
      </div>
      <div class="row-right"><span class="tag" data-kind="you">You</span></div>`;
    entry = {
      el,
      refs: {
        avatar: el.querySelector(".row-avatar"),
        name: el.querySelector(".row-name"),
        meta: el.querySelector(".row-meta")
      }
    };
    rowCache.set("__self", entry);
  }
  entry.refs.avatar.textContent = state.profile.emoji;
  entry.refs.avatar.style.color = state.profile.color;
  entry.refs.name.textContent = state.profile.name || "You";
  return entry;
}

function buildRow(t) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "row";
  el.dataset.focusable = "true";
  el.innerHTML = `
    <div class="row-avatar"></div>
    <div class="row-mid">
      <div class="row-name"></div>
      <div class="row-meta"><span class="age"></span><span class="sep">·</span><span class="dir"></span></div>
    </div>
    <div class="row-right">
      <span class="row-dist"></span>
      <span class="row-arrow"><svg viewBox="-50 -50 100 100"><path d="M0 -38 L27 33 L0 17 L-27 33 Z" fill="currentColor"/></svg></span>
    </div>`;
  const entry = {
    el,
    refs: {
      avatar: el.querySelector(".row-avatar"),
      name: el.querySelector(".row-name"),
      age: el.querySelector(".age"),
      dir: el.querySelector(".dir"),
      dist: el.querySelector(".row-dist"),
      arrow: el.querySelector(".row-arrow svg")
    }
  };
  el.addEventListener("click", () => setFocus(t.uid));
  return entry;
}

function updateRows() {
  const selfEntry = rowCache.get("__self");
  if (selfEntry) {
    const bits = [];
    if (state.geoError) bits.push(state.geoError);
    else if (!state.self) bits.push("waiting for GPS…");
    else bits.push(state.self.acc == null ? "located" : `accurate to about ${Math.round(state.self.acc)} m`);
    selfEntry.refs.meta.textContent = bits.join(" ");
  }

  const now = state.transport ? state.transport.now() : Date.now();

  for (const [uid, entry] of rowCache) {
    if (uid === "__self" || !entry.data) continue;
    const t = entry.data;

    // Recompute against the live position — you move far more often than
    // your buddies send updates, and a frozen distance is a lie.
    if (state.self) {
      t.dist = distance(state.self, t);
      t.bear = bearing(state.self, t);
    }
    t.age = t.stamp ? now - t.stamp : 0;
    t.stale = t.kind === "person" && t.age > TUNING.staleMs;
    entry.el.dataset.stale = t.stale ? "true" : "false";

    entry.refs.dist.textContent = t.dist == null ? "—" : fmtDistanceShort(t.dist);
    entry.refs.age.textContent =
      t.kind === "pin"
        ? (t.age < 15000 ? "just dropped" : `dropped ${fmtAge(t.age)} ago`)
        : (t.stale ? `last seen ${fmtAge(t.age)} ago` : fmtAge(t.age));
    entry.refs.dir.textContent = t.bear == null ? "" : `${compassPoint(t.bear)} of you`;

    if (t.bear != null) {
      const rel = state.headingSource === "none" ? t.bear : t.bear - state.heading;
      const prev = state.rowUnwrapped.get(uid);
      const next = unwrap(prev, norm360(rel));
      state.rowUnwrapped.set(uid, next);
      entry.refs.arrow.style.transform = `rotate(${next}deg)`;
      entry.refs.arrow.style.color = t.stale ? "" : t.color;
    }
  }
}

function updateMapItems(items) {
  crewMap.setItems(
    items.map((t) => ({
      uid: t.uid, kind: t.kind, name: t.name, emoji: t.emoji,
      color: t.color, lat: t.lat, lon: t.lon, stale: t.stale
    })),
    (uid) => setFocus(uid)
  );
}

/* ── focus / compass view ────────────────────────────────── */

function setFocus(uid) {
  state.focusUid = uid;
  crewMap.setFocus(uid);
  hide($("view-list"));
  show($("view-focus"));

  const t = targets().find((x) => x.uid === uid);
  if (t && state.self) crewMap.fitAll([state.self, t]);
  renderFocus();
}

function clearFocus() {
  state.focusUid = null;
  crewMap.setFocus(null);
  hide($("view-focus"));
  show($("view-list"));
  syncRows();
}

function renderFocus() {
  if (!state.focusUid) return;
  const t = targets().find((x) => x.uid === state.focusUid);
  if (!t) {
    clearFocus();
    toast("They dropped off the map");
    return;
  }

  $("focus-emoji").textContent = t.emoji;
  $("focus-name").textContent = t.name;

  const fresh = $("focus-fresh");
  fresh.textContent = t.kind === "pin" ? "pin" : fmtAge(t.age);
  fresh.dataset.stale = t.stale ? "true" : "false";

  const d = fmtDistance(t.dist);
  $("focus-dist").innerHTML = `${escapeHtml(d.value)}<small>${escapeHtml(d.unit)}</small>`;
  $("focus-eta").textContent =
    t.dist == null ? "waiting for your GPS fix" : fmtWalk(t.dist, TUNING.walkSpeed);

  const arrow = $("arrow");
  const rot = $("arrow-rot");
  const unknown = state.headingSource === "none";
  arrow.dataset.unknown = unknown ? "true" : "false";
  arrow.dataset.stale = t.stale ? "true" : "false";

  if (t.bear != null) {
    const rel = unknown ? t.bear : t.bear - state.heading;
    state.arrowUnwrapped = unwrap(state.arrowUnwrapped, norm360(rel));
    rot.style.transform = `rotate(${state.arrowUnwrapped}deg)`;
  }

  const warn = $("focus-warn");
  if (unknown) {
    warn.textContent = "No heading yet. Take a few steps and the arrow locks on — until then it points as if the top of your phone faces north.";
    show(warn);
  } else if (t.stale) {
    warn.textContent = `This is where ${t.name} was ${fmtAge(t.age)} ago. Their phone has stopped reporting.`;
    show(warn);
  } else {
    hide(warn);
  }

  $("focus-src").textContent =
    state.headingSource === "gps" ? "heading from GPS course"
    : state.headingSource === "compass" ? "heading from compass"
    : "no heading";

  const accBits = [];
  if (state.self && state.self.acc != null) accBits.push(`you ±${Math.round(state.self.acc)} m`);
  if (t.acc != null) accBits.push(`them ±${Math.round(t.acc)} m`);
  $("focus-acc").textContent = accBits.join(" · ");
}

/* ── pins ────────────────────────────────────────────────── */

function myPin() {
  return state.uid ? state.pins[state.uid] : null;
}

function updatePinButton() {
  $("pin-btn-label").textContent = myPin() ? "Remove my pin" : "Drop a meet pin here";
}

async function dropPin(pos) {
  if (!state.transport) { toast("Not connected yet"); return; }
  const at = pos || (crewMap.map ? { lat: crewMap.map.getCenter().lat, lon: crewMap.map.getCenter().lng } : state.self);
  if (!at) { toast("No position yet"); return; }
  await state.transport.setPin({
    v: 1,
    l: `${state.profile.name}'s pin`,
    lat: round6(at.lat),
    lon: round6(at.lon)
  });
  toast("Pin dropped — everyone can see it");
}

async function removePin() {
  if (!state.transport) return;
  await state.transport.setPin(null);
  toast("Pin removed");
}

/* ── main screen wiring ──────────────────────────────────── */

function wireMain() {
  $("btn-unfocus").addEventListener("click", clearFocus);

  $("btn-recenter").addEventListener("click", () => {
    if (state.self) crewMap.recenter(state.self);
    else toast(state.geoError || "No GPS fix yet");
  });

  $("btn-fit").addEventListener("click", () => {
    const pts = targets().filter((t) => t.lat != null);
    if (state.self) pts.push(state.self);
    if (pts.length) crewMap.fitAll(pts);
    else toast("Nothing to fit on screen yet");
  });

  $("btn-layer").addEventListener("click", () => {
    const name = crewMap.cycleBaseLayer();
    localStorage.setItem(LS.layer, name);
    $("btn-layer").dataset.active = name === "satellite" ? "true" : "false";
    toast(BASE_LAYERS[name].label);
  });

  $("btn-pin").addEventListener("click", () => (myPin() ? removePin() : dropPin(null)));

  $("btn-share").addEventListener("click", () => openSheet("sheet-share"));
  $("btn-share-2").addEventListener("click", () => openSheet("sheet-share"));
  $("btn-settings").addEventListener("click", () => openSheet("sheet-settings"));
  $("btn-back-home").addEventListener("click", leaveCrew);

  wireSplitter();
}

function startTicking() {
  if (state.tickTimer) clearInterval(state.tickTimer);
  if (state.slowTimer) clearInterval(state.slowTimer);

  // Fast loop: smooth arrows and live distances.
  state.tickTimer = setInterval(() => {
    updateHeading();
    if (state.focusUid) renderFocus();
    else updateRows();
    if (state.self) crewMap.setSelf(state.self, state.headingSource === "none" ? null : state.heading, state.self.acc);
    // A heartbeat send keeps "last seen" honest even when standing still.
    if (state.transport && Date.now() - state.lastSent >= TUNING.heartbeatMs) sendPosition();
  }, 250);

  // Slow loop: re-sort the list and let map markers go grey when someone
  // stops reporting. Without this, a phone that dies simply freezes on
  // the map and never admits it.
  state.slowTimer = setInterval(() => {
    if (!state.focusUid) syncRows();
    else updateMapItems(targets());
  }, 3000);
}

/* ── splitter ────────────────────────────────────────────── */

function applySplit(vh) {
  const clamped = Math.max(22, Math.min(72, vh));
  document.documentElement.style.setProperty("--map-h", `${clamped}vh`);
  writeJSON(LS.split, clamped);
  return clamped;
}

function wireSplitter() {
  const bar = $("splitter");
  let dragging = false;

  const move = (clientY) => {
    const top = $("map").getBoundingClientRect().top;
    applySplit(((clientY - top) / window.innerHeight) * 100);
    crewMap.invalidate();
  };

  bar.addEventListener("pointerdown", (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => { if (dragging) move(e.clientY); });
  bar.addEventListener("pointerup", (e) => {
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    crewMap.invalidate();
  });
  bar.addEventListener("keydown", (e) => {
    const cur = readJSON(LS.split, 46);
    if (e.key === "ArrowUp") { applySplit(cur - 4); crewMap.invalidate(); e.preventDefault(); }
    if (e.key === "ArrowDown") { applySplit(cur + 4); crewMap.invalidate(); e.preventDefault(); }
  });

  window.addEventListener("resize", () => crewMap.invalidate());
}

/* ── sheets ──────────────────────────────────────────────── */

function openSheet(id) {
  show($("scrim"));
  show($(id));
  if (id === "sheet-share") renderShare();
}

function closeSheets() {
  hide($("scrim"));
  hide($("sheet-share"));
  hide($("sheet-settings"));
}

function crewLink() {
  return `${location.origin}${location.pathname}#c=${state.crew.code}`;
}

function wireSheets() {
  $("scrim").addEventListener("click", closeSheets);
  for (const b of document.querySelectorAll(".sheet-close")) b.addEventListener("click", closeSheets);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

  $("btn-copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(crewLink());
      toast("Link copied — paste it in the group chat");
    } catch {
      toast("Couldn't copy. Long-press the code to select it.");
    }
  });

  $("btn-native-share").addEventListener("click", async () => {
    const data = { title: "Buddy Finder", text: "Join my crew so we can find each other:", url: crewLink() };
    if (navigator.share) {
      try { await navigator.share(data); } catch { /* user cancelled */ }
    } else {
      $("btn-copy-link").click();
    }
  });

  $("in-name-2").addEventListener("input", (e) => {
    state.profile.name = e.target.value.trim().slice(0, TUNING.maxNameLength);
    writeJSON(LS.profile, state.profile);
    syncRows();
  });
  $("in-name-2").addEventListener("change", () => sendPosition(true));

  $("tg-wake").checked = readJSON(LS.wake, false);
  $("tg-wake").addEventListener("change", (e) => {
    writeJSON(LS.wake, e.target.checked);
    if (e.target.checked) acquireWakeLock();
    else releaseWakeLock();
  });
  if (readJSON(LS.wake, false)) acquireWakeLock();

  $("tg-hiacc").addEventListener("change", (e) => {
    writeJSON(LS.hiacc, e.target.checked);
    startGeolocation();
    toast(e.target.checked ? "High accuracy on" : "Battery saver on");
  });

  $("btn-prefetch").addEventListener("click", async () => {
    const btn = $("btn-prefetch");
    const status = $("prefetch-status");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const { done, total } = await crewMap.prefetchArea({
        spread: TUNING.prefetchZoomSpread,
        max: TUNING.prefetchMaxTiles,
        onProgress: (d, t) => { status.textContent = `${d} of ${t} tiles saved…`; }
      });
      status.textContent = `${done} tiles saved. This area now works without signal.`;
    } catch {
      status.textContent = "Couldn't save the tiles — check your connection.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Save this map area for offline";
    }
  });

  $("btn-leave").addEventListener("click", leaveCrew);
}

async function leaveCrew() {
  if (!confirm("Leave this crew? Your position is deleted for everyone and you'll need the code to come back.")) return;
  try { if (state.transport) await state.transport.leave(); } catch { /* offline */ }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (state.tickTimer) clearInterval(state.tickTimer);
  if (state.slowTimer) clearInterval(state.slowTimer);
  compass.stop();
  releaseWakeLock();
  if (state.crew) localStorage.removeItem(LS.snap(state.crew.crewId));
  localStorage.removeItem(LS.crew);
  location.hash = "";
  location.reload();
}

/* ── QR code ─────────────────────────────────────────────── */

function renderShare() {
  $("code-text").textContent = state.crew.pretty;
  drawQR(crewLink());
}

async function drawQR(text) {
  const canvas = $("qr");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    if (!window.qrcode) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();

    const n = qr.getModuleCount();
    const quiet = 2;
    const cell = Math.floor(canvas.width / (n + quiet * 2));
    const offset = Math.floor((canvas.width - cell * n) / 2);

    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
      }
    }
  } catch {
    ctx.fillStyle = "#666";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("QR unavailable offline —", canvas.width / 2, canvas.height / 2 - 8);
    ctx.fillText("share the code below instead", canvas.width / 2, canvas.height / 2 + 12);
  }
}

/* ── wake lock ───────────────────────────────────────────── */

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) { toast("This browser can't hold the screen on"); return; }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch { /* denied or battery saver */ }
}

function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (readJSON(LS.wake, false) && !state.wakeLock) acquireWakeLock();
    crewMap.invalidate();
  }
});

/* ── service worker ──────────────────────────────────────── */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("[sw]", err));
  });
}

/* ── go ──────────────────────────────────────────────────── */

boot();
