---
title: "Unlock from the phone"
description: "Unlock the laptop's lock screen with your fingerprint, from anywhere."
---

When the laptop is locked, Home's **Lock** tile turns into **Unlock**.

- **The first time**, type the laptop's password on the phone. ekatva types it
  into the lock screen (swaylock) as a keyboard would, and the laptop checks it
  with its own password check (PAM), exactly as if you'd typed it there.
- **Remember it** (on by default) keeps the password in the phone's vault, sealed
  by the same keystore key as ekatva's own keys: after that, Unlock is one touch
  of the fingerprint (or the phone's screen lock).
- **A saved password the laptop refuses is forgotten at once** and never tried
  again: three wrong passwords lock your account on the laptop for 10 minutes
  (faillock).

## What the laptop does with it

The password reaches the laptop over the encrypted link, goes to `ydotool` on
its standard input (never on a command line, where other programs could read
it), and is gone after that one try. It's never stored on the laptop, and the
action log records the unlock with the password as `[redacted]`.

## Turning it on

Unlock is its own capability, **critical** like a terminal or root: off on every
pairing until you grant it, and left out of the "everything but root" preset.

```sh
ekatva grant "<your phone>" unlock
```

It needs ydotool's daemon (`ydotoold`), the same one the trackpad uses.

## Before you've logged in

After a reboot the laptop is at the login screen, and ekatva (a part of your
session) isn't running yet, so Unlock can't reach it. With [ekatva-link](../link/) installed,
the phone can log in from there too, with the same saved password.
