# Changelog

Newest first. Releases are tags (`vX.Y.Z`); every package's `version` moves together.

## Unreleased

- Permissions, all in one place (Settings, This phone, Permissions): every
  permission ekatva uses on the phone, needed ones first, with what each is
  for and whether Android granted it; "7 of 9 allowed" and one segment each;
  "Allow the rest" asks Android's dialogs all at once, then opens each of its
  settings pages in turn (the next one when you come back). Light and dark
  (granted once over USB) shows the command, ready to copy. Home reminds you
  while a needed one is missing.
- **Fixed: calls (and texts, notifications) reached the laptop only while the
  app was open.** With the screen off Android woke the phone only to hand over
  the call and slept again before the app told the laptop: a short wake lock
  now covers it. And a phone event went out once, fire-and-forget, so one
  sent while the background link was dead or reconnecting was lost: events now
  wait in an outbox, the link is checked at once (for a call or a text), and
  they're sent when it's back (a ring older than 45 s is stale and dropped;
  anything else is kept up to an hour).
- Settings, This phone: "Work with the screen off" asks Android to keep its
  battery saver off ekatva, so the phone's events get through while it sleeps.
- Laptop notifications on the phone keep their app's icon (Firefox's, not
  ekatva's) and their picture; each laptop app is its own group in the shade
  ("Mail, 3") instead of one pile; urgent ones get their own channel.
- The ekatva mark (the logo's laptop and phone) is the small icon of every
  ekatva notification, tinted brass, instead of the launcher icon Android
  drew as a white blob.
- Home has a bell: the laptop's notification history ("From the laptop"),
  by day, with app chips and each app's icon; a brass count shows what's new
  since you last looked. The laptop keeps the newest 300
  (`notifications.history`, the `notifications` grant).
- Phone notifications on the laptop keep their app's icon and the sender's
  picture (a contact's photo).
- The phone's notifications, calls and texts carry their kind, phone,
  contact, number and app (`x-ekatva-*` hints), so a notification server
  (akashvani) draws a call as a call.
- A phone's call events are handled in order: a ringing call reported twice
  (without the number, then with it) is one notification, not two.

- **Fixed: no incoming call reached the laptop.** The laptop refused every
  phone notification without a picture (the phone sent `picture: null`, the
  laptop expected text or nothing), and the phone's outbox retried the
  refused one forever, so calls queued behind it never went. Now null counts
  as none, a refused event is dropped instead of retried (only a lost
  connection retries), calls go to the front of the outbox, and the laptop
  logs a refused event (which field, why).
- **WhatsApp calls (voice and video) and other apps' calls reach the
  laptop**: ringing, as the same incoming-call card with the app's own Answer
  and Decline; going on, as the call on the bar ("WhatsApp · Suhani · 3m")
  and in the popup; Hang up ends it with the app's own button. The phone
  sent no ongoing notifications at all (music, downloads); now an app's call
  goes, marked `call`. A call-style notification (WhatsApp's video calls)
  says itself whether it rings or goes on, with its own Answer / Decline /
  Hang up: those are used, so a video call rings first. Its buttons are
  pressed with leave to open the app's call screen (Android 14 refused it
  from the background, so answering from the laptop did nothing).
  A video call says so (CallStyle's video flag, or its words): "video
  call" on the card, "WhatsApp video · Suhani · 3m" on the bar.
- **One card per call.** The phone's dialer's own notifications (the
  incoming call, "Missed call") aren't mirrored any more: ekatva shows calls
  itself, so one missed call made two or three cards. A missed call here has
  **Call back**; clearing the missed call on the phone clears it here, and
  dismissing it here clears it on the phone.
- **A call that rings out leaves a "Missed call" on the laptop.** The incoming
  call's notification closes when it stops ringing, and the phone only says
  the call ended, so one that rang for 8 seconds while you looked away left
  nothing behind. Now a call that rang and ended unanswered (not declined
  here) shows "Missed call: Aai", which stays until dismissed.
- **Fixed: calls, texts and notifications didn't reach the laptop with the
  phone's app in the background** (only once it was opened again). React
  Native pauses JS timers off screen unless a headless task runs: the link
  couldn't reconnect and the outbox waited. The link service now holds a
  headless task ("ekatvaStayLinked") while a laptop is paired: an incoming
  call notifies the laptop with the phone away (it reconnected in 10 s in the
  background, tested).
- **The call in progress on the bar**: `ekatva call --waybar` (Vayu shows it
  left of the bell: who, and for how long, "1h 20m"; ringing in yellow);
  `ekatva call` says it, `ekatva call hangup` ends it. A call dialled from the
  laptop shows at once.
- **Fixed: the call banner stayed after hanging up from the laptop.** The
  phone ended the call, but its "the call ended" event can arrive late or not
  at all (Android holds broadcasts back from an app in its background cache).
  Hanging up (or answering) through ekatva now updates the call at once.
- **Fixed: Lock from the phone did nothing, and said it worked.** It asked
  logind (`loginctl lock-session`), which nothing on Vayu answers. It now starts
  Vayu's locker (`vayu-lock`, through sway, so restarting ekatva can't unlock
  it), checks that the screen really locked, and says so when it didn't. The
  lid lock at the strongest level had the same bug and the same fix.
- **Fixed: Sleep did nothing while caffeine was on.** Its sleep block refused
  it. Now sleep always works: jyoti lets go for that one sleep and is lit
  again when the laptop wakes (the phone's confirm says so).
- **Caffeine is now Jyoti** (ज्योति, the flame), everywhere, with named
  levels: **Śānta** (शान्त, at rest), **Akhaṇḍa** (अखण्ड, the unbroken flame: no lock or sleep) and
  **Nandādīpa** (नन्दादीप, the lamp kept burning day and night: also with the
  lid closed). Each level has its lamp, a plain line drawing in its
  colour: the diya unlit (lilac-grey), the diya (blue), the samai (ember); on
  the phone's Home tile it's the focus, at 150 dp. `ekatva jyoti
  [shanta|akhanda|nandadipa]` (off, on, strong and high still work), the
  `jyoti.{get,watch,set}` routes (the wire keeps `off`/`on`/`high`), the
  `jyoti_set` MCP tool, `Status.jyoti`, the phone's Home tile and the docs. The
  state moves by itself (`caffeine.json` → `jyoti.json`, Vayu's
  `~/.local/state/jyoti/enabled`); old log entries still undo. Needs the phone
  app from this release.
- **The laptop's window is now a Vyom popup** ([ekatva-vyom](https://github.com/Theyashsawarkar/ekatva-vyom)):
  it opens at once (Vyom is already running) instead of starting Electron. Six
  places: Overview (the phone, jyoti, light and dark, the phone's clipboard,
  the last messages and calls), Messages, Calls, Files, Log and Devices.
  `ekatva window [PLACE]` opens it.
- **Removed the Electron window** (`apps/desktop`): the popup does everything it
  did. `ekatva window` without Vyom says how to install it. The launcher entry
  moved to `apps/daemon/ekatva.desktop`; the unused `packages/ui` mentions are
  gone from the docs.
- **Calls on the laptop**: an incoming call shows at the top of the window with
  Answer and Decline, a call in progress with its timer and Hang up
  (`admin.calls.watch`, from the call events the phone already sends), and the
  phone's call history (`calls.log`, logged on the phone when read; needs the
  call log permission, asked for with Calls).
- `admin.capabilities`: what each permission is and the presets, so every
  window reads them from the protocol.

- **Fixed: a blank screen when coming back to the app after a while.** Returning
  after more than 5 minutes locked the app, and the tab screens' redirect to
  the start screen and the start screen's redirect to the unlock screen fired
  again and again as screens regained focus: the JavaScript thread spun at
  100% (nothing drew, the link's heartbeat starved and the laptop dropped the
  phone). The lock is now a layer over the app (nothing navigates; you're back
  where you were after the fingerprint, and Back does nothing while it's up),
  and setup and the first unlock are guarded routes (`Stack.Protected`) instead
  of redirects inside screens.

- **A smaller app that starts sooner.** Pairing reads the laptop's QR code with
  Google's code scanner (Play services), so ekatva no longer asks for the camera
  and no longer ships CameraX, a barcode model or a document scanner; pasting
  the `ekatva://pair` link still works. Fonts are built in once and never
  loaded at runtime. Only English resources ship, no GIF or WebP decoder
  (Android decodes static WebP itself), builds are arm64 only, the phone uses
  the same TypeScript as the rest so tRPC is bundled once, Expo's own URL
  support replaces a polyfill, and the file picker and share sheet load only
  when used.
- **The laptop tells the phone what changed, instead of being asked.** Home and
  the Agents badge follow the laptop's push streams (`agents.watch`,
  `caffeine.watch`, `media.watch`, `root.watch`): one shared subscription each,
  held only while a screen showing it is in front, with a poll every 30 seconds
  as a safety net. A song that's simply playing no longer counts as a change.
  Unlocking reads only the end of the action log file. Agent conversations keep
  their blocks steady as old lines scroll away. The phone asks Android directly
  whether it may use all files; the link's 15-second check runs only in front;
  through the tunnel in the background it stops listening for beacons after 3
  minutes.
- **Smoother screens, compiled.** The React Compiler now optimises every screen
  (it skipped 23, including the Home grid, Files, the log and the toaster). The
  trackpad no longer re-renders on every finger move, sends only while a finger
  is down, and draws a native gradient instead of a pad-sized image. Files is a
  virtualised list of fixed-height rows, the phone's folders are read in one
  native call (`listDir`) and reload when you come back to the tab instead of
  every 15 seconds.

- **The record turns smoothly.** Holding and turning it to seek runs entirely on
  the UI thread (Reanimated): the turn, the rotation, the rim and the "+0:12 ·
  1:34" label (an animated text). Nothing re-renders while you turn, the record's
  animation is no longer rebuilt mid-turn (that was the stutter), and its cover
  is drawn once per song with a fixed source (that was the flicker).
- **The phone keeps less of the logs.** It no longer keeps a copy of the
  laptop's action log (thousands of entries, read on every connection): the Log
  tab reads it from the laptop, a page at a time, and the old copies are deleted.
  Its own log stays on disk for undo, with only the newest 200 entries in memory
  (older ones read from disk when asked for), and it's no longer decrypted and
  checked whole at every unlock (the Log tab checks it).
- **Fixed: "on battery" while plugged in.** With a charge limit the battery says
  "Not charging" with the charger in; the laptop now reports `plugged` (any
  online mains supply), and the phone says "plugged in".
- **The laptop's window opens at once, as a floating window.** It has a fixed
  Wayland app id (`ekatva`), so Vayu's sway floats it at 1040×720; it shows when
  its first frame is ready (no flash); closing hides it and `ekatva window`
  (Super+o) wakes it with a signal instead of starting Electron again; hidden
  for 30 minutes, it quits.

- **Lighter, smoother, kinder to the battery** (after a review of the whole app
  against Android and React Native practice):
  - **Home draws less and stops when you can't see it.** The caffeine glow, the
    lamp's wash and the lock screen's background are native gradients instead
    of full-size SVG bitmaps (about 4 MB off Home, 10 MB off the lock screen);
    only the caffeine level you see draws its art; the song's rim turns on the
    UI thread, so nothing re-renders every second while music plays; volume and
    brightness slide their liquid with a native transform. Every loop (steam,
    stars, waves, the record, the agents' spinners) stops when Home isn't in
    front, when the app isn't, or with Android's "remove animations", leaving a
    still frame.
  - **Less asking, less redrawing.** Polls run only while their screen is in
    focus and the app in front; screens asking the same thing share one request;
    an answer that's the same as the last changes nothing on screen; tabs you
    aren't on stop rendering. The terminal and an agent's conversation come again
    only when they change (`unless`, answered "unchanged"). The action log loads
    its newest 300 entries once, then shows new ones as they're written, checks
    its chain once and then only what's new (paging is a binary search, no longer
    quadratic), and scrolls a windowed list. Clipboard sync and the phone's
    light/dark mode no longer tick every 5 seconds.
  - **Files and covers.** Files move in 512 KiB pieces (they were 4 MiB, 30–40 MB
    of temporary strings each), read straight from the file and encoded in
    slices. Covers come scaled to 192 px, always as an image the laptop sends.
  - **Battery.** The phone pings the laptop every 15 s in front and 50 s in the
    background; asks the internet rendezvous at most every 2 minutes in front and
    20 in the background, never without a network or just after hearing the
    laptop on Wi-Fi; stops listening for beacons (and releases the multicast
    lock) while linked on the same Wi-Fi. The "Linked" notification tells the
    real state, and Android no longer revives it without the app.
  - **Fonts are built in** (first frame shows them), and **accessibility**:
    buttons, chips, toggles, the pager and the tabs are at least 48 dp, large
    display type stops growing at 1.4×, and muted text meets 4.5:1 contrast.

- **Fixed: the phone app ran out of memory and showed a gray screen, and the
  connection kept dropping.**
  - **One session, one link:** when Android rebuilt the app's screen (coming
    back from another app), unlocking again opened a second session with a
    second link from the same phone; the two kept replacing each other at the
    laptop (362 times in a few hours) and memory grew until the app crashed.
    There is now one session and one link per app, whatever the screens do.
  - **No more cover flood:** the song's cover went whole (a base64 image of up
    to 340 KB) with every media poll, every 2 seconds. Each player now carries
    a short `artId`; the phone fetches the cover once per song (`media.art`)
    and keeps the last few.
  - **Dead connections are found quickly, on both sides:** while the app is in
    front the laptop must answer every 15 seconds or the phone reconnects; the
    laptop checks every phone every 10 seconds and drops one silent for 30
    (out of range, Wi-Fi gone), freeing its socket at once. Retries come every
    few seconds in front and gently in the background; coming back to the app
    or joining a network reconnects at once.
  - **Calm screens:** polling pauses in the background, never stacks requests,
    gives up on ones that don't answer and keeps the last values; a drop that
    heals within 2.5 seconds doesn't flash "Connecting…".
  - **Never a blank screen:** if a screen fails, the app says so and offers
    "Try again"; while fonts load it shows the app's background, never gray.
  - **The laptop's window** reconnects to the ekatva service by itself when the
    service restarts ("Reconnecting to ekatva…" instead of an error), and
    closing or reloading it no longer leaves a socket open.
- **A smaller app:** release builds shrink the code and resources (R8), keep
  native libraries compressed in the APK, and no longer ship the
  `@expo/vector-icons` fonts (fifteen icon fonts, ~4.5 MB, for two screens
  that now use ekatva's own icons).

- **Fixed: the phone kept flashing "replaced by a new connection"** and
  reconnecting every second. Two copies of the phone's link were running (a
  second unlock, or a double tap on the fingerprint, opened a second session
  without stopping the first), and each new connection pushed the other one
  out. The app now keeps one session and one unlock at a time; a link that is
  replaced by another from the same phone waits half a minute instead of
  fighting back every second; and the laptop says "unpaired" when that's why
  it closed a connection (it said "replaced").

- **Light and dark, on both devices** (`appearance`, `phone.appearance`). The
  laptop's mode is varna's on Vayu (switched with `theme-toggle.sh`, so the bar,
  GTK and apps all follow) or GTK's color-scheme elsewhere; switching it is
  undoable from the action log. From the laptop: the window's Caffeine tab has a
  Light and dark section for this laptop and the phone (`Space l l` / `Space l p`
  flip them), and the CLI has `ekatva appearance [light|dark|toggle]` and
  `ekatva phone appearance [light|dark]`.
  - **On the phone, a lamp**: a new Appearance tile on Home, above Trackpad and
    Terminal. Tap it to switch the laptop and this phone between light and
    dark: the lamp lights the tile for light and goes out for dark. Two chips
    choose which follow a tap and show each one's mode, so they can differ;
    the choice is remembered. The laptop can switch the phone too
    (`phone.appearance`, off until you allow it in the phone's Settings).
  - Android keeps its dark mode from apps: switching it needs a permission
    granted once over USB (`adb shell pm grant
    io.github.theyashsawarkar.ekatva android.permission.WRITE_SECURE_SETTINGS`);
    without it the tile says so. It survives updates, not a reinstall.
  - When the laptop hasn't allowed the phone to switch it (`appearance` is off
    until granted), the lamp says so in amber, with a lock on the laptop's
    chip, instead of "…"; it shows the phone's mode meanwhile.

- **The song tile is a record**: the title, a vinyl peeking in from the
  corner with the cover as its label, turning while it plays, its rim the
  progress. **Hold the record, then turn it, to seek** (one turn is 30 seconds):
  a hold of a third of a second grabs it with a buzz, the record lifts, and the
  time shows as "+0:12 · 1:34" while you turn, ticking every 5 seconds. The
  song pauses while you hold it (the time and the rim show where you'll land)
  and plays on from there when you let go; the record keeps the angle you left
  it at instead of snapping back. A plain
  slide over the record changes the song like anywhere on the tile. With a
  screen reader: the title adjusts to the next or previous song, the record by
  10 seconds. **Swipe the tile** for the next song (left) or the previous
  one (right): the whole tile follows your finger with the song you're going to
  already sliding in beside it, and settles on a spring; past either end of the
  queue it only stretches. The laptop learns the songs either side from MPD,
  which nāda plays through (`Player.prev` / `next`, `services/mpd.ts`).
- **Volume and brightness are liquid gauges**: tinted glass filled to the level,
  its surface a slow wave with a glowing brass line, instead of a flat white fill.
- **The caffeine tile, polished** (the same tile and swipe): light from above
  and a vignette, the level's colour glowing behind a watermark cup whose
  stroke fades downward and whose steam rises (a moon and faint, twinkling
  stars for Off), a fine edge brighter where the light falls, the icon in a
  small chip, and a pill pager that follows your finger.
- **Strong caffeine is the same cup as On**, only in ember, on the phone, in the
  laptop's window and on Vayu's waybar: the colour says the level.
- **One mark everywhere: a laptop with a phone in front of it**, in brass and
  steel. The app's own screens (lock, setup, the battery tile) showed two rings,
  the README and the website's logo too; now they match the app icon and
  favicon. The phone cuts a clean gap out of the laptop instead of being
  painted over it. The app icon, splash and favicon take the lacquer colours.
- **Fixed: caffeine On's blue wash stopped short of the tile's right edge**
  (it was measured inside the panel's padding).
- **Taller control tiles** (188): the volume and brightness capsules read as
  capsules, not ovals.
- **Home, refined.** Volume and brightness are capsules; brightness stops at
  10% (at 0 the laptop refused it with an error). What's playing has
  play/pause inside a ring that fills as the track plays, skipping 10 seconds
  back or forward with the buttons beside it. Trackpad and Terminal are wide tiles on the
  control grid, Clipboard, Send, Lock and Sleep square ones.
- **Errors read as one sentence**, on every screen: no more zod's JSON, stacks
  or "TRPCClientError:" (`errorText` on the phone; the laptop's API now says
  "percent must be at least 1" itself). A link that drops says the laptop
  didn't answer.
- **Caffeine's colours match everywhere**: On blue, Strong ember, on the phone,
  in the laptop's window (its top bar says Off / On / Strong) and on Vayu's
  waybar capsule, which now tells Strong apart: the daemon writes the level
  into Vayu's caffeine state file.

- **The phone app, redesigned: lacquer and brass.** A warm near-black with
  brass for where you are, and one meaning per colour (sage working, amber an
  agent asks, rose root, steel the connection, blue caffeine On, ember
  Strong). Its own type (Bricolage Grotesque, Onest, Tiro Devanagari
  Sanskrit, JetBrains Mono; bundled, OFL) and its own line icons. Four tabs in
  a floating bar, icons only: Home, Agents, Files, Settings.
  - **Home is a control centre**: the laptop's battery, CPU and temperature;
    what's playing; caffeine as a tile you swipe between Off, On and Strong;
    volume and brightness as tall sliders you drag; Trackpad, Terminal,
    Clipboard, Send, Lock and Sleep. A root request or an agent's question
    sits on top and opens exactly that.
  - **Agents** groups sessions as Asks you (answer right in the list),
    Working, Finished and Idle; a session reads as a conversation.
  - Clipboard, Send, root requests and their history open as sheets over
    the screen you were on; the lock and the ring screens are new too.
- **The terminal opens your own tmux** (`terminal.sessions`,
  `terminal.newSession`, `terminal.action`): it attaches to the laptop's
  tmux server, on the session you used last, instead of a separate `ekatva`
  session; switch sessions and windows, start new ones. The phone never
  resizes your windows (the text shrinks to fit, then scrolls sideways);
  `terminal.resize` is gone. The keys are one dock: esc, tab, ctrl, alt,
  ^C, the arrows and a tray with symbols, more keys and tmux's prefix,
  split and scroll; Return sits in the field.
- **Fixed: the daemon could crash at start** (`ENOENT … devices.json.tmp`)
  when two device updates were saved at once. Saves now go one at a time.

- **Agents: the right status, and a session you can read on a phone.**
  - **Fixed: a working agent showed as idle** (or done). Today's Claude Code
    no longer prints "esc to interrupt"; ekatva now reads its spinner line
    (`✶ Transfiguring… (16s · …)`), and an agent waiting for its
    background agents counts as working too. Those background agents show
    under it (`security-reviewer · Reading the tests`).
  - **A session reads as a conversation** (`agents.transcript`): your
    messages as bubbles, its answers as text with the terminal's line wraps
    undone and its lists kept, each tool a row you tap to see its output,
    and what it's doing now at the bottom. The input box and footer are
    left out. **Terminal** still shows the real screen, unwrapped (scroll
    sideways).
  - The list: a card per session with its state in colour (teal working,
    gold asking, violet your turn), what it's doing on one line, and its
    background agents. Reply and stop sit together under the conversation;
    the view follows new output unless you've scrolled up to read.

- **No more app password: your fingerprint opens ekatva** (or, when the
  fingerprint won't do, your phone's own screen lock, in Android's prompt).
  The phone's keys are sealed by a new keystore key (`VaultKey.kt`) that
  never leaves the phone's secure hardware and opens only right after that
  check. Adding a fingerprint no longer locks ekatva out. A vault made with
  an app password asks for it one last time, then moves to the new key. It
  used to ask for the fingerprint, the password and the fingerprint again.
  If the keys are ever lost (the screen lock removed, the phone wiped), the
  unlock screen says so: start over and pair again.
- **Risky actions on the phone need the fingerprint itself** (no screen
  lock instead). **Root on the laptop needs the laptop's password**, typed
  on the phone and checked by sudo there; the phone's fingerprint is no
  longer asked for it.
- **Root requests reach the phone**: when dvarapala or pramana asks for
  root, every phone allowed to answer gets a notification (it opens
  ekatva), gone once the request is answered or expires. The laptop's
  window and the phone ask at once; the first answer counts.
- **A new unlock and set-up screen**: the logo, a big fingerprint button
  that asks at once, and the Īśa Upaniṣad verse below.
- **The Trackpad's text box grows** with what you type (up to about six
  lines, then it scrolls), so you see all of it, not just its end.

- **Fixed: the keyboard covered what you type on the phone** (the
  Trackpad's text box, Send, replies). Android draws apps edge to edge now
  and no longer shrinks them for the keyboard; every screen lifts its
  content above it instead.

- **KDE Connect's features, with buttons that work both ways** (Guides →
  Replacing KDE Connect).
  - **Find my phone rings until you stop it**: full volume, through silent
    and vibrate, and through Do Not Disturb once you allow it (Settings →
    Phone features). Stop it from the notification's button, the big
    Stop button over the app (no unlock needed), or the laptop
    (`Space p r` again, or the button). The volume and Do Not Disturb go
    back to what they were. It used to ring for 20 seconds at whatever
    volume the phone had.
  - **Calls and messages from the laptop's window** (Phone tab): dial,
    answer, hang up; read conversations and send texts. A ringing call
    shows on the laptop with Answer and Reject, a new message with Reply.
  - **Notifications both ways.** The phone's show on the laptop with their
    buttons (a Reply button asks for the text on the laptop); dismissing one
    on the laptop dismisses it on the phone, and one gone on the phone goes
    from the laptop. The laptop's own notifications show on the phone
    (capability `notifications`); swipe one away there and it's gone here.
    Works with any notification server (mako, dunst, swaync…).
  - **The phone as trackpad and keyboard** (Home → Trackpad; capability
    `input`): one finger moves, tap clicks, two fingers scroll or right
    click; text and keys (Esc, Tab, arrows, Super, shortcuts) through
    ydotool and wtype. Typed text is logged only as its length.
    Scrolling goes the way the laptop's own touchpad does (natural or not,
    read from sway). A two-finger tap gets a little more time and room than
    a one-finger tap, since two fingers land and lift a moment apart. A
    clean two-finger tap (fingers that never move) right-clicks: fingers
    are counted as they land, not only when they move.
  - **Send files and links**, new capabilities `share` and `phone.share`:
    *Share → ekatva* from any phone app or Home → Send to laptop; Send a
    file / Open there in the laptop's window. Files land in Downloads (or
    the phone's Download/ekatva) under a safe, new name, never overwriting
    or leaving that folder; links open in the browser; other text goes on
    the clipboard.
  - New keys in the window: `Space p a` / `Space p h` answer / hang up,
    `c` and `Space p c` call, `m` and `Space a m` text, `Space a f` send a
    file, `Space o l` open a link on the phone, `M` / `F` messages / files.

- **Fixed: the phone's permission switches never turned on** (Settings →
  Phone features), even after Android granted calls, messages or
  notification access. The React Compiler kept the first reading of what
  Android allows, so the screen never saw a change. The same bug kept the
  "what the laptop may do" switches and the laptop's name on Home and Log
  from updating; they now follow the paired laptop live (`useLaptop`).
- **Start over** from the unlock screen, when the phone's keys can't be
  opened any more: it wipes the phone's ekatva (its key, paired laptops,
  action log, undo store) after you confirm, and you set it up and pair
  again. Nothing on the laptop is lost.

- **On the same network, the phone finds the laptop by itself, with no
  internet** (Start → Pairing → On the same network).
  - The laptop broadcasts an encrypted **beacon** (UDP 47101, 38 bytes, one
    per paired phone) every 3 s while a phone isn't connected directly. Only
    that phone can open it; it names nothing, and a fresh nonce makes every
    one look different. The phone connects to wherever it came from. This
    works on the phone's own hotspot, where the laptop's address changes
    every time and the phone used to need mobile data to find it.
  - Connected through the tunnel, the phone moves to the direct link as soon
    as it hears the beacon.
  - **Removed:** the mDNS announcement, which told everyone on the network the
    laptop's name and part of its key. `advertise` now turns the beacon on
    and off.
  - The phone is no longer offered container and VPN addresses (`docker0`,
    `br-…`), each of which cost it a timeout.
  - **The firewall is checked.** When ufw or firewalld blocks port 47100, the
    journal, `ekatva status` and the window say so, with the command that
    lets local networks (only) in.
  - **Fixed:** a client on the network could send a `CF-Connecting-IP` header
    to pose as a tunnel connection and dodge the limit on failed handshakes.
    Those headers are now believed only from this laptop (the tunnel).
  - `ekatva status` and the window's header say how each phone is connected:
    direct or away, encrypted either way.

- **The desktop window's keys are vim-like, with `Space` as the leader**,
  grouped like every Vayu tool (Reference → The window's keys).
  - Normal and Insert mode, shown in a pill at the top. A text field is
    Insert mode, and `Esc` leaves it. A checkbox no longer leaves every key
    dead after you click it.
    On the pairing screen, `Enter` pairs even while the "It may do"
    drop-down has focus (its arrows still pick an option).
  - After `Space` (or `g`) a strip shows what can follow (which-key).
    `Space Space` opens a palette of every key, and `?` shows the tab's keys.
  - Counts work (`5j`). `gg` / `G` jump to the top / bottom (a single `g`
    used to). `H` / `L` switch tabs (`1`-`4` still do).
  - **Moved:** `p` pair → `Space a p`; `o` / `i` / `h` caffeine →
    `Space c o` / `c i` / `c h`; `r` ring the phone → `Space p r`. These
    worked from every tab, so a stray `r` rang the phone. `r` reloads now.
  - New keys for what was mouse-only:
    - Phones: `h` / `l` move between the list and its permissions, `Enter`
      or `Space m g` toggles one, `Space d d` unpairs.
    - Phone: `Space p l` locks it, `Space p k` keeps its screen on, `i`
      types clipboard text and `Space y c` sends it, and `j` / `k`, `l` and
      `h` browse its files.
    - Caffeine: `j` / `k` and `Enter` pick a level.
  - Unpairing and undoing ask with `y` only (any other key says no), in the
    window instead of a browser dialog.
  - The key engine (`keymap.ts`) has tests, including that every key is
    annotated for Vayu's keybinding search.
  - A moved key (`p`, `o`, `i`, `h` where nothing else binds it) says where
    it went (`p moved: pairing a phone is Space a p now`) for this release.
  - Fix (before release): `j` or `G` on an empty Log or file list left no row
    selectable until `k`; clicking a caffeine level now also selects it, so
    `Enter` sets the level you clicked.

- Every corner is rounded: the desktop window's rows and entries.
- A logo and a shloka at the top of the README and the website: every Vayu tool has them now.
- Fix: the phone's native module (`apps/mobile/modules/ekatva-phone/android`:
  the Kotlin code, its manifest, build.gradle, the device-admin policy) was
  never in the repository: a root `.gitignore` rule `android/` matched it.
  Only the generated `apps/mobile/android/` and the module's `build/` are
  ignored now, so a fresh clone can build the app.

- Fix: "Lock from the laptop" could never be turned on. The phone opened
  Android's device-admin page as a new task, which Android refuses (it
  closed at once). System pages now open on top of the app's screen.

- Fix: the phone's Settings showed its features (calls, messages,
  notifications, lock, all files) as off after you allowed them on
  Android's own pages. The switches now read the state again when the app
  comes back and every 2 s while on screen; "Stay linked in the background"
  shows whether notifications are really allowed (it always said on).
- The phone logs its link's state changes and rendezvous attempts to
  logcat (`[ekatva link]`), never keys or tokens.

- Fix: finding each other from elsewhere could stop for good. An ntfy
  request that never answered froze the laptop's mailbox check (and the
  phone's "where are you?"); every request now gives up after 15 s, and the
  daemon logs when the rendezvous is unreachable and when it's back.

- `ekatva mcp`: an MCP server for AI agents (Claude Code and any MCP
  client). Status, ring, lock, SMS, calls, the phone's clipboard and files,
  caffeine, the log. `sms_send` and `call_dial` ask you in an Allow/Decline
  dialog first; what other people wrote comes back in `<untrusted>` blocks.
  The log names the agent (`yash via claude`, from `EKATVA_AGENT`).

- The desktop window is the place to pair: its QR code goes through the
  tunnel (any network) and shows the tunnel URL; clicking the "wants to
  pair" notification opens the window on the request (`ekatva window pair`,
  which also works when the window is already open). A launcher entry
  (`apps/desktop/ekatva.desktop`). Opening the window from the daemon can no
  longer stop the daemon when the window isn't built.

- Pairing: `ekatva pair` waits 20 s past the code's expiry, so a phone that
  got in at the last moment can still be confirmed (it used to quit and leave
  the phone waiting with nowhere to answer). With `--window` a Pair/Refuse
  dialog (zenity) shows the emoji as soon as the phone asks; the terminal
  prompt works too, and the first answer wins. The pairing notification says
  where to answer.

- `ekatva pair` now always goes through a tunnel (cloudflared by default),
  so the phone pairs from mobile data or another Wi-Fi; `--lan` keeps it to
  the local network. `--away` is gone (it is the default).

- Pairing screen on the phone: the camera fills the screen with a square
  viewfinder in the middle; "Connecting…" while it pairs. A failed attempt
  now stops and says why with a "Scan again" button, instead of rescanning
  the same code and flashing an error. When the laptop can't be reached
  the error says so (and asks whether the phone is on the same Wi-Fi).

- `ekatva pair --window` shows the QR as a sharp image in a window
  (`qrencode` + `swayimg`) for terminals whose fonts blur the block QR.
  The image is 0600 in the runtime dir and is removed when pairing ends.

- Fix: the QR scanner did nothing in release builds. R8 stripped ML Kit's
  barcode classes (`Failed to initialize BarcodeAnalyzer`); keep rules
  for ML Kit now go in through `expo-build-properties`.

- Media from the phone: what the laptop is playing (any MPRIS player:
  nāda, drishya, browsers), with its cover and position; play, pause,
  skip, seek; the volume and mute (PipeWire) and the screen's brightness.
  A card on the phone's home screen. Each change is logged; pause/play,
  seek, volume and brightness undo to what they were. Brightness never
  goes below 1%. Needs the `media` capability.

- The phone's native side (`apps/mobile/modules/ekatva-phone`, Kotlin, an
  Expo module): lock the phone from the laptop (device admin, force-lock
  only), place, answer and end calls, see incoming ones with the contact's
  name, read and send SMS and see new ones, mirror notifications (a
  notification listener), ring as an alarm (sounds on silent), all-files
  access, and a foreground service that keeps the link up in the
  background. Each asks for its permission once, from Settings → Phone
  features; the phone's calls, messages and notifications go to the laptop
  only if the laptop may receive them.

- From anywhere: when the phone can't reach the laptop where it last was,
  it asks the pair's private mailbox on ntfy ("where are you?"); the
  laptop starts a tunnel (cloudflared quick tunnel by default, ngrok, or
  Tailscale's address) and answers with its URL and addresses; the phone
  saves them and connects. The topic and the key come from the two
  devices' static keys, so the server sees a random topic and ciphertext;
  messages older than 10 minutes are refused. The tunnel stops after 10
  idle minutes. `ekatva pair --away` puts a tunnel URL in the QR code.
  `[tunnel] kind / server / idle_minutes` in config.toml.

- Root approvals from the phone. anumati (from v1.3.0) hands its request
  to the daemon over `ekatva-root.sock` (0600, in your runtime directory);
  phones with the "root" capability (off by default) see it live, exactly
  as the window shows it, choose which commands to run, confirm with the
  fingerprint and type the sudo password, which goes end to end into
  anumati's window: the same sudo check and runner as typing it there. A
  wrong password comes back to the phone; answering on either side clears
  it on both. ekatva never runs anything as root, and the password is
  redacted from both logs.

- `@ekatva/desktop`, the laptop's window (Electron 44, React), a client of
  the daemon: the main process relays a MessagePort to the daemon's local
  socket, so the renderer stays sandboxed (no Node, a strict CSP) and
  speaks tRPC with full types.
  - Phones: paired phones, live; what each may do on the laptop, per
    capability with its risk, presets; unpair.
  - Pairing: the QR code with its countdown; a phone's request with its
    four emoji, confirmed with Enter or refused with x.
  - Log: this laptop's and each phone's (the copy kept here), the chain's
    state, undo.
  - Caffeine: off / on / high, for a while or until turned off.
  - Phone: its battery and network, ring, lock, keep its screen on, send
    to its clipboard, browse its files.
  - Keys everywhere (1–4, j/k, g/G, p, Enter, x, u, o/i/h, r, ?), annotated
    for Vayu's keybinding search.
  - `ekatva window [TAB]` opens it, without a GTK 4 preload inherited from
    the session (it crashes Electron's GTK 3 at start).
  - Electron 44.9.3, not 45.0.0.
- Errors sent to the other device no longer include stack traces.
- The daemon says why it closed a connection (stopped, unpaired, replaced).

- The phone app's screens (Expo Router, rose-pine), bundled for Android:
  - first run sets the app password (with a strength meter) and binds the
    vault to the fingerprint; the password opens it once per start, the
    fingerprint after 5 minutes in the background; risky actions (delete,
    undo, sleep, granting a high-risk capability, forgetting the laptop)
    ask for the fingerprint again.
  - Home: what needs you first (agents' questions, with their options),
    the laptop's battery, CPU and waiting agents, caffeine off / on /
    high, lock and sleep.
  - Agents: every session with its state; a session's live output, its
    question, a reply box, interrupt; start a new session in a project
    with a first prompt.
  - Files: browse the laptop, preview text and images, download to the
    phone, upload from it (in chunks), new folders, rename, delete.
  - Log: the laptop's (from the copy kept on the phone, so it reads
    offline) and the phone's, with the chain's state and undo.
  - Settings: what the laptop may do on the phone, pairing, forgetting,
    all-files access, lock, changing the password.
  - Pairing: the camera reads the QR code, then the four emoji.
  - The icon; Android backups off, so the vault and logs never leave the phone.

- `@ekatva/mobile`, the phone's core (the UI comes next), tested end to end
  against a real daemon:
  - the vault: this phone's identity and log key, encrypted with a key
    derived from the app password (scrypt) and kept in Android's keystore
    behind the fingerprint, so opening the app needs both; weak and
    common passwords refused.
  - the link: pairing from the QR code (LAN addresses, then the tunnel),
    the four emoji, reconnecting with backoff, and stopping (with a clear
    message) when the laptop has unpaired the phone.
  - the phone's API for the laptop, under the phone's own grants: status,
    ring, keep awake, clipboard, files (inside the shared folders, every
    change undoable); calls, SMS and locking say they need the native
    modules until those exist.
  - the phone's action log, and its verified copy of the laptop's,
    encrypted at rest line by line.
- The mirror of the other device's log now takes entries that arrive
  together in order (it refused all but the first).
- A socket over the link no longer throws when the link drops mid-send.

- The website and documentation (Astro Starlight, GitHub Pages): what it
  is, install, pairing, every feature, the security model, cryptography and
  threats, adding a capability, development, replacing KDE Connect, the CLI,
  configuration and the protocol.
- CI: lint, build, typecheck and tests on every push, and a secret scan
  (gitleaks); Dependabot.
- The monorepo: Turborepo, pnpm workspaces, TypeScript, Biome.
- `@ekatva/link`: Noise_XX_25519_ChaChaPoly_BLAKE2b on the audited
  pure-JS @noble libraries (the same code in Node, Electron and React
  Native), tested byte for byte against an independent implementation;
  the encrypted channel (the phone checks the laptop's key, the laptop
  decides who gets in), ports with fragmentation up to 16 MB, keepalive,
  and closing for good on any frame that fails to decrypt; the QR payload
  with one-time pairing tokens (single use, 2 minutes); the four emoji
  from the handshake hash.
- `@ekatva/protocol`: the capabilities (off until granted, presets); one
  procedure builder that checks the caller's grants and records the call;
  tRPC both ways over the channel (a portable server speaking tRPC v11's
  WebSocket protocol, so the phone can serve too, tested with tRPC's own
  client); the laptop's API (status, agents, caffeine off/on/high, power,
  clipboard, files, the action log, root approvals, the phone's events)
  and the phone's (status, lock, ring, keep awake, calls, SMS, clipboard,
  files, the action log).
- The action log: a hash chain per device, mirrored on the other (a
  rewrite or a stranger's entry is refused), secrets and file contents
  redacted, and undo: entries carry how to reverse them, an undo is itself
  logged and undoable, and undoing needs the capability the action did.
- `@ekatva/daemon`, the laptop side, and the `ekatva` command:
  - the link: phones connect over WebSocket (frames capped at the Noise
    limit), are let in by key or by a one-time pairing code you confirm on
    the laptop after comparing emoji; repeated failed handshakes from an
    address shut it out for 10 minutes; grants are read on every call, so
    revoking one, or unpairing, takes effect at once.
  - files: inside the shared folders only (symlinks resolved), private
    places (~/.ssh, keyrings, cloud credentials…) only with their own
    grant, ekatva's own state never; every delete, overwrite, move or copy
    over something keeps what it replaced in the undo store (30 days /
    5 GB) and is undoable, and undoable again.
  - caffeine off / on / high: a logind inhibitor, plus Vayu's swayidle and
    toggle state; "high" also holds the lid switch, locks when the lid
    closes, and drops to "on" when the battery runs low.
  - agents: Claude Code (and Codex, Aider, Gemini) sessions in tmux, read
    from their screens: working, waiting with the exact question and
    options, done; answers only land on the question they answered;
    replies by bracketed paste; new sessions in your projects.
  - the action log on disk (append-only, synced, 0600), checked at start;
    each phone's log mirrored and verified as it grows, with an alert on
    any mismatch.
  - the local socket (0600) for the desktop window and the CLI: pairing,
    devices, grants, the logs, asking the phone; `ekatva pair` shows the
    QR in the terminal; `status --waybar`; a systemd user unit.
- The repository: README with the design (pairing by QR with a one-time
  token and emoji check, Noise end-to-end encryption, LAN and tunnel,
  capabilities), the security model and the roadmap.
