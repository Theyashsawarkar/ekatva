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
- Root commands still go through anumati or polkit, which show exactly what
  will run.
- Agent answers are sent only after the daemon checks the pane still shows
  the question that was answered.
