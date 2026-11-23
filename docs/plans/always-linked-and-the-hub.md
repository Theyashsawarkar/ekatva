# Plan: always linked, and ekatva as the hub

Status: planned (2026-11-18). 2026-11-23: milestone 1 done (the tunnel kept
up while a phone is paired, restarted by itself, each new URL posted to the
mailbox) and milestone 2 done in a simpler form (the pairing QR is also the
"connect from anywhere" QR: a paired phone that scans it just connects and
keeps the route; and the phone learns the route over the link itself, on
the same Wi-Fi, through `link.watch`). Not yet: a stable named tunnel,
make-before-break, push wake-ups. 2026-11-23: the hub (part 2) is being
built, decided as: the **daemon** is the laptop's hub and Darpaṇa its UI;
phone apps are **approved once each** and pinned to their signing
certificate; **nāda** is the first app. Milestone 1 done: the laptop's half
(`apps.register`/`invoke`/`emit`, `app:<id>` grants, the Python and TS
clients, `ekatva apps`, the echo example; the website's "Apps through
ekatva"). Calls cross the link as `apps.invoke` (tRPC reserves `call`).
A laptop app isn't pinned to its executable: the local socket is yours
alone and anything running as you could grant itself anything anyway, so
the per-phone `app:<id>` grant is the line that matters there. Next: the
phone's half, Darpaṇa's Apps page, nāda. Two pieces of work, in this order:

1. **Always linked.** Once paired, the phone and the laptop reach each other
   from anywhere, through a secure tunnel the laptop sets up by itself, and
   the link survives the phone moving between networks.
2. **ekatva as the hub.** Every Vayu phone app (nāda, vāgdevī, the next ones)
   talks to the laptop through ekatva, instead of each one pairing and
   tunnelling on its own.

The rules don't change: every feature is a capability, off until granted;
everything that crosses the link is end-to-end encrypted (Noise) and logged;
no secret ever goes into a repo (the tunnel's credentials live in
`~/.config/ekatva`, 0600).

---

## 1. Always linked

### What exists today

- **Same network:** a direct WebSocket to `host:47100`, found through the
  laptop's encrypted UDP beacon (works even on the phone's own hotspot).
- **Away:** an *on-demand* tunnel (`[tunnel] kind`, default cloudflared's
  free quick tunnel). The phone asks a private mailbox (ntfy, the
  "rendezvous") where the laptop is; the laptop starts the tunnel and posts
  its `wss://` URL there. The URL changes every time, and the tunnel stops
  after `idle_minutes` (10) with no phone on it.
- **Security:** the tunnel only carries ciphertext. Noise (the laptop's and
  the phone's long-term keys, from pairing) is the security; the tunnel is
  transport.

The gaps: a first connection from away waits for the rendezvous round trip
(the phone asks, the laptop polls every 10 s, starts the tunnel, answers);
the URL changes; and moving from Wi-Fi to mobile data drops the link until
the phone finds the new route.

### What we build

**A. The tunnel is always up while a phone is paired.**
`[tunnel] mode = "always" | "on-demand"` (default `always` once a phone is
paired). The daemon starts it at boot and keeps it up; it restarts it when
it dies, and posts the address to each phone's mailbox whenever it changes.

**B. A stable address, so the phone needn't ask where the laptop is.**
In order of preference:

| Kind | Address | Needs | Notes |
|---|---|---|---|
| Cloudflare *named* tunnel | `ekatva.<your-domain>` (stable) | a free Cloudflare account and a domain on it | best: stable, free, no inbound port; credentials in `~/.config/ekatva/cloudflared/` |
| Tailscale | the laptop's tailnet name | Tailscale on both devices | stable; a VPN on the phone |
| Quick tunnel (today) | random, changes on restart | nothing | works with no account; the mailbox carries each new URL |

`ekatva tunnel setup` walks through the named tunnel: Cloudflare login in the
browser, then it creates the tunnel and DNS route and saves the credentials
0600, never in a repo. Without it, quick tunnels stay the fallback, kept
always up.

**C. The QR carries the route.**
- Pairing's QR (and `ekatva://pair` link) already has the laptop's key, a
  one-time token, LAN addresses and an optional URL. It also gets the stable
  address and the mailbox id, so a freshly paired phone can reach the laptop
  from anywhere at once.
- **Attach to the tunnel:** Darpaṇa's Devices page shows a "Connect from
  anywhere" QR for an already-paired phone: the current route (stable
  address, mailbox, LAN addresses), signed with the laptop's key. Scanning it
  updates the route without pairing again, e.g. after switching tunnel kinds.
  It holds no secret: the route is useless without the phone's own key.

**D. The link survives moving.**
- The phone keeps one long-lived link in its foreground service (as today,
  held by the headless JS task).
- **Make before break:** on a network change (Android's
  `ConnectivityManager` callback), or when the laptop's beacon appears or
  goes, the phone opens the new route first (LAN when the beacon is seen, else
  the tunnel), moves the session over, then closes the old one. Noise
  sessions get a resume ticket so a new transport doesn't need a full
  handshake.
- tRPC subscriptions resubscribe after the switch; the outbox (calls first)
  already retries what didn't arrive.
- Keepalives: 25 s on mobile data (NAT timeouts), longer on Wi-Fi; backed
  off while the screen is off.

**E. Waking a sleeping phone.** In Doze, Android pauses the link. The laptop
wakes the phone through a push to the phone's mailbox (ntfy over
UnifiedPush, so there's no Google account and no FCM dependency); the phone
reconnects and takes what's waiting. This is how a laptop-side event (an
agent asking, a file sent) reaches a phone in a pocket.

### Security notes

- The tunnel address is not a secret; the Noise keys are. A stranger who
  finds the address gets a handshake that fails.
- The daemon only listens locally for the tunnel (cloudflared connects
  outbound): no inbound port, no firewall change.
- Rate-limit handshakes per source; log failed ones (without key material).
- `ekatva unpair <phone>` drops the phone's key: its route info becomes
  useless. A lost phone: unpair it, and rotate the tunnel if it was named.
- Tunnel credentials: `~/.config/ekatva`, 0600, covered by `secret-scan`'s
  file rules; never in a repo, never logged.

### Milestones

1. `mode = "always"` for the existing tunnel kinds, with restart and
   re-posting of the URL. Test: kill cloudflared, and the phone is back within
   a minute without touching it.
2. The QR carries the route; Darpaṇa's "Connect from anywhere" QR.
3. `ekatva tunnel setup` for a named Cloudflare tunnel; the stable address
   preferred everywhere.
4. Make-before-break switching and Noise resume tickets. Test: walk out of
   Wi-Fi range mid-call notification; the link moves without a drop (the
   headless emulator with toggled networks first, then the real phone).
5. UnifiedPush wake-up through ntfy.

---

## 2. ekatva as the hub

### The idea

```
 phone                                        laptop
 nāda ──┐                                  ┌── nāda (MPD, the library)
 vāgdevī┼─▶ ekatva app ══ Noise link ══▶ ekatva daemon ─┼── darshan (books, PDFs)
 next ──┘   (grants, log)                  (grants, log) └── next tool
```

One pairing, one link, one place for permissions and the log. A phone app
never holds keys or opens its own connection; it asks ekatva. A laptop tool
never listens on the network; it registers with the daemon.

### On the phone: apps talk to ekatva

- **IPC:** ekatva exports a bound Android service (AIDL), protected by a
  custom permission.
- **Who may call:** the Vayu apps are signed by different keys, so a
  signature-level permission doesn't fit. Instead, **per-app approval with
  certificate pinning**: the first call shows "nāda wants to use ekatva:
  play music on the laptop, see its library" in ekatva; allowing it pins the
  app's package name *and* its signing certificate's SHA-256. A different
  signature under the same name is refused. Granted apps are listed in
  Settings, each revocable.
- **Client library:** `@ekatva/client` for React Native apps (and a small
  Kotlin one): `connect()`, `call(procedure, input)`, `subscribe(...)`,
  `status()` (not installed / locked / no laptop / online).
- **Standalone first:** every app works without ekatva (nāda plays on the
  phone, vāgdevī reads offline); the laptop features appear when ekatva is
  there and linked.

### On the wire: namespaced capabilities

- Each app's procedures are a namespace, `app.<id>.<name>`
  (`app.nada.play`, `app.vagdevi.position.set`). An app declares what it uses
  in a manifest (procedures, why, risk), shown on both devices.
- Grants work as today: off until granted, checked on the laptop for every
  call, every call in both devices' action logs under the app's name
  ("nāda, via ekatva: played Monsoon Letters on Ace").
- Limits per app: message size (bulk data, like a book or a song, goes through
  the existing file/share channel), calls per minute.

### On the laptop: tools register with the daemon

- A tool connects to the daemon's Unix socket and registers its namespace
  and handlers (`ekatva.register`), with small clients for Python (nāda,
  Darpaṇa-style tools), Go (narada-style tools) and Node.
- The daemon routes `app.<id>.*` to the registered tool. A tool not running
  answers "nāda isn't running on the laptop" in plain words, never a
  timeout.
- Tools can call the phone too (through the same grants): nāda on the laptop
  asks nāda on the phone for its queue.

### First uses

- **nāda:** control the laptop's player from the phone; move playback
  laptop ⇄ phone ("continue on the phone" as you leave); see the laptop's
  library from the phone.
- **vāgdevī:** keep the reading position and highlights in step between the
  phone and the laptop (darshan opens the same book at the same page); send a
  book from the laptop to the phone.
- Next: any new Vayu phone app gets the laptop with no networking code.

### Milestones

1. Daemon side: `ekatva.register`, routing, and grants for `app.*`; a
   test tool.
2. Phone side: the AIDL service, per-app approval with certificate pinning,
   `@ekatva/client`.
3. nāda as the first app: play, pause, queue; then the handoff.
4. vāgdevī: reading position sync, then sending books.
5. Docs: "Building an app on ekatva" on the website.

---

## Order and open questions

Order: always linked first (milestones 1 to 3), then the hub (1 and 2),
then the first apps, then make-before-break and push wake-ups.

Open questions, to decide when we start:

- A domain for the named tunnel: which one, and is a Cloudflare account OK?
  Without one, quick tunnels kept always up are the fallback.
- One shared Vayu signing key for every Vayu phone app (allows a
  signature-level permission), or keep per-app keys with approval and
  pinning (the plan above)?
- UnifiedPush: rely on ntfy.sh, or run our own ntfy server?
