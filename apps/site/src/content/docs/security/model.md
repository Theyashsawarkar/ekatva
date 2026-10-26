---
title: "Security model"
description: "Keys, not passwords; capabilities, checked on every call; everything logged."
---

ekatva can type on your laptop, read files and, if you let it, approve root.
So security is the design, not a feature.

1. **Keys, not passwords.** Each device has a long-term X25519 key pair. Pairing
   exchanges public keys, checked with a one-time token and matching emoji.
   After that, every connection proves both keys in a Noise handshake.
2. **End to end.** Everything after the handshake is encrypted with keys only
   the two devices have. The Wi-Fi, a tunnel (Cloudflare, ngrok) or any proxy
   carry ciphertext.
3. **Capabilities.** A phone can do only what it's granted, checked on the laptop
   for **every call**, read fresh each time: revoking one stops the next call;
   unpairing closes the connection at once.
4. **Defense in depth.** Files stay inside shared folders; private places need
   their own grant; ekatva's state is unreachable. Root still goes through
   anumati or polkit.
5. **Everything is logged**, hash-chained, on both devices, without secrets.

## Keys at rest

- The laptop's secret key lives in your desktop keyring (Secret Service). With
  no keyring, in a file only you can read, with a warning.
- The phone's is sealed by the Android keystore.
- The local control socket is `0600` in your runtime directory.

## Reporting

Found a hole? Report it privately through
[GitHub security advisories](https://github.com/Theyashsawarkar/ekatva/security/advisories/new).
