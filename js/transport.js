/* ============================================================
   Firebase Realtime Database transport.

   Everything written here is already encrypted by crypto.js, so
   this file only moves opaque { iv, ct } blobs around and stamps
   them with server time. It is the only file that knows Firebase
   exists — swapping in a different backend means reimplementing
   this class and nothing else.

   Layout in the database:

     crews/<crewId>/m/<uid>   one live position per person
     crews/<crewId>/p/<uid>   one dropped pin per person

   <crewId> is a hash of the crew code, so it is unguessable, and
   <uid> is the anonymous Firebase auth id, which the security
   rules bind to the writer.
   ============================================================ */

const SDK = "https://www.gstatic.com/firebasejs/11.0.2";

/** Distinguishes "your rules are wrong" from "your signal is bad". */
function isPermissionDenied(err) {
  const code = (err && (err.code || err.message) || "").toString().toLowerCase();
  return code.includes("permission_denied") || code.includes("permission-denied");
}

export class Crew {
  constructor({ crewId, key }) {
    this.crewId = crewId;
    this.key = key;

    this.uid = null;
    this.status = "connecting"; // connecting | online | offline | denied
    this.serverOffset = 0;
    this._denied = false;

    this._fb = null;
    this._unsubs = [];
    this._handlers = { status: [], members: [], pins: [] };
    this._selfRef = null;
    this._lastSelfRecord = null;
  }

  /* ── events ──────────────────────────────────────────── */

  on(event, fn) {
    this._handlers[event].push(fn);
    return () => {
      const i = this._handlers[event].indexOf(fn);
      if (i >= 0) this._handlers[event].splice(i, 1);
    };
  }

  _emit(event, payload) {
    for (const fn of this._handlers[event]) {
      try { fn(payload); } catch (err) { console.error("[crew] handler failed", err); }
    }
  }

  _setStatus(next) {
    // "denied" is a configuration fault, not a blip — never let a later
    // connection event paper over it, or the user goes looking for signal
    // when the real problem is unpublished security rules.
    if (this._denied && next !== "denied") return;
    if (this.status === next) return;
    this.status = next;
    this._emit("status", next);
  }

  /* ── lifecycle ───────────────────────────────────────── */

  /**
   * Load the SDK, sign in anonymously, and start listening.
   * Throws if the network or the Firebase project is unreachable;
   * the caller is expected to keep running in read-only mode.
   */
  async connect(firebaseConfig) {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-database.js`)
    ]);

    const app = appMod.getApps().length
      ? appMod.getApp()
      : appMod.initializeApp(firebaseConfig);

    const auth = authMod.getAuth(app);
    const cred = await authMod.signInAnonymously(auth);
    this.uid = cred.user.uid;

    const db = dbMod.getDatabase(app);
    this._fb = { db, ...dbMod };

    const base = `crews/${this.crewId}`;
    this._selfRef = dbMod.ref(db, `${base}/m/${this.uid}`);

    // Clean our position out of the database the moment we drop off,
    // so nobody navigates towards a ghost.
    dbMod.onDisconnect(this._selfRef).remove().catch(() => {});

    // Connection state.
    this._unsubs.push(
      dbMod.onValue(dbMod.ref(db, ".info/connected"), (snap) => {
        const up = snap.val() === true;
        this._setStatus(up ? "online" : "offline");
        if (up && this._lastSelfRecord) {
          // Re-arm the disconnect hook and re-send after a reconnect.
          dbMod.onDisconnect(this._selfRef).remove().catch(() => {});
          dbMod.set(this._selfRef, this._lastSelfRecord).catch(() => {});
        }
      })
    );

    // Clock skew between this phone and the server, so "last seen"
    // stays honest even if someone's clock is wrong.
    this._unsubs.push(
      dbMod.onValue(dbMod.ref(db, ".info/serverTimeOffset"), (snap) => {
        const off = snap.val();
        if (Number.isFinite(off)) this.serverOffset = off;
      })
    );

    this._unsubs.push(
      dbMod.onValue(dbMod.ref(db, `${base}/m`), (snap) => {
        this._decodeAll(snap.val(), "members");
      }, (err) => {
        console.error("[crew] members listener stopped", err);
        if (isPermissionDenied(err)) {
          this._denied = true;
          this._setStatus("denied");
        } else {
          this._setStatus("offline");
        }
      })
    );

    this._unsubs.push(
      dbMod.onValue(dbMod.ref(db, `${base}/p`), (snap) => {
        this._decodeAll(snap.val(), "pins");
      }, () => {})
    );

    return this.uid;
  }

  /** Decrypt a whole node and emit it. Records that fail are dropped. */
  async _decodeAll(raw, event) {
    const out = {};
    if (raw && typeof raw === "object") {
      const entries = Object.entries(raw);
      const decoded = await Promise.all(
        entries.map(async ([uid, rec]) => {
          const body = await this._decrypt(rec);
          return body ? [uid, { ...body, uid, t: Number(rec.t) || 0 }] : null;
        })
      );
      for (const item of decoded) if (item) out[item[0]] = item[1];
    }
    this._emit(event, out);
  }

  async _decrypt(rec) {
    const { decryptJSON } = await import("./crypto.js");
    return decryptJSON(this.key, rec);
  }

  /* ── writing ─────────────────────────────────────────── */

  /** Encrypt and publish our own position. */
  async sendSelf(payload) {
    if (!this._fb || !this._selfRef) return;
    const { encryptJSON } = await import("./crypto.js");
    const rec = { ...(await encryptJSON(this.key, payload)), t: this._fb.serverTimestamp() };
    this._lastSelfRecord = rec;
    await this._fb.set(this._selfRef, rec);
  }

  /** Drop or replace our pin. Passing null clears it. */
  async setPin(payload) {
    if (!this._fb) return;
    const pinRef = this._fb.ref(this._fb.db, `crews/${this.crewId}/p/${this.uid}`);
    if (payload === null) {
      await this._fb.remove(pinRef);
      return;
    }
    const { encryptJSON } = await import("./crypto.js");
    await this._fb.set(pinRef, {
      ...(await encryptJSON(this.key, payload)),
      t: this._fb.serverTimestamp()
    });
  }

  /* ── misc ────────────────────────────────────────────── */

  /** Server-corrected wall clock, for comparing against record timestamps. */
  now() {
    return Date.now() + this.serverOffset;
  }

  /** Stop listening and remove our position from the database. */
  async leave() {
    for (const off of this._unsubs) {
      try { off(); } catch { /* already detached */ }
    }
    this._unsubs = [];
    if (this._fb && this._selfRef) {
      try { await this._fb.remove(this._selfRef); } catch { /* offline; onDisconnect covers it */ }
      // Take our pin with us. The rules only let the owner write to their own
      // pin slot, so a pin left behind by someone who has left the crew could
      // never be cleared by anybody — it would haunt the map forever.
      try {
        await this._fb.remove(this._fb.ref(this._fb.db, `crews/${this.crewId}/p/${this.uid}`));
      } catch { /* offline */ }
    }
    this._setStatus("offline");
  }
}
