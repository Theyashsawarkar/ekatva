# Security

ekatva can type on your laptop, read your screen and, when you allow it,
run root commands. Please treat any weakness as serious.

## Reporting

Report vulnerabilities privately through GitHub's
[security advisories](https://github.com/Theyashsawarkar/ekatva/security/advisories/new),
not in public issues. You'll get an answer within a week.

## The rules the code keeps

- Nothing reaches a capability without a completed Noise handshake from a
  paired key; the laptop checks the phone's grants on every call.
- Pairing tokens are single-use and expire after two minutes; pairing needs
  the emoji confirmed on the laptop.
- Private keys stay in the Android keystore and the desktop keyring.
- A password typed on the phone for a root prompt goes only to that prompt;
  it is never logged, stored or kept in memory longer than the request.
- Root commands still go through dvarapala or polkit, which show exactly what
  will run.
- Agent answers are sent only after the daemon checks the pane still shows
  the question that was answered.

## Why the phone app allows cleartext traffic

`apps/mobile/app.json` sets `usesCleartextTraffic: true`. Android needs it for
`ws://` to the laptop on the same network: the laptop's LAN address changes
from network to network, and a network security config can't allow "any
private address". The traffic itself is not in the clear: every byte over that
WebSocket is a Noise XX channel (ChaCha20-Poly1305), authenticated by both
keys pinned at pairing. Nothing else the app loads may use plain HTTP: the
rendezvous is HTTPS, and covers come from the laptop as `data:` images, never
as a URL the phone would fetch itself (the phone drops any other kind).
