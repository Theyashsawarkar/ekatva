---
title: "Jyoti"
description: "Keep the laptop awake from the phone, even with the lid closed."
---

**Jyoti** (ज्योति) is the flame. Here it keeps the laptop awake, at three
levels, each with its lamp:

| Level | Its lamp | What it does |
|---|---|---|
| **Śānta** (शान्त, at rest, as a fire gone out) | the diya, unlit, in lilac-grey | The desktop dims, locks and sleeps as usual. |
| **Akhaṇḍa** (अखण्ड, the unbroken flame) | the diya, in blue | No dimming, no lock, no sleep from idleness. |
| **Nandādīpa** (नन्दादीप, the lamp kept burning day and night) | the samai, in ember | Akhaṇḍa, and the laptop **keeps running with the lid closed**. |

Set it from the phone (swipe the Home tile), the laptop's popup
(`Space j s` / `j a` / `j n`), the bar, quick settings, Super+Shift+a, or:

```sh
ekatva jyoti nandadipa --for 120
ekatva jyoti akhanda
ekatva jyoti shanta
```

## Nandādīpa, safely

- Closing the lid **still locks** the laptop: ekatva watches the lid and locks.
- When the battery drops to **10%** and it's discharging, Nandādīpa falls back
  to Akhaṇḍa, so the closed laptop can sleep before it dies. That's logged.
- An optional timer turns it off.

## Sleep and lock still work

**Lock** from the phone locks the laptop at any level, and says so if the
screen didn't lock. **Sleep** puts the laptop to sleep even while jyoti is
lit: it lets go for that one sleep and is lit again when the laptop wakes, so
you don't have to turn it off first and back on later.

## How

A logind inhibitor (`idle:sleep`, plus `handle-lid-switch` at Nandādīpa),
which the active session may hold without root. On
[Vayu](https://github.com/Theyashsawarkar/vayu), it also stops the swayidle
service and marks Vayu's jyoti toggle (`~/.local/state/jyoti/enabled`), so the
bar capsule and quick settings agree. It's remembered across restarts. On the
wire the levels are still `off`, `on` and `high`, and the CLI takes those too.

The phone has its own too: the laptop can keep the phone's screen on.
