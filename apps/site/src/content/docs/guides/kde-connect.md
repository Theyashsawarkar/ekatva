---
title: "Replacing KDE Connect"
description: "What ekatva covers, and the plan to retire KDE Connect in Vayu."
---

ekatva is meant to replace KDE Connect on [Vayu](https://github.com/Theyashsawarkar/vayu).
KDE Connect is removed only once everything it does is covered.

| KDE Connect | ekatva | State |
|---|---|---|
| Pairing, LAN only | QR pairing with emoji; on the same network directly (an encrypted beacon, no internet needed), from anywhere through a tunnel; end to end | done |
| Battery, signal | the same, and the laptop's state on the phone | done |
| Find my phone | rings **until you stop it**, at full volume, through silent, vibrate and (once allowed) Do Not Disturb; a Stop button on the phone's notification and screen, and on the laptop | done |
| Share files and links | **Share → ekatva** from any phone app; from the laptop's window. Files land in Downloads (laptop) or Download/ekatva (phone), links open in the browser, text on the clipboard | done |
| Browse files | every file both ways, undoable | done |
| Clipboard | both clipboards side by side, paste either, or keep them in sync both ways | done |
| Notifications | both ways: the phone's on the laptop with their buttons (Reply typed on the laptop), the laptop's on the phone; dismissed on one, gone on both | done |
| Media control | nāda, drishya and any MPRIS player | done |
| SMS | read conversations, write and reply from the laptop's window; Reply on a new message's notification | done |
| Calls | dial from the laptop; a ringing call on the laptop with Answer and Reject | done |
| Remote input | the phone as trackpad (tap, two-finger scroll and right click) and keyboard (text, Esc, Tab, arrows, Super, shortcuts) | done |
| Presentation remote | the trackpad's arrow keys | partly |
| Run commands | **AI agents**: their questions, replies, new sessions; root approvals | done |
| — | **a terminal on the laptop**: your own tmux sessions (it opens on the one you used last), switch sessions and windows, start new ones; a key dock with esc, tab, ctrl, alt, ^C, arrows, symbols and the tmux prefix | done |
| — | **light and dark** on both: the phone's Home lamp tile switches the laptop, the phone or both; the laptop's popup (Overview, `Space l l` / `Space l p`) and `ekatva appearance` / `ekatva phone appearance` switch them from the laptop | done |
| — | **jyoti** (keep it awake) from the phone: Śānta (at rest), Akhaṇḍa (no lock or sleep until the lid closes) or Nandādīpa (stays on with the lid closed); swipe the Home tile | done |
| — | **an action log** on both devices, and undo | done |
| — | the laptop's live screen on the phone | planned |

## Permissions

Each of these is a capability, off on an existing pairing until you allow it:

- **Send files and links** (`share`, on the laptop's Phones tab) and **Send
  files and links to the phone** (`phone.share`, in the phone's Settings).
- **Keyboard and pointer** (`input`) for the trackpad.
- **Light and dark** (`appearance`, on the laptop's Phones tab) to switch the
  laptop's mode from the phone, and **The phone's light and dark**
  (`phone.appearance`, in the phone's Settings) for the other way. The phone
  also needs a one-time permission over USB to change its own mode (see the
  phone notes).
- **Notifications** (`notifications`) for the laptop's notifications on the
  phone; **Notifications** (`phone.notifications`, on the phone) for the
  phone's on the laptop.

On the phone, Settings → Phone features turns on what Android asks you for:
calls, messages, notification access, **Ring through Do Not Disturb**, and
**Stay linked in the background** (needs notifications allowed; the Stop
button on a ringing phone's notification needs it too).

## In Vayu

1. ekatva runs beside KDE Connect until it covers the table above.
2. `doot` (the phone panel) and `phone-events.py` move to ekatva's API.
3. KDE Connect's service, sway rules and package go; Vayu's installer installs
   ekatva instead.
