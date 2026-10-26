---
title: "Protocol"
description: "The link, the ports, and the APIs."
---

## Layers

1. **WebSocket** to `/link` on the laptop (port 47100), directly or through a
   tunnel.
2. **Noise XX**, then encrypted frames: `[port][flags][payload]`. See
   [cryptography](/ekatva/security/crypto/).
3. **Ports**: `0` control (decision, keepalive), `1` the laptop's API, `2` the
   phone's API, higher ports for streams.
4. **tRPC v11** on ports 1 and 2: queries, mutations, subscriptions. Both sides
   share the router types from `@ekatva/protocol`.

## The laptop's API

`status` · `agents.{list,watch,projects,tail,answer,reply,interrupt,start}` ·
`caffeine.{get,watch,set}` · `power.{lock,suspend}` · `media.{get,watch,control,seek,volume,brightness}` · `clipboard.{get,set}` ·
`files.{list,stat,read,write,mkdir,move,copy,remove}` ·
`journal.{head,since,follow,undo}` · `root.{pending,respond}` · `inbox.report`

## The phone's API

`status` · `lock` · `ring` · `keepAwake` · `calls.{dial,answer,hangUp}` ·
`sms.{threads,read,send}` · `clipboard.{get,set}` · `files.*` · `journal.*`

## The local socket

The laptop's API as its own user (every capability), plus
`admin.{pair,devices,log,phone}`. The desktop window and the CLI use it.
