---
title: "Configuration"
description: "~/.config/ekatva/config.toml"
---

Every key is optional.

```toml
name = "ace"            # how phones see this laptop (default: the hostname)
port = 47100
host = "0.0.0.0"        # where to listen
advertise = true        # announce on the local network (mDNS)

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
```

## Where things are

| | |
|---|---|
| `~/.config/ekatva/config.toml` | this file |
| `~/.local/state/ekatva/` | paired devices, the action logs, caffeine state (0700) |
| `~/.local/share/ekatva/undo/` | the undo store (0700) |
| `$XDG_RUNTIME_DIR/ekatva.sock` | the local socket (0600) |
| desktop keyring, "ekatva: this laptop's identity" | the laptop's secret key |
