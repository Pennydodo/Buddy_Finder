/* ============================================================
   Geometry, formatting, and heading smoothing.
   ============================================================ */

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north. */
export function bearing(a, b) {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Wrap any angle into 0..360. */
export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Shortest signed difference a - b, in -180..180. */
export function angleDelta(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/**
 * Circular exponential smoothing — averaging 359 deg and 1 deg has to
 * give 0, not 180, so we interpolate along the short arc.
 */
export function smoothAngle(prev, next, alpha) {
  if (prev == null || !Number.isFinite(prev)) return next;
  if (next == null || !Number.isFinite(next)) return prev;
  return norm360(prev + angleDelta(next, prev) * alpha);
}

/**
 * Keep an angle numerically close to the previous one so CSS rotates
 * the short way round instead of spinning 350 degrees backwards.
 */
export function unwrap(prevUnwrapped, targetDeg) {
  if (prevUnwrapped == null || !Number.isFinite(prevUnwrapped)) return targetDeg;
  return prevUnwrapped + angleDelta(targetDeg, norm360(prevUnwrapped));
}

/* ── formatting ──────────────────────────────────────────── */

/** Distance as { value, unit } so the unit can be styled smaller. */
export function fmtDistance(m) {
  if (!Number.isFinite(m)) return { value: "—", unit: "" };
  if (m < 10) return { value: String(Math.round(m)), unit: "m" };
  if (m < 1000) return { value: String(Math.round(m / 5) * 5), unit: "m" };
  if (m < 10000) return { value: (m / 1000).toFixed(1), unit: "km" };
  return { value: String(Math.round(m / 1000)), unit: "km" };
}

/** Same thing as one short string, for the list rows. */
export function fmtDistanceShort(m) {
  const { value, unit } = fmtDistance(m);
  return unit ? value + unit : value;
}

/** Rough walking time across a crowded field. */
export function fmtWalk(m, speed) {
  if (!Number.isFinite(m)) return "";
  if (m < 25) return "you're basically there";
  const mins = m / speed / 60;
  if (mins < 1) return "under a minute";
  return `about ${Math.round(mins)} min walk`;
}

/** "now", "40s", "6 min", "2 h". */
export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 15) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** One of the eight points of the compass, for a bearing. */
export function compassPoint(deg) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(norm360(deg) / 45) % 8];
}
