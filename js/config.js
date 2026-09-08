/* ============================================================
   THE ONLY FILE YOU NEED TO EDIT.

   Paste the firebaseConfig object from your own Firebase project
   below, replacing the PASTE_ME placeholders. Step-by-step
   instructions are in README.md, and the app will show them on
   screen until this file is filled in.

   Note: these values are NOT secrets. They are meant to ship in
   client code. Your data is protected by the security rules in
   database.rules.json plus the end-to-end encryption in crypto.js
   — the crew code, which never leaves your phones, is the only
   thing that can actually decrypt a position.
   ============================================================ */

export const firebaseConfig = {
  apiKey:            "AIzaSyB86QCLYAuxXIhxjRGNyfIk3wcTH9KD72I",
  authDomain:        "festival-tracker-f98ae.firebaseapp.com",
  databaseURL:       "https://festival-tracker-f98ae-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "festival-tracker-f98ae",
  storageBucket:     "festival-tracker-f98ae.firebasestorage.app",
  messagingSenderId: "49960797595",
  appId:             "1:49960797595:web:0ce967889ced2fea6dcd3e"
};

/* ------------------------------------------------------------
   Tunables. The defaults are good; change them only if you have
   a reason to.
   ------------------------------------------------------------ */

export const TUNING = {
  /** Send a position at least this often, even standing still (ms). */
  heartbeatMs: 20000,
  /** Never send more often than this, however fast you are moving (ms). */
  minSendMs: 4000,
  /** Send early if you have moved at least this far since the last send (m). */
  moveThresholdM: 8,
  /** A buddy older than this is drawn greyed out and marked stale (ms). */
  staleMs: 120000,
  /** A buddy older than this is dropped from the map entirely (ms). */
  dropMs: 1800000,
  /** Above this ground speed, steer by GPS course instead of the magnetometer (m/s). */
  gpsHeadingMinSpeed: 1.0,
  /** Assumed walking pace for the "x min" estimate (m/s). Festival crowds are slow. */
  walkSpeed: 1.15,
  /** Longest display name someone can pick. Longer names still fit the list
   *  rows and map labels, which ellipsize, but the pill gets wide. */
  maxNameLength: 24,
  /** Zoom levels saved either side of the current one by "save this area". */
  prefetchZoomSpread: 1,
  /** Hard ceiling on tiles fetched in one "save this area" run. */
  prefetchMaxTiles: 900
};

/** True when config.js is still holding placeholders. */
export function isConfigured() {
  return !Object.values(firebaseConfig).some(
    (v) => typeof v === "string" && v.includes("PASTE_ME")
  );
}
