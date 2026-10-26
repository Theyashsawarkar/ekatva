---
title: "Pair your phone"
description: "One QR code, four emoji, done."
---

```sh
ekatva pair
```

The terminal (or the desktop window) shows a QR code. Scan it with the ekatva
app. Both screens then show the same **four emoji**; if they match, confirm on
the laptop. That's it: from now on the two recognise each other by their keys.

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

Pair with `ekatva pair --away` and the QR code also carries a tunnel URL, so
the phone can pair from another network. After pairing, you don't need to do
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
