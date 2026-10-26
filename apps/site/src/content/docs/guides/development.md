---
title: "Development"
description: "The monorepo, the tests, and the rules."
---

```sh
pnpm install
pnpm build        # every package, in order (Turborepo)
pnpm test         # vitest, everywhere
pnpm typecheck
pnpm lint         # Biome
pnpm --filter @ekatva/site dev   # this website
```

## Layout

```
apps/daemon     the laptop service and the CLI (Node)
apps/desktop    the laptop window (Electron)
apps/mobile     the phone app (React Native, Expo)
apps/site       this website (Astro, Starlight)
packages/link       Noise, the encrypted channel, pairing
packages/protocol   capabilities, the tRPC contract, the action log
packages/ui         design tokens and shared pieces
packages/config     tsconfig
```

## Rules

- TypeScript everywhere; the only exception is small Expo native modules for
  Android APIs JavaScript can't reach.
- Every feature is a capability, off until granted, checked on every call.
- Never log keys, tokens or passwords.
- Every change has a CHANGELOG entry, and docs here when behaviour changes.
- Tests never touch your real screen, speakers, keyring or tmux sessions: the
  daemon's tests use a private tmux server (`tmux -L`), scratch homes and fake
  system hosts.
