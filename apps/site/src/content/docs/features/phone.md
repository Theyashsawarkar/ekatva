---
title: "The phone, from the laptop"
description: "Calls, messages, notifications, lock and ring."
---

:::note[Status]
Built into the Android app (a small native module); each needs your permission
once, in the app's **Settings → Phone features**.
:::

- **Calls**: dial from the laptop, see incoming calls (a desktop notification
  with Answer and Reject), hang up.
- **Messages**: read conversations and reply.
- **Notifications**: the phone's, on your desktop; dismiss on one, gone on both.
- **Lock the phone**, ring it to find it, keep its screen on.
- **Its files** and **its clipboard**, with the same undo as the laptop's.

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
