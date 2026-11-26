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

Bodies are JSON, up to 1 MB. A call can also **carry files** (a song, a
book; 16 at most, 4 GB each): ekatva moves them first, encrypted like the
rest, and the app gets its own copies.

## Link an app once

Each side has one hub: ekatva's service on the laptop (Darpaṇa is its
screen) and the ekatva app on the phone. An app asks its own hub to link,
you accept once, and it stays linked.

- **On the laptop** an app asks the first time it runs. Darpaṇa's **Apps**
  page (`Space g a`) shows it with the program that asked: **Accept** or
  **Refuse** (or `ekatva apps accept nada`). Accepted, every phone paired
  then may use it.
- **On the phone** you start it, from the app's own settings ("Link with
  ekatva"); ekatva asks for your fingerprint. Opening an app asks nothing.

## One app using another

An app reaches its own other half with nothing more to allow (nāda reaches
nāda). Reaching a **different** app is a **route**: an agent putting a book
into vāgdevī on your phone, say. You're asked once, where the caller is
(Darpaṇa or ekatva): **Allow always**, **Just this once** or **Refuse**. A
method its app marks high risk is asked about every time, and no answer
within a minute is a no.

```sh
ekatva apps call phone:vagdevi addBook '{"title":"Monsoon Letters"}' --file book.epub
```

AI agents have `apps_list` and `apps_call` in ekatva's MCP server. On the
laptop a route is consent, not a wall: a program running as you (an agent
with a shell, too) can already do what you can, including run that command
as you.

## Who may reach what

Nothing reaches an app until you allow it:

- A phone needs **`apps`** (it may use laptop apps at all) and, for each app,
  **`app:<id>`**. Accepting an app gives both to the phones paired then;
  Darpaṇa has a switch per phone (a phone paired later starts off), and
  taking it back stops the very next call.
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
ekatva apps call phone:nada queue # call the phone's nāda, as you
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

app.start()                       # asks to link, and reconnects by itself
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
run it, accept it, and `ekatva apps` shows it online.

An app is registered while it's connected; a second copy under the same id
replaces the first. Apps seen once are remembered, so you can grant one to a
phone while it isn't running.

## On the phone

A phone app talks to ekatva through an Android service, never over the
network. When you link one, ekatva shows what it wants (each method, why,
and how risky), and you allow it or not.

- **Your answer is pinned** to the app's package, its signing certificate
  and its id. A re-signed copy, or another app under the same name, is
  refused; every message is checked, not only the first.
- Linking an app lets the laptop reach it (it turns on **The phone's apps**);
  a switch per app takes that back.
- Files are handed over as Android file descriptors: an app gets the files
  of its own calls and can open nothing else of ekatva's.
- Settings → **Apps through ekatva** lists the linked and refused apps, the
  laptop's, and the routes you allowed; Unlink takes effect at once.

## Building a phone app

Add [`@ekatva/connect`](https://github.com/Theyashsawarkar/ekatva/tree/main/packages/connect)
(an Expo module, Android):

```ts
import { connectEkatva } from "@ekatva/connect";

const ekatva = connectEkatva({ id: "nada", name: "nāda", version: "1",
  methods: [{ name: "status", why: "Tell the laptop what the phone is playing", log: false }],
  events: [{ name: "handoff", why: "Carry on with what the laptop was playing" }] });

ekatva.onStatus((status, why) => { /* "unlinked": show your button; "allowed": go */ });
ekatva.link();                                // your "Link with ekatva" button
await ekatva.call("play");                    // nāda on the laptop
ekatva.on("status", () => ({ title: "…" }));  // the laptop asks this app
```

**Linked from a local ekatva checkout** (`"@ekatva/connect": "link:../ekatva/packages/connect"`)?
Then Metro would take `expo` and `react-native` from that checkout too: a
second React Native in your bundle, and the app stops answering touches.
Make packages from outside your app take their dependencies from it, in
`metro.config.js`:

```js
const root = __dirname + path.sep;   // the folder that holds your node_modules
const here = path.join(__dirname, "index.js");
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const outside = !context.originModulePath.startsWith(root);
  const bare = !name.startsWith(".") && !path.isAbsolute(name);
  const ctx = outside && bare ? { ...context, originModulePath: here } : context;
  return (resolve ?? ctx.resolveRequest)(ctx, name, platform);
};
```

Installed from GitHub instead, it lives in your `node_modules` and needs nothing.

Its status says why it can't reach the laptop, in words: ekatva isn't
installed, isn't open, is asking you, wasn't allowed, or the laptop isn't
connected. Keep the app working without it. The smallest example is
[`examples/echo-phone`](https://github.com/Theyashsawarkar/ekatva/tree/main/examples/echo-phone).

**Kotlin or Java**: copy one file,
[`clients/android/EkatvaClient.kt`](https://github.com/Theyashsawarkar/ekatva/blob/main/clients/android/EkatvaClient.kt)
(Android and `org.json` only; `@ekatva/connect` is built on it).

**Flutter**: [`clients/flutter/ekatva_connect`](https://github.com/Theyashsawarkar/ekatva/tree/main/clients/flutter/ekatva_connect),
the same on top of that file.
