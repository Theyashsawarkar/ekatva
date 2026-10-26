---
title: "Replacing KDE Connect"
description: "What ekatva covers, and the plan to retire KDE Connect in Vayu."
---

ekatva is meant to replace KDE Connect on [Vayu](https://github.com/Theyashsawarkar/vayu).
KDE Connect is removed only once everything it does is covered.

| KDE Connect | ekatva |
|---|---|
| Pairing, LAN only | QR pairing with emoji, LAN and from anywhere, end to end |
| Battery, signal | the same, and the laptop's state on the phone |
| Ring, find | the same, and lock the phone |
| Share files, clipboard | every file both ways, undoable; one clipboard |
| Notifications | the same, actions both ways |
| Media control | nāda, drishya and any MPRIS player |
| SMS | read and reply |
| Call notifications | answer, reject, and **dial from the laptop** |
| Remote input | trackpad, keys, and the **live screen** |
| Run commands | **AI agents**: their questions, replies, new sessions; root approvals |
| — | **an action log** on both devices, and undo |

## In Vayu

1. ekatva runs beside KDE Connect until it covers the table above.
2. `doot` (the phone panel) and `phone-events.py` move to ekatva's API.
3. KDE Connect's service, sway rules and package go; Vayu's installer installs
   ekatva instead.
