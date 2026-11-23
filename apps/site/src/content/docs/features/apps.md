---
title: "Apps through ekatva"
description: "Any Vayu app on the phone talks to any Vayu app on the laptop, over ekatva's one encrypted link."
---

ekatva is the road between your devices for every Vayu app, not only its
own. nāda on the phone can reach nāda on the laptop, vāgdevī can reach
darshan, and a new app gets the other device with no networking code of its
own: no pairing, no tunnel, no keys.

```
 phone app ⇄ ekatva (phone) ══ encrypted link ══ ekatva service ⇄ laptop app
```

The link is the one you already have: on the same Wi-Fi, or from anywhere
through the tunnel. Everything on it is end-to-end encrypted.

## What an app can send

| | What it is |
|---|---|
| **A call** | A method on the other side's app, one answer back. If the app isn't running, or doesn't answer within 15 seconds, the caller is told so in words ("nāda isn't running on the laptop"). |
| **An event** | Fire and forget. With `keep` (up to a day), an event for an app that isn't running waits and arrives when it starts (at most 200 per app). |

Bodies are JSON, up to 1 MB. Bigger things (a song, a book) go through
ekatva's share, and the call carries its id.

## Who may reach what

Nothing reaches an app until you allow it:

- A phone needs **`apps`** (it may use laptop apps at all) and, for each app,
  **`app:<id>`**: `ekatva grant "Pixel 8" +apps +app:nada`. Revoking either
  stops the very next call.
- Each app declares itself in a **manifest**: its methods and events, why it
  wants each, and how risky each is. That's what you see when you grant it.
- Every call and event is in the action log under the device that sent it
  ("Pixel 8: nāda: play"), except methods the manifest marks `log: false`
  (reads polled often, like a status).
- Each device has a rate limit per app (60 a minute unless the manifest says
  otherwise).

On the laptop, an app talks to ekatva over its local socket, which only your
user can open. A program running as you is trusted as you are (it could
already do anything ekatva can), so on the laptop what matters is which
**phones** may reach an app.

## See them

```sh
ekatva apps                       # the laptop's apps (and which phones may reach each), and the phone's
ekatva apps call nada queue       # call the phone's nāda, as this laptop
```

## Building a laptop app

**Python**: one file, the standard library only:
[`clients/python/ekatva_app.py`](https://github.com/Theyashsawarkar/ekatva/blob/main/clients/python/ekatva_app.py).

```python
from ekatva_app import App

app = App({
    "id": "nada", "name": "nāda", "version": "1",
    "methods": [
        {"name": "play", "why": "Play and pause the laptop's music"},
        {"name": "status", "why": "What's playing", "log": False},
    ],
    "events": [{"name": "handoff", "why": "Continue what the phone was playing"}],
})

@app.on("play")
def play(inp, sender):            # sender: {"key": ..., "name": "Pixel 8"}
    return {"playing": True}      # raise to answer with an error, in words

@app.on_event("handoff")
def handoff(data, sender, at):
    ...

app.start()                       # registers, and again whenever the service restarts
app.call("queue")                 # the phone's nāda (blocks: never on a UI thread)
```

**TypeScript**: `@ekatva/app`:

```ts
import { connectApp } from "@ekatva/app";

const app = connectApp({ id: "nada", name: "nāda", version: "1",
  methods: [{ name: "play", why: "Play and pause the laptop's music" }] });
app.on("play", async (input, from) => ({ playing: true }));
await app.call({ method: "queue" });  // the phone's nāda
```

The smallest whole example is [`examples/echo/echo.py`](https://github.com/Theyashsawarkar/ekatva/blob/main/examples/echo/echo.py):
run it, grant a phone `+apps +app:echo`, and `ekatva apps` shows it online.

An app is registered while it's connected; a second copy under the same id
replaces the first. Apps seen once are remembered, so you can grant one to a
phone while it isn't running.

## On the phone

Phone apps reach ekatva through an Android service, approved once per app
(ekatva remembers the app's signing certificate, so an impostor under the
same name is refused). This part is being built.
