---
title: "Pair your phone"
description: "One QR code, four emoji, done."
---

```sh
ekatva pair
```

Or open the **ekatva** window and press **Connect a phone** (<kbd>Space</kbd> <kbd>a</kbd> <kbd>p</kbd>): it's
the easiest way, and it shows the request and the emoji when the phone asks.
If the window is closed, the "wants to pair" notification opens it when you
click it.

The terminal (or the desktop window) shows a QR code. Scan it with the ekatva
app. Both screens then show the same **four emoji**; if they match, confirm on
the laptop. That's it: from now on the two recognise each other by their keys.

If your phone can't read the terminal's QR code (some fonts blur it), run
`ekatva pair --window`: it shows the code as a sharp image in a window
(needs `qrencode` and `swayimg`). When the phone asks, the QR window closes
and a **Pair / Refuse** dialog shows the four emoji (needs `zenity`); you can
also answer in the terminal.

## What the QR code holds

```
ekatva://pair?v=1&k=<laptop's public key>&t=<one-time token>&n=<name>&lan=<address:port>
```

- The **public key** lets the phone check it's talking to *this* laptop: the
  connection's handshake proves it, so a look-alike can't pretend.
- The **token** works **once**, for **two minutes**. A photo of your screen is
  worthless after that.
- Nothing in it is a lasting secret.

## Why the emoji

The emoji come from the handshake hash, which is the same on both ends only
when nobody sits in between. If someone else used your QR first, their
connection shows different emoji (and your phone's fails, because the token
is spent). You only confirm what you can see on both screens.

## On the same network

When the phone and the laptop share a network (a Wi-Fi, or the laptop on the
phone's own hotspot), they talk directly, with no internet needed and nothing
in between:

- Every 3 seconds, while a paired phone isn't connected directly, the laptop
  broadcasts a **beacon** on each local network: 38 bytes on UDP port 47101,
  one per paired phone, encrypted with a key only that pair can compute. It
  carries the time and the laptop's port, nothing else: no name, no key, and
  a fresh random nonce each time, so others on the network can't tell who it
  is or follow it from one network to the next.
- The phone listens for it, and connects to wherever the beacon came from.
  A copied beacon is refused after two minutes, and the connection must pass
  the Noise handshake against the laptop's key anyway: a beacon only says
  where to knock.
- Connected through the tunnel and then you come home? As soon as the phone
  hears the beacon it opens the direct link and drops the tunnel.
- Containers' and VPNs' interfaces (`docker0`, `br-…`, `tailscale0`…) get no
  beacons and aren't offered to the phone.

The window's header and `ekatva status` say how each phone is connected:
*direct* (same network) or *away* (through the tunnel). Both are end to end
encrypted.

## From anywhere

There are two ways for the phone to find the laptop, and you rarely think
about either:

1. **The same network**: the beacon above, straight to the laptop.
2. **A secure tunnel**: from any network (mobile data, another Wi-Fi, another
   city). The laptop keeps a free [Cloudflare quick
   tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   open **all the time while a phone is paired**, and opens it again by
   itself if it drops. It also checks, every minute and before giving a
   phone its address, that the tunnel really reaches the laptop: after a
   network drop `cloudflared` can keep running with a tunnel that's gone, and
   then it's replaced by a new one. Install `cloudflared` (on Arch, `pacman -S
   cloudflared`); no account needed.

The phone learns the tunnel's address three ways, so it's never stuck:

- **On the same Wi-Fi, by itself.** While linked, the laptop tells the phone
  its route (the tunnel's URL and its local addresses), and again whenever it
  changes. Leave the Wi-Fi and the phone comes back through the tunnel, with
  no QR code.
- **From the QR code.** The code in the window (or `ekatva pair`) carries the
  tunnel's URL too, so it works from any network. A **new** phone pairs (the
  four emoji); a phone that's **already paired** just connects and keeps the
  new route, with no emoji and no pairing again: handy when the tunnel's
  address changed while the phone was away.
- **From the pair's private mailbox** on [ntfy](https://ntfy.sh). Whenever the
  tunnel's URL changes (a laptop restart, a dropped tunnel), the laptop posts
  the new one there, and a phone that can't reach the old address reads it
  and connects. If there's nothing new it asks "where are you?" and the
  laptop answers.

Not heard on this network (also when you scan the code), the phone tries
the tunnel first, and gives it up to 10 seconds to open; once it hears
the laptop's beacon, it moves to the direct link and drops the tunnel.

- The tunnel only ever carries the end-to-end encrypted link (Noise, with the
  keys from pairing). Its address isn't a secret: a stranger who finds it gets
  a handshake that fails.
- The mailbox's topic and key come from the two devices' keys: the ntfy server
  sees a random topic name and ciphertext. An answer older than 10 minutes is
  refused, an address announcement older than 12 hours.
- Nothing listens on a public port: `cloudflared` connects out.
- The window's Devices page shows **From anywhere**: *Open* (green),
  *Opening* (yellow), *Off* (red: `cloudflared` isn't installed). So does
  `ekatva status`. On the phone, Settings → Connection says how it's
  connected now and whether it's ready to come back from anywhere.
- Prefer the old way (a tunnel only while a phone away asks for it, closed
  after 10 idle minutes)? Set `mode = "on-demand"` under `[tunnel]`.
  `ekatva pair --lan` skips the tunnel, for the same Wi-Fi only.

## What the phone may do

Pairing grants the preset you choose (`everything-but-root` by default). Change
it any time:

```sh
ekatva grant "Pixel 8" everything
ekatva grant "Pixel 8" status,agents,files,power,journal
ekatva unpair "Pixel 8"
```

Every change of grants is in the action log and can be undone.
