---
title: "Media"
description: "What's playing on the laptop, its volume and the screen's brightness, from the phone."
---

The phone's home screen shows what the laptop is playing, with the cover,
where the track is, and play/pause, previous and next. Tap the bar to jump
in the track. Below: the volume (tap the speaker to mute) and the screen's
brightness.

It works with any player that speaks MPRIS: [nāda](https://github.com/Theyashsawarkar/nada),
[drishya](https://github.com/Theyashsawarkar/drishya), browsers, mpv,
Spotify. With more than one, pick which one to show; the one playing comes
first.

It needs the **Media, volume, brightness** capability (low risk).

## Logged and undoable

Like everything else, each change is in the action log on both devices:

| Change | Undo |
|---|---|
| Pause or play | plays or pauses again |
| Jump in a track | goes back to where it was |
| Volume, mute | the volume and mute from before |
| Brightness | the brightness from before |
| Next, previous, stop | none: they can't be taken back exactly |

Brightness never goes below 1%, so the phone can't leave you with a screen
too dark to fix.

## How

`playerctl` for the players, `wpctl` (PipeWire) for the default output's
volume, `brightnessctl` for the backlight. Whatever isn't installed just
doesn't show. Local cover art (nāda's cache) travels as a small image, up
to 256 KB; web covers as their URL.

While a phone watches, the laptop is told about changes instead of asking
for them: `dbus-monitor` passes on the players' own D-Bus signals (play,
pause, a new track, a seek, a player opening or closing), `pactl subscribe`
the volume's, and `udevadm monitor` the backlight's. A burst of signals is
one look (after 100 ms), and nothing runs while nothing changes. A playing
track's position isn't signalled by players: the phone moves it on by
itself from the position and time it was given, and a seek on the laptop
is sent at once. Everything is read again every 30 s in case a signal was
missed. When one of those tools is missing, its part is looked at every
1.5 s instead, as before.

Coming: nāda's queue and search from the phone.
