---
title: "Threats"
description: "What could go wrong, and what stops it."
---

| Someone… | What stops them |
|---|---|
| finds the tunnel URL | A Noise handshake only a paired key completes. Failed handshakes are counted per address: 8 in 10 minutes and it's shut out. The URL changes each time. |
| photographs the QR | The token works once, for two minutes; pairing needs matching emoji confirmed on the laptop. |
| uses the QR before your phone | Your phone's pairing fails (token spent) and you see a request with emoji your phone doesn't show: refuse it. |
| steals the phone | The app opens only with your fingerprint or the phone's screen lock (its keys are sealed in the Android keystore and never leave its secure hardware); root on the laptop also needs the laptop's password; risky actions ask again; `ekatva unpair` revokes it at once. |
| runs the tunnel or the Wi-Fi | Sees ciphertext and sizes only. |
| listens on the Wi-Fi for the beacon | 38 random-looking bytes every few seconds: no name, no key, a new nonce each time, so it can't tell whose laptop it is or follow it elsewhere. |
| replays or forges a beacon | A forged one doesn't open; a replayed one is refused after two minutes, and at most sends the phone to knock on an address where the Noise handshake fails without the laptop's key. |
| sends a fake tunnel header from the network | Believed only from the laptop itself, so it can't dodge the limit on failed handshakes. |
| tampers with traffic | The frame fails to decrypt and the session closes. |
| deletes or changes files through the phone | It's in the log on both devices; the old version is in the undo store. |
| tries to grant itself more | ekatva's state (grants, log, keys) is unreachable through files, and `admin` is never grantable to a phone. |
| edits the log to hide it | The hash chain breaks, and the other device's mirror disagrees. |
| answers Claude's next question by a late tap | Answers carry the question's hash and only land on that question. |
| watches the ntfy server | Sees a random topic name and ciphertext; can't read, forge or usefully replay a message (each carries its time, refused after 10 minutes). |
| finds the tunnel URL from the mailbox | Can't: it's encrypted; and the URL alone only leads to a Noise handshake. |
| runs as you on the laptop (an agent gone rogue) | Can use ekatva's local socket, as it can read your files: it's yours. Keep the phone's own grants (Settings on the phone) to what you need; everything it does is in both logs. |
| floods the daemon with huge frames | Frames over 64 KiB are refused by the server; reassembly stops at 16 MB. |
