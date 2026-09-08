# Buddy Finder

A festival crew tracker that runs entirely on GitHub Pages. Live positions on a
map, a big compass arrow to whoever you're trying to reach, and a shared meet
pin. Everything is end-to-end encrypted — the server stores ciphertext at an
unguessable path and cannot read a single coordinate.

---

## What it does

- **Split screen.** Map on top, ranked buddy list underneath. Drag the bar
  between them to give either half more room; it remembers where you put it.
- **Compass navigation.** Tap anyone and the bottom half becomes a giant arrow
  with the distance and a walking estimate.
- **Honest staleness.** Every dot carries a "last seen" age, greys out after two
  minutes and disappears after thirty. You never chase a frozen pin thinking
  it's live.
- **Meet pins.** Drop one at the map centre, or long-press anywhere on the map.
  Everyone in the crew sees it. One pin each.
- **Satellite view.** Festivals happen in fields that street maps show as
  nothing. Tap the layers button for aerial imagery.
- **Offline map.** "Save this map area" hoards the tiles you're looking at so
  the map still draws when the signal dies. Do it on the campsite wifi.
- **Installable.** Add to home screen and it runs like an app, full screen.

## The bit that makes the arrow trustworthy

A phone's magnetometer is the least reliable sensor it has, and a festival is
the worst possible place for one — line-array speakers are enormous magnets,
stages are steel, and half the phone cases have magnets in them. A compass can
swing 90° next to a stage.

So the app doesn't trust it while you're moving. Above roughly walking pace it
steers by **GPS course over ground**, which is computed from successive fixes
and is immune to magnetic interference. The magnetometer only fills in when
you're standing still, and the app tells you which one it's using at the bottom
of the compass screen.

---

## Setup

You need a free Firebase project. It takes about five minutes, once.

### 1. Create the project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   click **Add project**.
2. Name it anything. **Turn Google Analytics off** — it's not needed and adds
   consent obligations you don't want.

### 2. Turn on the database

1. **Build → Realtime Database → Create database.**
2. Pick the region closest to where you'll actually be. `europe-west1` for
   Europe, `us-central1` for the Americas, `asia-southeast1` for Asia-Pacific.
   South Africa has no region — `europe-west1` is the fastest from there.
3. Choose **Start in locked mode.** You'll paste proper rules in step 5.

> Realtime Database, **not** Firestore. They're different products and this app
> uses the former.

### 3. Turn on anonymous sign-in

**Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**

Nobody makes an account. Each phone silently gets an id so the security rules
can stop people overwriting each other's positions.

### 4. Copy your config

**Project settings** (the gear, top left) **→ Your apps → Web** (the `</>`
icon) → give it a nickname → **Register app**. Copy the `firebaseConfig`
object it shows you and paste it into `js/config.js`, replacing the
placeholders.

Those values are **not secrets** — they're designed to ship in client code.
Your data is protected by the rules below plus the encryption, not by hiding
them.

### 5. Paste the security rules

**Realtime Database → Rules tab.** Replace everything with the contents of
`database.rules.json`, then **Publish**.

Without this step your database is either wide open or completely closed.
The rules enforce:

- Nothing is readable or writable outside `crews/`.
- You may only write to your own anonymous uid — you can't move someone else's
  dot or delete their pin.
- Only `iv`, `ct` and `t` may be written, with size caps, so nobody can dump
  arbitrary data into your project.
- Timestamps must be server time, so "last seen" can't be faked.

### 6. Publish to GitHub Pages

```bash
cd festival-buddy-finder
git init
git add -A
git commit -m "Buddy Finder"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/buddy-finder.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main /
(root) → Save.** A minute later it's live at
`https://YOUR-USERNAME.github.io/buddy-finder/`.

**HTTPS is mandatory** for geolocation and the compass. GitHub Pages gives you
that automatically. Opening `index.html` off your hard drive will not work.

---

## Using it

1. Open the page, type your name, pick an emoji and a colour.
2. **Start a new crew.** A share sheet appears with a QR code and a link.
3. Friends scan the QR or open the link — the crew code fills itself in and they
   just add a name.
4. Everyone taps **Allow** on the location prompt. On iOS, also tap **Enable
   compass** in settings the first time.

**Before you lose signal:** open Settings, turn on *Keep the screen awake*, and
hit *Save this map area for offline*.

---

## The honest limitations

**Accuracy is 5–20 m at a festival.** Phone GPS is 3–10 m in the open, and a
festival degrades that: stage scaffolding and shipping containers cause
multipath reflections, and a dense crowd of water-filled humans attenuates the
signal. The app gets you to within a couple of rows of people, then you look up
and use your eyes. That's fine — the hard part is 400 m down to 20 m, and it
does that well.

**It stops when the screen locks.** Browsers suspend geolocation for background
tabs. No web app can track in the background; that's an operating system
restriction, not something code can work around. The wake lock keeps the screen
on while the app is open, and every position carries its age so a frozen dot is
obvious. If you truly need background tracking, you need a native app.

**iOS Safari is fussier.** The compass needs an explicit tap to unlock. Adding
the page to your home screen makes it noticeably better behaved.

**Battery.** High-accuracy GPS plus a lit screen is genuinely expensive —
budget roughly 15–20% per hour. Bring a power bank. The battery-saver toggle in
settings drops to coarse positioning if you're desperate.

**Free tier.** 100 simultaneous connections and 10 GB/month. A crew sends about
3 KB a minute, so a group of ten at a three-day festival uses a fraction of a
percent of that.

---

## Privacy

The crew code is the only secret, and it never reaches any server — it lives in
the URL fragment (which browsers never transmit) and in your phone's local
storage.

From that code the app derives two independent things: a SHA-256 hash used as
the database path, and a separate PBKDF2-derived AES-256-GCM key used to
encrypt every position. Because hashing is one-way, knowing the path reveals
nothing about the key. Google stores an unguessable path full of ciphertext it
cannot decrypt.

Forged or corrupted records fail the GCM authentication tag and are silently
discarded, so nobody can inject a fake position even if they somehow learn the
path.

**Anyone with the link can see your crew.** Send it in the group chat, not
anywhere public. Leaving the crew deletes your position for everyone
immediately.

---

## Files

| Path | What it is |
|---|---|
| `js/config.js` | **The only file you need to edit.** Firebase config and tunables. |
| `js/crypto.js` | Crew codes, key derivation, AES-GCM encrypt/decrypt. |
| `js/transport.js` | Everything that knows Firebase exists. Swap this to change backend. |
| `js/geo.js` | Distance, bearing, angle smoothing, formatting. |
| `js/compass.js` | Magnetometer handling and the iOS permission dance. |
| `js/map.js` | Leaflet setup, markers, offline tile prefetch. |
| `js/app.js` | Screens, geolocation, heading fusion, list and compass rendering. |
| `sw.js` | Service worker: app shell, CDN libraries, map tile hoard. |
| `database.rules.json` | Paste into the Firebase Rules tab. |

## Tuning

Everything worth changing is in the `TUNING` object in `js/config.js`: how often
positions are sent, how far you must move before an early send, when a buddy
counts as stale, the speed at which GPS heading takes over from the compass, and
the assumed walking pace. The defaults are tuned for a crowded field.
