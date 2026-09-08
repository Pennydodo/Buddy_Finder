/* ============================================================
   Magnetometer compass.

   This is the least trustworthy sensor on the phone and a festival
   is the worst place on earth for it: line-array speakers are giant
   magnets, stages are steel, and half the cases have magnets in the
   back. So the app only falls back to this when you are standing
   still — as soon as you walk, app.js steers by GPS course instead,
   which no magnet can bend.
   ============================================================ */

import { smoothAngle, norm360 } from "./geo.js";

const SMOOTHING = 0.18; // low, because raw magnetometer output jitters hard

export class Compass {
  constructor() {
    this.heading = null;      // smoothed degrees clockwise from true north
    this.accuracy = null;     // iOS only: claimed error in degrees
    this.supported = typeof window !== "undefined" && "DeviceOrientationEvent" in window;
    this.granted = false;
    this._listening = false;
    this._raw = null;
    this._onChange = null;
    this._handler = this._handle.bind(this);
  }

  /** True on iOS 13+, where the sensor needs an explicit tap to unlock. */
  get needsPermission() {
    return (
      this.supported &&
      typeof DeviceOrientationEvent.requestPermission === "function" &&
      !this.granted
    );
  }

  /** Must be called from inside a real user gesture on iOS. */
  async requestPermission() {
    if (!this.supported) return false;
    if (typeof DeviceOrientationEvent.requestPermission !== "function") {
      this.granted = true;
      return true;
    }
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      this.granted = res === "granted";
      return this.granted;
    } catch {
      this.granted = false;
      return false;
    }
  }

  start(onChange) {
    this._onChange = onChange;
    if (!this.supported || this._listening) return;
    // 'deviceorientationabsolute' is true-north referenced where it exists
    // (Chrome/Android). Safari does not fire it but puts an absolute
    // heading on the plain event as webkitCompassHeading.
    window.addEventListener("deviceorientationabsolute", this._handler, true);
    window.addEventListener("deviceorientation", this._handler, true);
    this._listening = true;
  }

  stop() {
    if (!this._listening) return;
    window.removeEventListener("deviceorientationabsolute", this._handler, true);
    window.removeEventListener("deviceorientation", this._handler, true);
    this._listening = false;
    this.heading = null;
  }

  _screenAngle() {
    const a = (screen.orientation && screen.orientation.angle);
    if (Number.isFinite(a)) return a;
    return Number.isFinite(window.orientation) ? window.orientation : 0;
  }

  _handle(ev) {
    let raw = null;

    if (Number.isFinite(ev.webkitCompassHeading)) {
      // Safari: already clockwise from true north.
      raw = ev.webkitCompassHeading;
      if (Number.isFinite(ev.webkitCompassAccuracy) && ev.webkitCompassAccuracy >= 0) {
        this.accuracy = ev.webkitCompassAccuracy;
      }
    } else if (Number.isFinite(ev.alpha) && (ev.absolute === true || ev.type === "deviceorientationabsolute")) {
      // Spec alpha counts anticlockwise from north, so flip it.
      raw = 360 - ev.alpha;
    } else {
      return; // relative-only data is useless as a compass
    }

    // Compensate for the phone being held in landscape.
    raw = norm360(raw + this._screenAngle());

    this._raw = raw;
    this.heading = smoothAngle(this.heading, raw, SMOOTHING);
    this.granted = true;
    if (this._onChange) this._onChange(this.heading);
  }

  /** True when the sensor is producing usable absolute headings. */
  get live() {
    return this._raw !== null;
  }
}
