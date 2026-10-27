---
title: "The ekatva command"
description: "Every command."
---

| Command | What it does |
|---|---|
| `ekatva pair [--grants PRESET] [--lan] [--window]` | Shows a QR code that works from any network, through a tunnel (`--lan`: this Wi-Fi only; `--window`: as an image in a window); asks you to confirm the emoji. |
| `ekatva devices` | Paired phones, online or when last seen, and what each may do. |
| `ekatva grant DEVICE PRESET\|CAP,…` | Changes what a phone may do (logged, undoable). |
| `ekatva unpair DEVICE` | Forgets a phone and drops its connection (undoable). |
| `ekatva log [DEVICE] [-n N]` | The action log: this laptop's, or a phone's mirrored copy. |
| `ekatva undo N` | Undoes entry N of this laptop's log. |
| `ekatva check` | Verifies every log's hash chain; exits 2 on a problem. |
| `ekatva caffeine [off\|on\|high] [--for MIN]` | Shows or sets caffeine. |
| `ekatva status [--json\|--waybar]` | The laptop, caffeine, agents waiting, phones connected. |
| `ekatva agents` | Agent sessions in tmux and what they're asking. |
| `ekatva daemon` | Runs the service (systemd does this). |

**Presets**: `everything`, `everything-but-root`, `media-and-notifications`.
