# Lumora

Screen animations for GNOME on Ubuntu (Wayland). Five parts:

1. **Edge Portal** (`extensions/edge-portal@local/`): GNOME Shell extension.
   Plays an animation when the mouse crosses between monitors (subtle *exit*
   half on the old monitor, big *entry* half on the new one), and a red
   "barrier" glow when the mouse pushes against an outer screen edge.
2. **Terminal FX** (`extensions/term-fx@local/`): GNOME Shell extension.
   Confetti + green top glow when a command run with `fx` succeeds; red top
   glow + warning banner when it fails. git commands get their own Cairo
   scenes instead (push = rocket launch / launch-and-crash, pull/fetch/clone =
   rocket landing / crash, commit = stamp, merge/rebase/cherry-pick = branches
   joining / sparking). Commands that ran ≥ `longMinutes` get fireworks
   (tier 1), ≥ `epicMinutes` a bigger show + gold finale + confetti (tier 2);
   a long git command gets both. Always on the primary monitor.
3. **Desktop FX** (`extensions/desktop-fx@local/`): GNOME Shell extension.
   Cursor trail (comet / rainbow / sparkles / stars), click ripples (ripple /
   shockwave / sparks / confetti), window slam (dust + shockwave when a
   dragged window snaps or maximises), window crossing (light gate + glowing
   outline when a dragged window changes monitor), battery (a blinking
   nearly-empty battery + red edge pulse at the bottom of the primary monitor
   below `batteryLevel`% while discharging, and the same strip + battery in
   green (fills to full, bottom edge glows green) when charging reaches
   `batteryFullLevel`; UPower's DisplayDevice on the system
   bus), clipboard (copy, files cut), typing combo counter. The low battery
   setting keys are still `batteryFire` / `batteryKeepBurning` (it used to be
   flames); keep the names so saved settings keep working.
4. **System FX** (`extensions/system-fx@local/`): GNOME Shell extension.
   Wi-Fi / Bluetooth / VPN connect + disconnect, Wi-Fi switching network (or
   access point), volume up / down / 100% / 0% / mute / unmute, mic mute /
   unmute, screen lock / unlock. Status animations play at the top middle
   of the primary monitor, just under the top bar (one at a time: a new one replaces the one showing), with
   the network/device name under them (never while locked); lock/unlock in
   the middle of the primary monitor. Sources: NetworkManager (`gi://NM`,
   dynamic import), GnomeBluetooth 3.0 (dynamic import), GNOME's own mixer
   (`getMixerControl()` from ui/status/volume.js; shared, never close it),
   `Main.screenShield` `locked-changed`. Its metadata has
   `"session-modes": ["user", "unlock-dialog"]` so it keeps running on the
   lock screen; the other extensions are disabled there by GNOME as usual.
5. **Lumora app** (`app/lumora.py`): GTK4 + libadwaita (Python/PyGObject)
   settings window for all three extensions. Tabs are a scrollable sidebar
   (`Adw.NavigationSplitView`, collapses below ~560sp), not a header-bar
   switcher, so many tabs fit. Add a tab with `self._add_tab(...)` in
   `Window.__init__`. Tabs: Edge Portal, Terminal FX, Cursor / Windows /
   Desktop (Desktop FX) and Connections / Sound / Lock screen (System FX).
   Each of those tabs has its OWN on/off switch and flag file, so they work
   independently; the user asked for that.

Plus `shell/fx.sh`, the `fx` bash function users put in front of commands.
It also has an optional "every command" hook (bash only: DEBUG trap +
PROMPT_COMMAND) that reports commands typed without `fx`. It is active when
`"terminal": {"commandMode": "all"}` is in config.json (read with bash
built-ins at each prompt, no processes spawned) or `TERM_FX_ALL=1` (for
servers over SSH). It never installs over an existing DEBUG trap and keeps
any existing PROMPT_COMMAND (string or array). The extension doesn't read
`commandMode`; it's in term-fx DEFAULTS only to keep the lists in sync.

## Layout

```
app/lumora.py, app/lumora.svg          settings app + icon
extensions/edge-portal@local/          extension.js, effects.js, metadata.json
extensions/term-fx@local/              extension.js, scenes.js (git + fireworks), metadata.json
extensions/desktop-fx@local/           extension.js, scenes.js (ripples, slam, gate, battery, clipboard), metadata.json
extensions/system-fx@local/            extension.js, scenes.js (connections, sound, lock), metadata.json
extensions/shared/config.js            SINGLE SOURCE: LiveConfig + localhost listener
extensions/shared/draw.js              SINGLE SOURCE: Cairo helpers (glow, puff, glowStroke, explosion...)
extensions/shared/unredirect.js        SINGLE SOURCE: keeps overlays visible over full-screen-covering apps
shell/fx.sh                            the fx command (installed to ~/.config/lumora/fx.sh)
tools/effects-preview/                 renders + tests everything without GNOME (see Testing)
tools/test-fx-hook.py                  tests fx.sh's "every command" bash hook in a real pty
install.sh                             builds build/*.zip from source and installs everything
```

`install.sh` copies every `extensions/shared/*.js` into every extension.
Never edit files under `build/` or the installed copies in `~/.local/share/`.
Edit the source here and run `./install.sh`.

## How the pieces talk

- **Settings:** the app writes `~/.config/lumora/config.json` (atomic replace).
  All extensions watch that directory (`LiveConfig` in `shared/config.js`) and
  reload instantly, so settings changes never need a logout.
  Sections: `"edge"`, `"terminal"`, `"desktop"`, `"system"`. Defaults are duplicated and
  must stay in sync: `DEFAULTS` in `app/lumora.py`, and `DEFAULTS` in each
  `extension.js`. A new setting needs adding in all relevant places.
  `LiveConfig` only accepts keys that exist in the extension's DEFAULTS, with
  the same JS type.
- **On/off switches:** files in `$XDG_RUNTIME_DIR`: `edge-portal-on`,
  `term-fx-on`, and for Desktop FX one per tab: `desktop-fx-cursor-on`
  (trail, ripples), `desktop-fx-windows-on` (slam, crossing),
  `desktop-fx-desktop-on` (battery, clipboard, combo), and for System FX:
  `system-fx-connections-on`, `system-fx-sound-on`, `system-fx-lock-on`.
  `/run/user/<id>` is wiped at reboot, so effects are always OFF after a
  restart. This is a deliberate safety feature the user asked for. Do not
  make the extensions run without the flag. Desktop FX only watches input
  while the relevant flag is on (idle watch: cursor or desktop; window-drag
  signals: windows; pointer polling: cursor, or while a drag is in progress).
- **Ports (127.0.0.1 only, never bind other interfaces):**
  - 47321: Terminal FX. Messages: `success <rc> [d=<seconds>] <cmd>`,
    `fail <rc> [d=<seconds>] <cmd>` (`d=` = how long it ran; older fx.sh
    leaves it out, keep that working), and `preview-success|preview-fail ...`
    from the app (previews ignore the flag and the git/long settings; the app
    previews git scenes as `preview-success 0 d=0 git push`).
  - 47322: Edge Portal previews from the app: `preview <effect-name>`.
  - 47323: Desktop FX previews from the app: `trail <style>`,
    `ripple <style>`, `slam`, `cross`, `lowbattery`, `charged`, `copy`,
    `cut`, `combo`.
  - 47324: System FX previews: `preview <name>` (names = keys of `SCENES`
    in its scenes.js, e.g. `wifi-switch`, `vol-max`, `unlock`).
  Over SSH (Termius), users forward remote port 47321 to the laptop.
- **"Needs logout" detection:** on enable, each extension writes its
  `metadata.version` to `$XDG_RUNTIME_DIR/lumora/<uuid>.running`. The app
  compares it with the installed `metadata.json` version and shows a logout
  popup + banner when they differ.

## Rules when changing things

- **Extension code changes need a logout on Wayland** (GNOME only loads
  extension code at login). Always **bump `"version"`** in that extension's
  `metadata.json`, or the app's logout prompt won't appear. Changing a shared
  file changes every extension that imports it.
- App (`lumora.py`) changes apply when the app is reopened. `fx.sh` changes
  apply in new terminals.
- Target GNOME 45-50 (ESM modules: `import X from 'gi://X'`). Ubuntu 24.04 =
  GNOME 46, GTK 4.14, libadwaita 1.5. Keep the app working on libadwaita 1.5.
- Extensions must be click-through and safe: overlays are `reactive: false`,
  every timer/actor/listener is cleaned up in `disable()`, errors are caught
  and logged rather than thrown in loops.
- **Overlays must stay visible over apps:** when one app covers a whole
  monitor (e.g. maximised on a screen without the top bar), GNOME scans it
  out directly and skips drawing the shell there, hiding our effects. Every
  extension holds `Unredirect` (shared/unredirect.js) while it has anything
  on screen (set from `_add`/`_remove`/`_finish`, released in `disable()`;
  a resting cursor trail doesn't count). `actor.ease()` does this by itself,
  but Cairo timelines and per-tick updates don't. Keep the hold balanced.
- Never put unvalidated config values into CSS strings (see `_barrierColor`,
  `_rippleRgb`). CSS colours come from fixed lists in the code.
- The user has multiple monitors, including one placed ABOVE the primary.
  Terminal FX draws inside a layer clipped to the primary monitor for this
  reason; Desktop FX clips slams and crossing gates to their monitor
  (`_playPlaced(..., mon)`). Edge Portal's barrier must never be placed on an
  edge shared between monitors (see `_computeOuterSegments`; it has a 2px
  tolerance).
- **Input on Wayland (GNOME 46, tested):** extensions can NOT see key presses
  or clicks that go to app windows (`global.stage` `captured-event` and
  `Clutter.Event.add_filter` only get events for shell UI). Desktop FX uses
  `global.backend.get_core_idle_monitor().add_idle_watch(1, cb)`, which fires
  once per input event of any kind; if `global.get_pointer()` (position +
  button mask) didn't change since the last event, it was a key (press and
  release each count, so keys = events / 2). Clicks = a new bit in the button
  mask, checked from both the idle watch and the 16ms pointer ticker. The
  combo never sees which key, and is off while the screen is locked.
- **Clipboard:** keys can't be seen (above), so Desktop FX follows
  `global.display.get_selection()` `owner-changed` for the CLIPBOARD:
  any new owner = "copied" (copy and cut of text look the same); files with
  `x-special/gnome-copied-files` content starting `cut` = "files cut".
  Memory sources (GNOME keeping the clipboard after an app quits, or the
  shell/extensions setting it) are ignored. Paste is NOT detectable; the
  user chose this over taking over the clipboard.
- **System FX events:** ignore what devices report for `SETTLE_MS` after
  starting to watch (no burst at login). Wi-Fi off waits `SWITCH_WAIT_MS`
  (longer while another Wi-Fi connection is ACTIVATING): if a different
  network comes up it's `wifi-switch`, else `wifi-off`. Same network, new
  BSSID = `wifi-switch` too, at most once per `ROAM_MS`. A new default
  sound device resets the volume baseline (no animation for the jump).
  VPN = NM types `vpn`, `wireguard`, `tun`.
- Window slam is decided from geometry after the drop (`_snapSide`): the
  window must have changed size and now fill a half / quarter / the whole
  work area. Works with Ubuntu's tiling-assistant, which tiles on its own.

## Drawing conventions

**effects.js (Edge Portal):** each effect is `{exit: () => spec, entry: () => spec}`. A spec is
`{duration, fwd, back, half, draw(cr, t)}`: drawn with Cairo in a local frame
where +x points in the direction of travel and (0,0) is the crossing point;
`t` goes 0 to 1. The canvas covers `back` px behind, `fwd` px ahead and `half`
px to each side, so keep everything inside that box and fade things out before
they reach its edges (a hard cut at the box edge looks bad). Exit halves stay
subtle (particles); entry halves are the big moment. Effects are scaled by
the cursor size times the user's size setting; design at full size (~300px core).
Use `setLW()` for line widths. Keep per-frame work light (the inferno effect
had to be optimised).

**scenes.js (Terminal FX):** a scene is `{duration, x, y, w, h, draw(cr, t)}`
in design units of a 1080p screen, placed inside the monitor; the extension
scales by `mon.height / 1080`. Fireworks are a list of scenes with a `delay`
(ms) each, one small canvas per burst (never one full-screen canvas).

**scenes.js (System FX):** every scene is a box centred on its anchor
(`centred()` / `box()` from draw.js), 1080p design units, scaled by the
monitor and the `size` setting.

**scenes.js (Desktop FX):** edge-relative drawings use the same
`{fwd, back, half}` frame as effects.js and go through `place(spec, dir)`;
ripples use `centred()`. Ripples are designed for a 24px cursor (scaled by
cursor size × size setting); slam / gate / battery for a 1080p screen. The
low battery warning is the one long-running canvas: it redraws at ~30fps and draws
only a few shapes and ONE gradient per frame to stay cheap. The cursor trail is
not Cairo: it's a fixed pool of St widgets moved every tick (no actors
created per frame), and it skips all work while the mouse rests.

## Testing

Do NOT start a second gnome-shell on the user's laptop (headless, nested or
devkit): a headless test shell grabbed the GPU and hung the machine. The
user does all real-GNOME testing; the offline Node tools below are fine
(they never touch GNOME).

- `cd tools/effects-preview && npm install`, then:
  - `npm run preview` (or `-- warp`): Edge Portal effects to `out/*.png`.
  - `npm run scenes` (or `-- push`): Terminal, Desktop and System FX scenes to
    `out/scene-*.png`. Env vars: `SHOT=0.6` zoom, `TIMES=0.2,0.5` (fractions
    of the scene), `CROP=x,y,w,h` (design units).
  - `npm test` (or `-- edge` / `-- desktop` / `-- terminal` / `-- system`):
    runs every extension's real `extension.js` against a fake GNOME
    (`gnome-mock.mjs`: manual clock, St/Clutter/GLib/Gio/Meta/Main stubs,
    simulated pointer, keys, window drags, UPower, clipboard, NetworkManager,
    Bluetooth, the mixer and the lock screen; dynamic `import('gi://X')` is
    rewritten to the mock). Checks behaviour, errors, and that
    `disable()` leaves no actors, timers, timelines, watchers or unredirect holds; saves
    rough screenshots to `out/test-*.png`. Add a scenario there for new
    behaviour. All of these fail on NaN/Infinity coordinates.
- `python3 tools/test-fx-hook.py`: the fx.sh "every command" hook in a real
  interactive bash (modes, empty Enter, fx not doubled, PROMPT_COMMAND forms).
- Syntax: `node --check --input-type=module < extensions/edge-portal@local/extension.js`
  (same for the others), `python3 -m py_compile app/lumora.py`, `bash -n install.sh`.
- Logs (real session): `journalctl -f -o cat /usr/bin/gnome-shell`.
