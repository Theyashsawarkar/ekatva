---
title: "Pair your phone"
description: "One QR code, four emoji, done."
---

```sh
ekatva pair
```

Or open the **ekatva** window and press **Pair a phone** (<kbd>p</kbd>): it's
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

## From anywhere

`ekatva pair` opens a tunnel and the QR code carries its URL as well as the
laptop's local address, so the phone pairs from any network: mobile data or
another Wi-Fi. (`ekatva pair --lan` skips the tunnel, for the same Wi-Fi
only.) The default tunnel is a Cloudflare quick tunnel: install `cloudflared`
(on Arch, `pacman -S cloudflared`); no account needed. After pairing, you don't need to do
anything: when the phone can't reach the laptop where it last was, it asks the
pair's **private mailbox** on [ntfy](https://ntfy.sh) "where are you?"; the
laptop starts a tunnel and answers with its URL; the phone connects.

- The mailbox's topic and key come from the two devices' keys: the ntfy server
  sees a random topic name and ciphertext. Messages older than 10 minutes are
  refused.
- The tunnel (a free Cloudflare quick tunnel by default; or ngrok, or your
  Tailscale address) only ever carries the end-to-end encrypted link, gets a
  new URL each time, and stops after 10 idle minutes.

## What the phone may do

Pairing grants the preset you choose (`everything-but-root` by default). Change
it any time:

```sh
ekatva grant "Pixel 8" everything
ekatva grant "Pixel 8" status,agents,files,power,journal
ekatva unpair "Pixel 8"
```

Every change of grants is in the action log and can be undone.
