---
title: "Configuration"
description: "~/.config/ekatva/config.toml"
---

Every key is optional.

```toml
name = "ace"            # how phones see this laptop (default: the hostname)
port = 47100
host = "0.0.0.0"        # where to listen
advertise = true        # the encrypted beacon for phones on the same network

[files]
roots = ["~"]           # what phones may reach
private = ["~/.ssh", "~/.gnupg", "~/.local/share/keyrings", "~/.password-store", "~/.aws"]

[undo]
days = 30               # how long the undo store keeps things
max_gb = 5              # and how much

[agents]
roots = ["~/personal", "~/codes", "~/work"]   # where your projects are

[tunnel]
kind = "cloudflared"    # or "ngrok", "tailscale", "none"
mode = "always"         # kept up while a phone is paired; or "on-demand"
server = "https://ntfy.sh"   # the pair's private mailbox
idle_minutes = 10       # on-demand only: closed after this long unused
```

## Where things are

| | |
|---|---|
| `~/.config/ekatva/config.toml` | this file |
| `~/.local/state/ekatva/` | paired devices, the action logs, jyoti state (0700) |
| `~/.local/share/ekatva/undo/` | the undo store (0700) |
| `$XDG_RUNTIME_DIR/ekatva.sock` | the local socket (0600) |
| desktop keyring, "ekatva: this laptop's identity" | the laptop's secret key |
