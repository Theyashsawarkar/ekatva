---
title: "Caffeine"
description: "Keep the laptop awake from the phone, even with the lid closed."
---

| Level | What it does |
|---|---|
| **off** | The desktop dims, locks and sleeps as usual. |
| **on** | No dimming, no lock, no sleep from idleness. |
| **high** | On, and the laptop **keeps running with the lid closed**. |

Set it from the phone, the desktop window, or:

```sh
ekatva caffeine high --for 120
ekatva caffeine off
```

## High caffeine, safely

- Closing the lid **still locks** the laptop: ekatva watches the lid and locks.
- When the battery drops to **10%** and it's discharging, high caffeine falls
  back to plain caffeine, so the closed laptop can sleep before it dies. That's
  logged.
- An optional timer turns it off.

## How

A logind inhibitor (`idle:sleep`, plus `handle-lid-switch` at high), which the
active session may hold without root. On [Vayu](https://github.com/Theyashsawarkar/vayu),
it also stops the swayidle service and marks Vayu's caffeine toggle, so the
waybar capsule and quick settings agree. It's remembered across restarts.

The phone has caffeine too: the laptop can keep the phone's screen on.
