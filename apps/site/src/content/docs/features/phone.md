---
title: "The phone, from the laptop"
description: "Calls, messages, notifications, lock and ring."
---

:::note[Status]
Built into the Android app (a small native module); each needs your permission
once, in the app's **Settings → Phone features**.
:::

- **Calls**: dial from the laptop; an incoming call shows at the top of the
  laptop's window with Answer and Decline (and as a desktop notification), a
  call in progress with its timer and Hang up; the call history, read when you
  look at it (and written to the phone's log when it is).
- **Messages**: read conversations and reply.
- **Notifications**: the phone's, on your desktop; dismiss on one, gone on both.
- **Lock the phone**, ring it to find it, keep its screen on.
- **Its files** and **its clipboard**, with the same undo as the laptop's.
  With **one clipboard** on, what you copy on the laptop reaches the phone as
  you copy it: the compositor wakes ekatva (`wl-paste --watch`), only while
  sync is on and a phone is connected, so nothing is asked every 1.5 s
  (without `wl-paste` or a Wayland display in the service, it asks every
  1.5 s, as before). What came from the phone isn't sent back.

Calls, SMS, the notification listener, locking and staying connected use
Android APIs JavaScript can't reach: one small native module
(`apps/mobile/modules/ekatva-phone`, Kotlin) exposes them to the otherwise
TypeScript app.

| Feature | Android asks for |
|---|---|
| Calls | phone, call log, contacts (for names) |
| Messages | SMS |
| Notifications | notification access (in Android's settings) |
| Lock from the laptop | device admin, **force-lock only** |
| All files | "All files access" |
| Stay linked in the background | notifications (an ongoing one says it's linked) |

"Ring it" rings as an alarm, so it sounds even on silent.

The phone decides what the laptop may do on it, just as the laptop decides
for the phone, and logs it in its own action log.
