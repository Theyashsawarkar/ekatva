---
title: "Cryptography"
description: "Noise XX on audited pure-JS primitives, the same code on both devices."
---

| | |
|---|---|
| Handshake | **Noise_XX_25519_ChaChaPoly_BLAKE2b**, prologue `ekatva/1` |
| Key agreement | X25519 |
| Encryption | ChaCha20-Poly1305 (IETF), 64-bit counter nonces |
| Hash | BLAKE2b-512 (HKDF and the transcript), BLAKE2b-256 for the log |
| Library | [@noble](https://paulmillr.com/noble/) curves, ciphers and hashes: audited, pure JavaScript |

The same code runs in Node (the daemon), Electron and React Native (Hermes):
there's no native crypto to build or to differ between platforms.

**Interoperability is tested**: the test suite runs our handshake against an
independent implementation (holepunch's `noise-handshake`, on libsodium) in
both roles and checks the handshake hash and transport keys byte for byte.

## The pattern

```
XX:  -> e
     <- e, ee, s, es
     -> s, se
```

The phone initiates. XX sends both static keys encrypted, and each side checks
the other's against what it expects: the laptop's key from the QR or from
pairing; the phone's from the paired list (or a valid token when pairing).

## The transport

After the handshake, each WebSocket frame is one Noise message (at most
64 KiB, enforced by the server). Inside: a port byte (control, the laptop's
API, the phone's API, streams), a "more" flag for larger messages (reassembled
up to 16 MB), and the payload. A frame that fails to decrypt closes the session
for good: nonces never resynchronise. Keepalive pings run every 20 seconds.

## The emoji

`blake2b("ekatva/sas/1" ‖ handshake hash)`, 24 bits, as 4 of 64 emoji.
