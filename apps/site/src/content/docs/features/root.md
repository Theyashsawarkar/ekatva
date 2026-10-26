---
title: "Root from the phone"
description: "Approve sudo for your agents, with your password typed on the phone."
---

:::note[Status]
Works with [anumati](https://github.com/Theyashsawarkar/anumati) from v1.3.0. polkit
prompts (pramana) are next.
:::

When an agent needs root through [anumati](https://github.com/Theyashsawarkar/anumati),
or an app asks for admin rights through [pramana](https://github.com/Theyashsawarkar/pramana)
(polkit), the request appears on your phone with exactly what will run and why.

Approve it with your fingerprint and type your password on the phone. It goes
end to end into that prompt, and nowhere else: it's never logged (the action
log shows `[redacted]`) and never stored.

This is the **root** capability: off unless you grant it, per phone, and the
phone asks for your fingerprint every time.

## How it stays safe

- **ekatva never runs anything as root.** anumati's window hands its request to
  ekatva over `ekatva-root.sock` (in your runtime directory, only you can open it);
  your answer comes back into that window, which ticks the commands you chose and
  fills its password field, then goes through its own `sudo` check and runner,
  exactly as if you had typed it there.
- **What you see is what runs**: the phone shows the window's own request,
  command by command, with the agent's reason.
- **The window never sends a password out**, and finds ekatva by your user id,
  not by the environment the agent controls.
- A wrong password comes back to the phone so you can try again; answering on
  either side clears the request on both.
