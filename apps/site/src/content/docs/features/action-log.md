---
title: "The action log"
description: "Every action, on both devices, hash-chained, mirrored, and undoable."
---

Every action either device performs, whoever asked for it, is written to an
**action log**.

## An entry

```json
{
  "seq": 42,
  "at": "2026-10-26T09:14:03.112Z",
  "host": "<this laptop's key>",
  "actor": { "key": "<the phone's key>", "name": "Pixel 8" },
  "action": "files.remove",
  "summary": "Deleted ~/notes/old.md (2.1 kB, undoable)",
  "input": { "path": "~/notes/old.md" },
  "ok": true,
  "undo": { "kind": "files.restore", "data": { "id": "…", "path": "…" } },
  "prev": "<hash of #41>",
  "hash": "<hash of this entry>"
}
```

What gets logged: every change, every refusal (a phone trying something it
wasn't granted), and reads that matter: opening a file, reading the clipboard,
reading messages. Polling the battery doesn't.

## Tamper-evident

Each entry's hash covers the previous entry's hash, so the log is a chain:
changing, removing or reordering an entry breaks it. `ekatva check` verifies
every chain.

## On both devices

Each device keeps its own log and a **mirror** of the other's, synced live over
the link. The mirror only accepts entries that continue the chain it has; a
rewritten history is refused, kept as it was, and raises an alert on the
desktop. To hide something, you'd have to rewrite both devices.

- Laptop: `~/.local/state/ekatva/journal/` (0600, only you can read it).
- Phone: the app's private storage, encrypted with a keystore key.

## No secrets in it

Passwords, tokens, PINs and cookies become `[redacted]`. File contents, typed
text and the clipboard become their length: `{ "redacted": true, "length": 1832 }`.

## Undo

```sh
ekatva log            # • undoable   · can't be undone   ✗ refused   ↶ an undo
ekatva undo 42
```

An entry with `undo` can be reversed, from the CLI, the desktop window, or the
phone. The undo is logged too, and usually undoable (a redo). Undoing needs the
capability the original action did. Some actions can't be reversed (a call
placed, an SMS sent, an answer given to Claude); they're logged all the same.
