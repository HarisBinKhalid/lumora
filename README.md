# Lumora ✨

Screen animations for GNOME:

- **Edge Portal**: teleport, shatter, lightning, warp, inferno and glitch
  animations when your mouse moves between monitors, plus a glowing barrier
  when you push against the edge of your screens.
- **Terminal FX**: put `fx` in front of a command for confetti when it
  succeeds, or a warning banner when it fails. Works over SSH too.
  `git push` launches a rocket (that crashes if the push fails), `git pull`
  lands one, `git commit` and `git merge` get their own animations, and
  commands that ran over a minute get fireworks (a grand finale after five).
- **Desktop FX**: a cursor trail, click ripples, a dust-and-shockwave slam
  when you snap a window to a screen edge, a gate of light when you drag a
  window onto another monitor, a low battery warning, a "charged" animation,
  copy / cut animations and an arcade typing combo counter.
- **System FX**: animations when Wi-Fi, Bluetooth or a VPN connects or
  disconnects (and when Wi-Fi moves to another network), when the volume or
  microphone changes, and when the screen locks or unlocks.
- **Lumora app**: pick animations, sizes and colors; changes apply instantly.

## Install

    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 zip
    ./install.sh

The app opens and tells you if you need to log out once.
Effects switch off at every restart; turn them back on from the app's Home
page (**Enable all**, or one switch per group).

## Use

    fx make build
    fx npm test
    fx git push
    fx eval "npm run lint && npm test"

Or pick **Animate → Every command** under Terminal FX in the app, and every
command you run in bash gets an animation, no `fx` needed.

## Requirements and known limits

- GNOME 45–50 on Wayland (made on Ubuntu 24.04, GNOME 46).
- **Paste (Ctrl+V) has no animation.** GNOME doesn't tell extensions which
  keys you press, so the clipboard animations follow the clipboard itself:
  copying and cutting text look the same ("Copied"), files cut in the Files
  app get their own "Files cut" animation, and pasting can't be seen.
  GNOME 48+ (Ubuntu 26.04) may make a paste animation possible; not yet
  checked.
- The typing combo counts key presses, never which keys, and can count
  mouse-wheel scrolling as typing.
- "Every command" in Terminal FX works in bash only.
