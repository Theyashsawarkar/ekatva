---
title: "Root from the phone"
description: "Approve sudo for your agents, with your password typed on the phone."
---

:::note[Being built]
The API is defined; the bridge to anumati and pramana is being built.
:::

When an agent needs root through [anumati](https://github.com/Theyashsawarkar/anumati),
or an app asks for admin rights through [pramana](https://github.com/Theyashsawarkar/pramana)
(polkit), the request appears on your phone with exactly what will run and why.

Approve it with your fingerprint and type your password on the phone. It goes
end to end into that prompt, and nowhere else: it's never logged (the action
log shows `[redacted]`) and never stored.

This is the **root** capability: off unless you grant it, per phone, and the
phone asks for your fingerprint every time.
