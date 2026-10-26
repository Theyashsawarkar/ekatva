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

Coming: nāda's queue and search from the phone.
