---
title: "The phone, from the laptop"
description: "Calls, messages, notifications, lock and ring."
---

:::note[Being built]
The phone's side of the API is defined and tested; the app that provides it is
being built.
:::

- **Calls**: dial from the laptop, see incoming calls (a desktop notification
  with Answer and Reject), hang up.
- **Messages**: read conversations and reply.
- **Notifications**: the phone's, on your desktop; dismiss on one, gone on both.
- **Lock the phone**, ring it to find it, keep its screen on.
- **Its files** and **its clipboard**, with the same undo as the laptop's.

Calls, SMS, the notification listener and locking use Android APIs JavaScript
can't reach; small Expo native modules expose them to the (otherwise
TypeScript) app.

The phone decides what the laptop may do on it, just as the laptop decides
for the phone, and logs it in its own action log.
