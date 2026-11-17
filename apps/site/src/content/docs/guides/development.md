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
apps/mobile     the phone app (React Native, Expo)
apps/site       this website (Astro, Starlight)
packages/link       Noise, the encrypted channel, pairing
packages/protocol   capabilities, the tRPC contract, the action log
packages/config     tsconfig
```

The laptop's window is a [Vyom](https://github.com/Theyashsawarkar/vyom) popup
in its own repo, [ekatva-vyom](https://github.com/Theyashsawarkar/ekatva-vyom):
a client of the daemon's socket, like the CLI.

## Rules

- TypeScript everywhere; the only exception is small Expo native modules for
  Android APIs JavaScript can't reach.
- Every feature is a capability, off until granted, checked on every call.
- Never log keys, tokens or passwords.
- Every change has a CHANGELOG entry, and docs here when behaviour changes.
- Tests never touch your real screen, speakers, keyring or tmux sessions: the
  daemon's tests use a private tmux server (`tmux -L`), scratch homes and fake
  system hosts.

## The phone app's release build

Release builds are kept small on purpose (`apps/mobile/app.json`):

- R8 shrinks code and resources; native libraries stay compressed in the APK;
  arm64 only (`buildArchs`); no GIF or WebP decoder (Android decodes static
  WebP itself); English resources only (`plugins/with-english-only.js`).
- Fonts are built in by the `expo-font` plugin (never loaded at runtime).
- Pairing reads the QR code with Google's code scanner (Play services), so
  there's no camera permission, CameraX or barcode model in the app.

After changing `app.json` or a config plugin, regenerate `android/` with
`npx expo prebuild --platform android --no-install` (it's generated; keep your
`android/local.properties`).

Metro tree shaking is off: Expo marks it unstable, and it can drop modules
kept for their side effects (polyfills, Reanimated's setup) only in release
builds. To try it, build with
`EXPO_UNSTABLE_TREE_SHAKING=1 EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 ./gradlew assembleRelease`
and test pairing, unlock and the link before keeping it.
