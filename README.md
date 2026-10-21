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
  window onto another monitor, flames when the battery runs low, and an
  arcade typing combo counter.
- **Lumora app**: pick animations, sizes and colors; changes apply instantly.

## Install

    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 zip
    ./install.sh

The app opens and tells you if you need to log out once.
Effects switch off at every restart; turn them on in the Lumora app.

## Use

    fx make build
    fx npm test
    fx git push
    fx eval "npm run lint && npm test"

Or pick **Animate → Every command** under Terminal FX in the app, and every
command you run in bash gets an animation, no `fx` needed.
