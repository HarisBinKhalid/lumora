# Lumora ✨

Screen animations for GNOME on Ubuntu (Wayland): effects for moving the mouse
between monitors, terminal commands, the cursor, windows, the battery, the
clipboard, Wi-Fi / Bluetooth / VPN, sound and the lock screen, all set up
from one settings app.

Everything is **off after every restart**, on purpose: switch it back on from
the app (Home → **Enable all**).

## Install

    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 zip
    ./install.sh

`install.sh` builds and installs the four GNOME Shell extensions (Edge
Portal, Terminal FX, Desktop FX, System FX), the Lumora app and the `fx`
command, then opens the app.

**Log out and back in once** after installing (and after each update):
GNOME only loads extension code at login. The app tells you when it's needed
with a banner and a **Log Out** button.

Run `./install.sh` again after every change or update; it's safe to repeat.

## Run

- Open **Lumora** from the app grid, or run
  `python3 ~/.local/share/lumora/lumora.py`.
- The app opens on **Home**: press **Enable all**, or switch on just the
  groups you want. Each group also has its own tab in the sidebar with all
  its settings.
- Every animation has a **▶** preview button next to it.
- Settings apply instantly; only extension updates need a logout.

## The animations

### Edge Portal — moving the mouse between monitors

A subtle *exit* effect on the screen you leave and a big *entry* effect on the
screen you arrive on. With several switched on, a different one plays each
time.

| Animation | What it looks like |
|---|---|
| Teleport | Implodes on exit, a portal bursts open on entry |
| Shatter | Glass bits on exit, the wall cracks open on entry |
| Lightning | Static crackle on exit, a double lightning strike on entry |
| Warp drive | Light gets sucked in, then a light-speed beam fires across |
| Inferno | Drifting embers, then a fireball blast |
| Glitch | Pixels break apart, then a digital glitch burst |
| Edge barrier | A glow and particles when you push against a screen edge with no monitor beyond it (choose edges and colour) |

Settings: size compared to your cursor, which edges have the barrier, barrier
colour.

### Terminal FX — commands finishing

Put `fx` in front of a command (or pick **Animate → Every command**, below).
Always plays on your main screen.

| Animation | When |
|---|---|
| Confetti + green glow | A command succeeds |
| Warning banner + red glow | A command fails (it drops down and shakes) |
| Rocket launch | `git push` works |
| Rocket launch and crash | `git push` fails: it lifts off, sputters, flips and crashes |
| Rocket landing | `git pull` / `fetch` / `clone` works (landing legs, dust) |
| Rocket crash landing | `git pull` / `fetch` / `clone` fails |
| Commit stamp | `git commit`: a tick stamp, or a cracked cross on failure |
| Branches merging | `git merge` / `rebase` / `cherry-pick`: two branches join, or spark and pull apart on failure |
| Fireworks | A command that ran over a minute (set the time) |
| Grand finale | A command that ran over five minutes: a bigger show, a gold finale, then confetti |

Settings: confetti amount and duration, banner duration, which git commands
get their own animation, the long-command times, and which commands animate.

### Cursor

| Animation | Options |
|---|---|
| Cursor trail | Comet, Rainbow, Neon (pick its colour), Sparkles, Stars, Fire, Bubbles, Snow, Hearts, Pixels; size |
| Click effect | Water ripple, Shockwave, Sparks, Confetti pop, Hit marker; colour and size |
| Scroll combo | A meter at the side of the screen (left or right) fills while you keep scrolling, green → yellow → orange → red; full and still scrolling, it glows red and shakes |

### Windows

| Animation | When |
|---|---|
| Window snap | You drop a window onto a screen edge and it snaps or maximises: light runs along the whole edge from where you dropped it, with sparks and a shockwave |
| Crossing screens | You drag a window onto another monitor: a gate of light on the shared edge and a glowing outline sweeping over the window |

### Desktop

| Animation | When |
|---|---|
| Low battery warning | Battery below your level (default 10%) and not charging: a nearly empty battery blinks at the bottom of the screen, a "plug me in" bolt flashes and the bottom edge pulses red. Keeps showing until you plug in, or a short warning at each percent lost |
| Charged | Charging reaches your level (default 100%): the same battery fills up green and the bottom edge glows green |
| Copied | Something is copied (or cut) to the clipboard: a page duplicates next to the cursor |
| Files cut | Files are cut in the Files app: scissors snip a line |
| Typing combo | An arcade "COMBO x25!" counter while you type without pausing; bigger, shakier and changing colour as it grows (choose the corner and when it starts) |

### Connections

Plays at the top middle of your main screen, with the network or device name
under it (never on the lock screen).

| Animation | When |
|---|---|
| Wi-Fi connects | The Wi-Fi signal lights up and sends out a wave |
| Wi-Fi disconnects | The signal bars die out and crumble |
| Wi-Fi changes network | A beam carries the signal from the old access point to the new one |
| Bluetooth device connects | The Bluetooth rune is drawn and two devices pair up |
| Bluetooth device disconnects | The rune splits in two and drifts apart |
| VPN connects | A shield forms and a padlock clicks shut |
| VPN disconnects | The shield cracks and falls apart |

### Sound

| Animation | When |
|---|---|
| Volume up / down | Sound waves roll out / pull back in |
| Volume at 100% | The speaker shakes and blasts shockwaves |
| Volume at 0% | The waves drain away to a flat line |
| Sound muted / unmuted | A red slash cuts the waves / clears as green waves bloom |
| Microphone muted / unmuted | The voice ripples are cut off / rise again |

### Lock screen

| Animation | When |
|---|---|
| Screen locks | Rings implode onto a padlock as it clicks shut |
| Screen unlocks | The padlock springs open and rings burst out in gold |

## The `fx` command

The installer adds `source ~/.config/lumora/fx.sh` to your `~/.bashrc`, so in
new terminals:

    fx make build
    fx npm test
    fx git push
    fx eval "npm run lint && npm test"     # pipelines and && chains

**Every command:** in the app, Terminal FX → **Animate → Every command**, and
every command you run in bash gets an animation, no `fx` needed (even `ls`
and `cd`). Ctrl+C'd commands stay quiet.

**Over SSH** (e.g. Termius): copy `shell/fx.sh` to the server, source it from
the server's `~/.bashrc`, and forward the server's port 47321 back to your
laptop, e.g. `ssh -R 47321:127.0.0.1:47321 you@server`. To animate every
command there too, add `TERM_FX_ALL=1` to the server's `~/.bashrc`.

## Requirements and known limits

- GNOME 45–50 on Wayland (made on Ubuntu 24.04, GNOME 46).
- **Paste (Ctrl+V) has no animation.** GNOME doesn't tell extensions which
  keys you press, so the clipboard animations follow the clipboard itself:
  copying and cutting text look the same ("Copied"), files cut in the Files
  app get their own "Files cut" animation, and pasting can't be seen.
  GNOME 48+ (Ubuntu 26.04) may make a paste animation possible; not yet
  checked.
- The typing combo counts key presses, never which keys, and pauses on the
  lock screen. Scrolling goes to the scroll combo instead.
- "Every command" in Terminal FX works in bash only.
- VPNs are the ones set up in GNOME's network settings (including WireGuard).

## Troubleshooting

- **Nothing happens:** check the group is switched on (Home), and that its
  tab says **Running**. "Log out and back in" means GNOME hasn't loaded the
  latest version yet.
- **Logs:** `journalctl -f -o cat /usr/bin/gnome-shell`
- **Switch an extension off completely:**
  `gnome-extensions disable desktop-fx@local` (or `edge-portal@local`,
  `term-fx@local`, `system-fx@local`).

## For developers

Source layout, rules and how the pieces talk: see [CLAUDE.md](CLAUDE.md).
Previews and tests run without GNOME:

    cd tools/effects-preview && npm install
    npm run preview      # Edge Portal effects  -> out/*.png
    npm run scenes       # all other scenes     -> out/scene-*.png
    npm test             # runs every extension against a fake GNOME
    python3 tools/test-fx-hook.py   # the "every command" bash hook (from the repo root)
