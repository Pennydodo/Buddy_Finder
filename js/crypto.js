/* ============================================================
   End-to-end encryption.

   The crew code is the only secret in the system and it never
   leaves your phones — it lives in the URL fragment (which
   browsers never send to a server) and in localStorage.

   From that one code we derive two independent things:

     crewId  = SHA-256("fbf:id:v1:"  + code)   -> the database path
     key     = PBKDF2("fbf:key:v1:"  + code)   -> the AES-GCM key

   Because SHA-256 is one-way, knowing the database path tells an
   observer nothing about the key. Firebase therefore stores an
   unguessable path full of ciphertext it cannot read, and a
   forged record fails the AES-GCM authentication tag and is
   silently discarded.
   ============================================================ */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no I/O/0/1
const CODE_LEN = 16;                                  // 16 x 5 bits = 80 bits
const GROUP = 4;
const PBKDF2_ITERATIONS = 200000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ── base64url ───────────────────────────────────────────── */

function b64uFromBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64u(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── crew codes ──────────────────────────────────────────── */

/** A fresh 80-bit crew code, formatted XXXX-XXXX-XXXX-XXXX. */
export function newCrewCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  // 256 is an exact multiple of 32, so masking stays uniform.
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b & 31];
  return formatCode(raw);
}

/** Insert the dashes. */
export function formatCode(raw) {
  return (raw.match(new RegExp(`.{1,${GROUP}}`, "g")) || []).join("-");
}

/**
 * Clean up anything a human typed or pasted.
 * Returns the bare 16-character code, or null if it cannot be one.
 */
export function normalizeCode(input) {
  if (typeof input !== "string") return null;
  const raw = input.toUpperCase().split("").filter((c) => ALPHABET.includes(c)).join("");
  return raw.length === CODE_LEN ? raw : null;
}

/* ── key derivation ──────────────────────────────────────── */

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

/**
 * Turn a crew code into the database path and the AES key.
 * Takes ~0.2-0.5s on a phone; called once per session.
 */
export async function deriveCrew(code) {
  const raw = normalizeCode(code);
  if (!raw) throw new Error("Invalid crew code");

  const crewId = b64uFromBytes(await sha256("fbf:id:v1:" + raw)).slice(0, 24);
  const salt = await sha256("fbf:salt:v1:" + raw);

  const material = await crypto.subtle.importKey(
    "raw", enc.encode("fbf:key:v1:" + raw), "PBKDF2", false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  return { code: raw, pretty: formatCode(raw), crewId, key };
}

/* ── payload encryption ──────────────────────────────────── */

/** Encrypt a plain object. Returns { iv, ct } as base64url strings. */
export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))
  );
  return { iv: b64uFromBytes(iv), ct: b64uFromBytes(new Uint8Array(ct)) };
}

/**
 * Decrypt a record written by encryptJSON.
 * Returns null for anything that fails to authenticate, so junk or
 * hostile writes just vanish instead of throwing.
 */
export async function decryptJSON(key, rec) {
  if (!rec || typeof rec.iv !== "string" || typeof rec.ct !== "string") return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesFromB64u(rec.iv) }, key, bytesFromB64u(rec.ct)
    );
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}
