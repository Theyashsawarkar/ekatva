---
title: "Files"
description: "Every file, both ways, and every change undoable."
---

The phone can browse, open, create, edit, rename, move, copy and delete files
on the laptop. The laptop can do the same on the phone.

## Where it may go

- **Inside the shared folders** only: your home by default (`[files] roots`).
  Paths are resolved through symlinks, so a link can't lead outside.
- **Private places need their own grant** ("Private files too"):
  `~/.ssh`, `~/.gnupg`, keyrings, `~/.password-store`, browser profiles, cloud
  credentials (`~/.aws`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`,
  `~/.git-credentials`).
- **ekatva's own state is never reachable**, not even with that grant: a phone
  must not be able to rewrite its own grants or the action log.

## Nothing is destroyed

| You do | ekatva first | Undo |
|---|---|---|
| delete | moves it (file or whole folder) to the undo store | puts it back |
| overwrite | moves the old version to the undo store | restores it |
| append | remembers the old size | cuts it back (unless changed since) |
| move or copy over something | keeps what was there | moves back, restores it |
| create, make a folder | — | removes it |

Every undo is undoable again (a redo). The undo store keeps items 30 days or up
to 5 GB, whichever comes first (`[undo] days`, `max_gb`).

Writes are atomic (written beside, then renamed over), so a dropped connection
never leaves half a file.
