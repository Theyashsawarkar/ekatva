---
title: "Threats"
description: "What could go wrong, and what stops it."
---

| Someone… | What stops them |
|---|---|
| finds the tunnel URL | A Noise handshake only a paired key completes. Failed handshakes are counted per address: 8 in 10 minutes and it's shut out. The URL changes each time. |
| photographs the QR | The token works once, for two minutes; pairing needs matching emoji confirmed on the laptop. |
| uses the QR before your phone | Your phone's pairing fails (token spent) and you see a request with emoji your phone doesn't show: refuse it. |
| steals the phone | The app opens only with fingerprint and its own password; risky actions ask again; `ekatva unpair` revokes it at once. |
| runs the tunnel or the Wi-Fi | Sees ciphertext and sizes only. |
| tampers with traffic | The frame fails to decrypt and the session closes. |
| deletes or changes files through the phone | It's in the log on both devices; the old version is in the undo store. |
| tries to grant itself more | ekatva's state (grants, log, keys) is unreachable through files, and `admin` is never grantable to a phone. |
| edits the log to hide it | The hash chain breaks, and the other device's mirror disagrees. |
| answers Claude's next question by a late tap | Answers carry the question's hash and only land on that question. |
| floods the daemon with huge frames | Frames over 64 KiB are refused by the server; reassembly stops at 16 MB. |
