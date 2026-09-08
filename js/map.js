/* ============================================================
   The map half of the screen.

   Leaflet is loaded at runtime rather than imported, because it
   ships as a UMD bundle and because loading it lazily lets the
   service worker serve it from cache when the signal dies.
   ============================================================ */

const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

export const BASE_LAYERS = {
  map: {
    label: "Map",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics"
  }
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => (window.L ? resolve(window.L) : reject(new Error("Leaflet did not initialise")));
    s.onerror = () => reject(new Error("Could not load the map library"));
    document.head.appendChild(s);
  });
}

export class CrewMap {
  constructor() {
    this.L = null;
    this.map = null;
    this.followSelf = true;
    this.baseName = "map";

    this._base = null;
    this._selfMarker = null;
    this._selfCircle = null;
    this._markers = new Map(); // uid -> { marker, kind }
    this._focusUid = null;
    this._onLongPress = null;
  }

  async init(el, baseName = "map") {
    this.L = await loadScript(LEAFLET_JS);
    const L = this.L;

    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      tap: false
    }).setView([0, 0], 2);

    this.setBaseLayer(baseName);

    // Any deliberate pan or pinch means "stop chasing me".
    this.map.on("dragstart zoomstart", (ev) => {
      if (ev.hard !== true) this.followSelf = false;
    });

    // Long-press to drop a pin exactly where you tapped.
    let pressTimer = null;
    let pressLatLng = null;
    const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
    this.map.on("mousedown touchstart", (ev) => {
      pressLatLng = ev.latlng || null;
      if (!pressLatLng) return;
      cancel();
      pressTimer = setTimeout(() => {
        if (this._onLongPress && pressLatLng) {
          this._onLongPress({ lat: pressLatLng.lat, lon: pressLatLng.lng });
        }
      }, 620);
    });
    this.map.on("mouseup touchend dragstart zoomstart mouseout", cancel);

    return this.map;
  }

  onLongPress(fn) { this._onLongPress = fn; }

  /* ── base layers ─────────────────────────────────────── */

  setBaseLayer(name) {
    const spec = BASE_LAYERS[name] || BASE_LAYERS.map;
    this.baseName = BASE_LAYERS[name] ? name : "map";
    if (this._base) this.map.removeLayer(this._base);
    this._base = this.L.tileLayer(spec.url, {
      maxZoom: spec.maxZoom,
      maxNativeZoom: spec.maxZoom,
      attribution: spec.attribution,
      crossOrigin: true,
      keepBuffer: 4
    }).addTo(this.map);
    if (this._base.bringToBack) this._base.bringToBack();
    return this.baseName;
  }

  cycleBaseLayer() {
    const names = Object.keys(BASE_LAYERS);
    const next = names[(names.indexOf(this.baseName) + 1) % names.length];
    return this.setBaseLayer(next);
  }

  /* ── markers ─────────────────────────────────────────── */

  setSelf(pos, headingDeg, accuracyM) {
    if (!this.map || !pos) return;
    const L = this.L;
    const ll = [pos.lat, pos.lon];

    const cone =
      Number.isFinite(headingDeg)
        ? `<span class="self-cone" style="transform:rotate(${headingDeg}deg) translateY(-4px)"></span>`
        : "";
    const html = `<div class="marker-wrap">${cone}<div class="self-dot"></div></div>`;

    if (!this._selfMarker) {
      this._selfMarker = L.marker(ll, {
        icon: L.divIcon({ className: "", html, iconSize: [20, 20], iconAnchor: [10, 10] }),
        zIndexOffset: 1000,
        interactive: false
      }).addTo(this.map);
    } else {
      this._selfMarker.setLatLng(ll);
      this._selfMarker.setIcon(
        L.divIcon({ className: "", html, iconSize: [20, 20], iconAnchor: [10, 10] })
      );
    }

    if (Number.isFinite(accuracyM) && accuracyM > 0) {
      const style = {
        radius: Math.min(accuracyM, 300),
        color: "#ffb046",
        weight: 1,
        opacity: 0.35,
        fillColor: "#ffb046",
        fillOpacity: 0.08,
        interactive: false
      };
      if (!this._selfCircle) this._selfCircle = L.circle(ll, style).addTo(this.map);
      else { this._selfCircle.setLatLng(ll); this._selfCircle.setStyle(style); this._selfCircle.setRadius(style.radius); }
      if (this._selfCircle.bringToBack) this._selfCircle.bringToBack();
    }

    if (this.followSelf) this.map.setView(ll, Math.max(this.map.getZoom(), 16), { animate: true });
  }

  /**
   * Reconcile the marker set against the people (and pins) we know
   * about. Anything not in `items` is removed.
   */
  setItems(items, onTap) {
    if (!this.map) return;
    const L = this.L;
    const seen = new Set();

    for (const it of items) {
      seen.add(it.uid);
      const ll = [it.lat, it.lon];
      const html = `
        <div class="marker-wrap" data-stale="${it.stale ? "true" : "false"}" data-focused="${this._focusUid === it.uid ? "true" : "false"}">
          <div class="marker-pin" style="background:${it.color}">
            <span>${it.emoji || (it.kind === "pin" ? "📍" : "🙂")}</span>
          </div>
          <div class="marker-label">${escapeHtml(it.name)}</div>
        </div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [34, 34], iconAnchor: [17, 17] });

      const existing = this._markers.get(it.uid);
      if (existing) {
        existing.marker.setLatLng(ll);
        existing.marker.setIcon(icon);
      } else {
        const marker = L.marker(ll, { icon, riseOnHover: true }).addTo(this.map);
        marker.on("click", () => onTap && onTap(it.uid));
        this._markers.set(it.uid, { marker });
      }
    }

    for (const [uid, entry] of this._markers) {
      if (!seen.has(uid)) {
        this.map.removeLayer(entry.marker);
        this._markers.delete(uid);
      }
    }
  }

  setFocus(uid) { this._focusUid = uid; }

  /* ── viewport ────────────────────────────────────────── */

  recenter(pos) {
    if (!this.map || !pos) return;
    this.followSelf = true;
    this.map.setView([pos.lat, pos.lon], Math.max(this.map.getZoom(), 17), { animate: true });
  }

  fitAll(points) {
    if (!this.map || !points.length) return;
    this.followSelf = false;
    if (points.length === 1) {
      this.map.setView([points[0].lat, points[0].lon], 17, { animate: true });
      return;
    }
    const bounds = this.L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    this.map.fitBounds(bounds, { padding: [46, 46], maxZoom: 18, animate: true });
  }

  invalidate() {
    if (this.map) this.map.invalidateSize({ animate: false });
  }

  /* ── offline tiles ───────────────────────────────────── */

  /**
   * Walk the tiles covering the current view and request each one, so
   * the service worker files them away. We fetch them as images, which
   * is exactly how Leaflet asks for them — same URL, same cache entry.
   */
  async prefetchArea({ spread = 1, max = 900, onProgress } = {}) {
    if (!this.map) return { done: 0, total: 0 };
    const spec = BASE_LAYERS[this.baseName];
    const bounds = this.map.getBounds();
    const z0 = Math.round(this.map.getZoom());

    const urls = [];
    for (let z = Math.max(1, z0 - spread); z <= Math.min(spec.maxZoom, z0 + spread); z++) {
      const nw = lngLatToTile(bounds.getWest(), bounds.getNorth(), z);
      const se = lngLatToTile(bounds.getEast(), bounds.getSouth(), z);
      for (let x = nw.x; x <= se.x; x++) {
        for (let y = nw.y; y <= se.y; y++) {
          urls.push(spec.url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
          if (urls.length >= max) break;
        }
        if (urls.length >= max) break;
      }
      if (urls.length >= max) break;
    }

    let done = 0;
    const total = urls.length;
    const queue = urls.slice();
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        await new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = img.onerror = () => resolve();
          img.src = url;
        });
        done++;
        if (onProgress && done % 10 === 0) onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (onProgress) onProgress(done, total);
    return { done, total };
  }
}

/* ── helpers ───────────────────────────────────────────── */

function lngLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
