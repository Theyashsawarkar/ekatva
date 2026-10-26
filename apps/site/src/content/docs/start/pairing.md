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

## What the phone may do

Pairing grants the preset you choose (`everything-but-root` by default). Change
it any time:

```sh
ekatva grant "Pixel 8" everything
ekatva grant "Pixel 8" status,agents,files,power,journal
ekatva unpair "Pixel 8"
```

Every change of grants is in the action log and can be undone.
