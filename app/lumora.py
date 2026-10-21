#!/usr/bin/env python3
"""Lumora — settings app for the Edge Portal and Terminal FX extensions.

Every change is saved to ~/.config/lumora/config.json, which the
extensions watch, so changes apply instantly with no logout.
"""
import json
import os
import socket
import subprocess
import sys

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, GObject, Gtk  # noqa: E402

APP_ID = "local.lumora.Settings"
CONFIG_DIR = os.path.join(GLib.get_user_config_dir(), "lumora")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
RUNTIME_DIR = GLib.get_user_runtime_dir()
GObjectBindSync = GObject.BindingFlags.SYNC_CREATE

EDGE_UUID, TERM_UUID, DESK_UUID, SYS_UUID = "edge-portal@local", "term-fx@local", "desktop-fx@local", "system-fx@local"
EDGE_FLAG, TERM_FLAG = "edge-portal-on", "term-fx-on"
# Desktop FX has one switch per tab, so each can be on or off on its own.
CURSOR_FLAG, WINDOWS_FLAG, DESKTOP_FLAG = "desktop-fx-cursor-on", "desktop-fx-windows-on", "desktop-fx-desktop-on"
# System FX: one switch per tab too.
CONN_FLAG, SOUND_FLAG, LOCK_FLAG = "system-fx-connections-on", "system-fx-sound-on", "system-fx-lock-on"
EDGE_PREVIEW_PORT, TERM_PORT, DESK_PREVIEW_PORT, SYS_PREVIEW_PORT = 47322, 47321, 47323, 47324

EFFECTS = [
    ("teleport", "Teleport", "Implodes on exit, a portal bursts open on entry"),
    ("shatter", "Shatter", "Glass bits on exit, the wall cracks open on entry"),
    ("lightning", "Lightning", "Static crackle on exit, a double lightning strike on entry"),
    ("warp", "Warp drive", "Light gets sucked in, then a light-speed beam fires across"),
    ("inferno", "Inferno", "Drifting embers, then a fireball blast"),
    ("glitch", "Glitch", "Pixels break apart, then a digital glitch burst"),
]
EDGES = [("left", "Left edge"), ("right", "Right edge"), ("top", "Top edge"), ("bottom", "Bottom edge")]
GIT_EFFECTS = [
    ("push", "git push", "A rocket launches — or launches and crashes back down"),
    ("pull", "git pull / fetch / clone", "A rocket lands — or crashes on the way down"),
    ("commit", "git commit", "A stamp slams down: a tick, or a cracked cross"),
    ("merge", "git merge / rebase", "Two branches join — or spark and pull apart"),
]
TRAIL_STYLES = [("comet", "Comet"), ("rainbow", "Rainbow"), ("sparkles", "Sparkles"), ("stars", "Stars")]
RIPPLE_STYLES = [("ripple", "Water ripple"), ("shockwave", "Shockwave"), ("sparks", "Sparks"),
                 ("confetti", "Confetti pop")]
CONNECTION_FX = [
    ("wifi-on", "Wi-Fi connects", "The Wi-Fi signal lights up and sends out a wave"),
    ("wifi-off", "Wi-Fi disconnects", "The signal bars die out and crumble"),
    ("wifi-switch", "Wi-Fi changes network", "A beam carries the signal from the old access point to the new one"),
    ("bt-on", "Bluetooth device connects", "The Bluetooth rune is drawn and two devices pair up"),
    ("bt-off", "Bluetooth device disconnects", "The rune splits in two and drifts apart"),
    ("vpn-on", "VPN connects", "A shield forms and a padlock clicks shut"),
    ("vpn-off", "VPN disconnects", "The shield cracks and falls apart"),
]
SOUND_FX = [
    ("vol-up", "Volume up", "Sound waves roll out"),
    ("vol-down", "Volume down", "Sound waves pull back in"),
    ("vol-max", "Volume at 100%", "The speaker shakes and blasts shockwaves"),
    ("vol-zero", "Volume at 0%", "The waves drain away to a flat line"),
    ("mute", "Sound muted", "A red slash cuts the waves"),
    ("unmute", "Sound unmuted", "The slash clears and green waves bloom"),
    ("mic-mute", "Microphone muted", "The voice ripples are cut off"),
    ("mic-unmute", "Microphone unmuted", "Voice ripples rise on both sides"),
]
LOCK_FX = [
    ("lock", "Screen locks", "Light gathers and the padlock clicks shut"),
    ("unlock", "Screen unlocks", "The padlock springs open in a burst of gold"),
]
CLIPBOARD_FX = [
    ("copy", "Copied", "A page duplicates next to the cursor (copying or cutting anything)"),
    ("cut", "Files cut", "Scissors snip a line (files cut in the Files app)"),
]
# The Home tab: one "Animations on" switch per tab.
# (flag, tab name, title, icon, subtitle)
HOME_TABS = [
    ("edge-portal-on", "edge", "Edge Portal", "video-display-symbolic",
     "Moving the mouse between monitors"),
    ("term-fx-on", "terminal", "Terminal FX", "utilities-terminal-symbolic",
     "Commands finishing in the terminal"),
    ("desktop-fx-cursor-on", "cursor", "Cursor", "input-mouse-symbolic", "Cursor trail and click ripples"),
    ("desktop-fx-windows-on", "windows", "Windows", "focus-windows-symbolic", "Snapping and moving windows"),
    ("desktop-fx-desktop-on", "desktop", "Desktop", "battery-caution-symbolic",
     "Battery, clipboard and typing combo"),
    ("system-fx-connections-on", "connections", "Connections", "network-wireless-symbolic",
     "Wi-Fi, Bluetooth and VPN"),
    ("system-fx-sound-on", "sound", "Sound", "audio-volume-high-symbolic", "Volume and microphone"),
    ("system-fx-lock-on", "lock", "Lock screen", "system-lock-screen-symbolic", "Locking and unlocking"),
]

COMMAND_MODES = [("fx", "Only with fx"), ("all", "Every command")]
CORNERS = [("bottom-right", "Bottom right"), ("bottom-left", "Bottom left"),
           ("top-right", "Top right"), ("top-left", "Top left")]

DEFAULTS = {
    "edge": {
        "effects": [e[0] for e in EFFECTS],
        "size": 4.0,
        "barrier": True,
        "barrierEdges": [e[0] for e in EDGES],
        "barrierColor": "255, 40, 40",
    },
    "terminal": {
        "confetti": True,
        "successGlow": True,
        "confettiCount": 280,
        "confettiSpread": 1.8,
        "warning": True,
        "failGlow": True,
        "warningSeconds": 1.8,
        "commandMode": "fx",
        "gitEffects": [e[0] for e in GIT_EFFECTS],
        "longCommand": True,
        "longMinutes": 1.0,
        "epicMinutes": 5.0,
    },
    "desktop": {
        "trail": True,
        "trailStyle": "comet",
        "trailSize": 1.0,
        "ripples": True,
        "rippleStyle": "ripple",
        "rippleColor": "80, 170, 255",
        "rippleSize": 1.0,
        "windowSlam": True,
        "windowCross": True,
        "batteryFire": True,
        "batteryLevel": 10,
        "batteryKeepBurning": True,
        "combo": True,
        "comboMin": 10,
        "comboCorner": "bottom-right",
        "batteryFull": True,
        "batteryFullLevel": 100,
        "clipboard": [e[0] for e in CLIPBOARD_FX],
    },
    "system": {
        "connections": [e[0] for e in CONNECTION_FX],
        "showNames": True,
        "sound": [e[0] for e in SOUND_FX],
        "lock": [e[0] for e in LOCK_FX],
        "size": 1.0,
    },
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        for section, values in cfg.items():
            for key, default in values.items():
                v = data.get(section, {}).get(key)
                if isinstance(default, bool):
                    if isinstance(v, bool):
                        values[key] = v
                elif isinstance(default, (int, float)):
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        values[key] = type(default)(v)
                elif v is not None and type(v) is type(default):
                    values[key] = v
    except (OSError, ValueError, AttributeError):
        pass
    return cfg


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)  # atomic, so the extensions never read half a file


def send(port, msg):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
            s.sendall((msg + "\n").encode())
        return True
    except OSError:
        return False


def ext_state(uuid):
    try:
        out = subprocess.run(["gnome-extensions", "info", uuid],
                             capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return "UNKNOWN"
    for line in out.splitlines():
        if line.strip().lower().startswith("state:"):
            return line.split(":", 1)[1].strip().upper()
    return "MISSING"


EXT_DIR = os.path.join(GLib.get_user_data_dir(), "gnome-shell", "extensions")


def disk_version(uuid):
    """Version of the extension files installed on disk (None if not installed)."""
    try:
        with open(os.path.join(EXT_DIR, uuid, "metadata.json"), encoding="utf-8") as f:
            return str(json.load(f).get("version"))
    except (OSError, ValueError):
        return None


def running_version(uuid):
    """Version GNOME has actually loaded (written by the extension when it starts)."""
    try:
        with open(os.path.join(RUNTIME_DIR, "lumora", f"{uuid}.running"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def log_out():
    # Mode 1 = log out without GNOME asking again (we already asked).
    subprocess.Popen(["gdbus", "call", "--session", "--dest", "org.gnome.SessionManager",
                      "--object-path", "/org/gnome/SessionManager",
                      "--method", "org.gnome.SessionManager.Logout", "1"])


def flag_path(name):
    return os.path.join(RUNTIME_DIR, name)


def rgb_text(color_button):
    """The button's colour as "r, g, b" (the format the extensions expect)."""
    c = color_button.get_rgba()
    return f"{round(c.red * 255)}, {round(c.green * 255)}, {round(c.blue * 255)}"


class Window(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Lumora")
        self.set_default_size(820, 780)
        self.set_size_request(360, 400)  # breakpoints need a minimum size
        self.cfg = load_config()
        self._save_id = 0
        self._status = []  # (uuid, flag, state_row, enable_btn, switch_row)
        self._home_switches = []  # (flag, switch_row) on the Home tab

        # Tabs live in a scrollable sidebar (not the header bar), so any number fits.
        self.split = Adw.NavigationSplitView(min_sidebar_width=180, max_sidebar_width=240)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        view = Adw.ToolbarView()
        view.add_top_bar(Adw.HeaderBar())
        self.banner = Adw.Banner(title="Log out and back in to finish installing Lumora",
                                 button_label="Log Out", revealed=False)
        self.banner.connect("button-clicked", lambda _b: self._confirm_logout())
        view.add_top_bar(self.banner)
        self._asked_logout = False
        view.set_content(self.stack)
        self.content_page = Adw.NavigationPage(title="Lumora", child=view)

        self.tabs = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.tabs.add_css_class("navigation-sidebar")
        self.tabs.connect("row-selected", self._tab_selected)
        self.tabs.connect("row-activated", lambda _l, _r: self.split.set_show_content(True))
        sidebar = Adw.ToolbarView()
        sidebar.add_top_bar(Adw.HeaderBar())
        sidebar.set_content(Gtk.ScrolledWindow(child=self.tabs, vexpand=True,
                                               hscrollbar_policy=Gtk.PolicyType.NEVER))
        self.split.set_sidebar(Adw.NavigationPage(title="Lumora", child=sidebar))
        self.split.set_content(self.content_page)

        self.toasts = Adw.ToastOverlay(child=self.split)
        self.set_content(self.toasts)
        narrow = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 560sp"))
        narrow.add_setter(self.split, "collapsed", True)
        self.add_breakpoint(narrow)

        self._add_tab(self._home_page(), "home", "Home", "go-home-symbolic")
        self._add_tab(self._edge_page(), "edge", "Edge Portal", "video-display-symbolic")
        self._add_tab(self._term_page(), "terminal", "Terminal FX", "utilities-terminal-symbolic")
        self._add_tab(self._cursor_page(), "cursor", "Cursor", "input-mouse-symbolic")
        self._add_tab(self._windows_page(), "windows", "Windows", "focus-windows-symbolic")
        self._add_tab(self._desktop_page(), "desktop", "Desktop", "battery-caution-symbolic")
        self._add_tab(self._connections_page(), "connections", "Connections",
                      "network-wireless-symbolic")
        self._add_tab(self._sound_page(), "sound", "Sound", "audio-volume-high-symbolic")
        self._add_tab(self._lock_page(), "lock", "Lock screen", "system-lock-screen-symbolic")
        self.tabs.select_row(self.tabs.get_row_at_index(0))

        self._refresh_status()
        GLib.timeout_add_seconds(2, self._refresh_status)

    # ---------- tabs ----------

    def _add_tab(self, page, name, title, icon):
        self.stack.add_named(page, name)
        box = Gtk.Box(spacing=12, margin_top=6, margin_bottom=6)
        box.append(Gtk.Image(icon_name=icon))
        box.append(Gtk.Label(label=title, xalign=0, hexpand=True))
        row = Gtk.ListBoxRow(child=box)
        row.tab_name, row.tab_title = name, title
        self.tabs.append(row)

    def _open_tab(self, name):
        i = 0
        while (row := self.tabs.get_row_at_index(i)) is not None:
            if row.tab_name == name:
                self.tabs.select_row(row)
                self.split.set_show_content(True)
                return
            i += 1

    # ---------- Home: every "Animations on" switch in one place ----------

    def _home_page(self):
        page = Adw.PreferencesPage()
        group = Adw.PreferencesGroup(
            title="Lumora",
            description="Switch animations on here or on each tab: they're the same switches. "
                        "They all switch off when you restart.")
        self._all_btn = Gtk.Button(label="Enable all", halign=Gtk.Align.CENTER, margin_top=6)
        self._all_btn.add_css_class("pill")
        self._all_btn.add_css_class("suggested-action")
        self._all_btn.connect("clicked", lambda _b: self._toggle_all())
        group.add(self._all_btn)
        page.add(group)

        group = Adw.PreferencesGroup(title="Animations on")
        for flag, name, title, icon, sub in HOME_TABS:
            row = Adw.SwitchRow(title=title, subtitle=sub)
            row.add_prefix(Gtk.Image(icon_name=icon))
            row.set_active(os.path.exists(flag_path(flag)))
            row.connect("notify::active", lambda r, _p, f=flag: self._flag_switched(f, r.get_active()))
            go = Gtk.Button(icon_name="go-next-symbolic", valign=Gtk.Align.CENTER,
                            tooltip_text=f"Open the {title} settings")
            go.add_css_class("flat")
            go.connect("clicked", lambda _b, n=name: self._open_tab(n))
            row.add_suffix(go)
            group.add(row)
            self._home_switches.append((flag, row))
        page.add(group)
        self._update_all_button()
        return page

    def _all_on(self):
        return all(os.path.exists(flag_path(flag)) for flag, *_rest in HOME_TABS)

    def _toggle_all(self):
        on = not self._all_on()
        for flag, *_rest in HOME_TABS:
            self._flag_switched(flag, on)
        self._update_all_button()

    def _update_all_button(self):
        if not hasattr(self, "_all_btn"):
            return
        on = self._all_on()
        self._all_btn.set_label("Turn all off" if on else "Enable all")
        if on:
            self._all_btn.remove_css_class("suggested-action")
        else:
            self._all_btn.add_css_class("suggested-action")

    def _tab_selected(self, _list, row):
        if row is not None:
            self.stack.set_visible_child_name(row.tab_name)
            self.content_page.set_title(row.tab_title)

    # ---------- saving ----------

    def _changed(self):
        # Save shortly after the last change (spin buttons fire a lot).
        if self._save_id:
            GLib.source_remove(self._save_id)
        self._save_id = GLib.timeout_add(150, self._save_now)

    def _save_now(self):
        self._save_id = 0
        try:
            save_config(self.cfg)
        except OSError as e:
            self.toast(f"Could not save settings: {e}")
        return GLib.SOURCE_REMOVE

    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=3))

    # ---------- row helpers ----------

    def _switch(self, title, subtitle, active, on_change):
        row = Adw.SwitchRow(title=title, subtitle=subtitle or "")
        row.set_active(active)
        row.connect("notify::active", lambda r, _p: on_change(r.get_active()))
        return row

    def _spin(self, title, subtitle, value, lo, hi, step, digits, on_change):
        adj = Gtk.Adjustment(lower=lo, upper=hi, step_increment=step,
                             page_increment=step * 5, value=value)
        row = Adw.SpinRow(title=title, subtitle=subtitle or "", adjustment=adj, digits=digits)
        row.connect("notify::value", lambda r, _p: on_change(r.get_value()))
        return row

    def _preview_button(self, on_click):
        btn = Gtk.Button(icon_name="media-playback-start-symbolic",
                         valign=Gtk.Align.CENTER, tooltip_text="Preview")
        btn.add_css_class("flat")
        btn.connect("clicked", lambda _b: on_click())
        return btn

    def _status_group(self, uuid, flag, description):
        group = Adw.PreferencesGroup(title="Status", description=description)
        state_row = Adw.ActionRow(title="Extension")
        enable_btn = Gtk.Button(label="Enable", valign=Gtk.Align.CENTER, visible=False)
        enable_btn.add_css_class("suggested-action")
        enable_btn.connect("clicked", lambda _b: self._enable_ext(uuid))
        state_row.add_suffix(enable_btn)
        group.add(state_row)

        sw = Adw.SwitchRow(title="Animations on",
                           subtitle="Switches off automatically when you restart")
        sw.set_active(os.path.exists(flag_path(flag)))
        sw.connect("notify::active", lambda r, _p: self._flag_switched(flag, r.get_active()))
        group.add(sw)
        self._status.append((uuid, flag, state_row, enable_btn, sw))
        return group

    # ---------- status ----------

    def _flag_switched(self, flag, on):
        self._set_flag(flag, on)
        # The same switch shows on its tab and on Home: keep them in step.
        switches = [(f, sw) for _u, f, _r, _b, sw in self._status] + self._home_switches
        for f, sw in switches:
            if f == flag and sw.get_active() != on:
                sw.set_active(on)
        self._update_all_button()

    def _set_flag(self, flag, on):
        path = flag_path(flag)
        try:
            if on:
                open(path, "a").close()
            elif os.path.exists(path):
                os.remove(path)
        except OSError as e:
            self.toast(f"Could not switch: {e}")

    def _enable_ext(self, uuid):
        subprocess.run(["gnome-extensions", "enable", uuid], capture_output=True)
        GLib.timeout_add(600, lambda: self._refresh_status() and GLib.SOURCE_REMOVE)

    def _refresh_status(self):
        needs_logout = False
        states = {}  # one gnome-extensions call per extension, however many tabs show it
        for uuid, flag, row, btn, sw in self._status:
            state = states.get(uuid) or states.setdefault(uuid, ext_state(uuid))
            if state in ("ACTIVE", "ENABLED"):
                text, show_btn = "Running", False
            elif state in ("INACTIVE", "DISABLED"):
                text, show_btn = "Installed but disabled", True
            elif state == "ERROR":
                text, show_btn = "Error — see journalctl for details", False
            elif state in ("MISSING", "INITIALIZED"):
                text, show_btn = "Not loaded yet — log out and back in once after installing", False
            else:
                text, show_btn = f"State: {state.lower()}", False
            disk = disk_version(uuid)
            if disk is not None and state not in ("INACTIVE", "DISABLED") \
                    and running_version(uuid) != disk:
                text, show_btn = "Log out and back in to load the new version", False
                needs_logout = True
            row.set_subtitle(text)
            btn.set_visible(show_btn)
            on = os.path.exists(flag_path(flag))
            if sw.get_active() != on:  # e.g. switched off by a restart
                sw.set_active(on)
        for flag, sw in self._home_switches:
            on = os.path.exists(flag_path(flag))
            if sw.get_active() != on:
                sw.set_active(on)
        self._update_all_button()
        self.banner.set_revealed(needs_logout)
        if needs_logout and not self._asked_logout:
            self._asked_logout = True  # ask once per launch; the banner stays as a reminder
            GLib.idle_add(self._confirm_logout)
        return GLib.SOURCE_CONTINUE

    def _confirm_logout(self):
        heading = "Log out to finish installing"
        body = ("GNOME only loads new or updated extensions when you log in. "
                "Log out and back in once to start using these animations. "
                "After that, every change in this app applies instantly.\n\n"
                "Save your work in other apps before logging out.")
        if hasattr(Adw, "AlertDialog"):
            d = Adw.AlertDialog(heading=heading, body=body)
        else:
            d = Adw.MessageDialog(transient_for=self, heading=heading, body=body)
        d.add_response("later", "Later")
        d.add_response("logout", "Log Out Now")
        d.set_response_appearance("logout", Adw.ResponseAppearance.SUGGESTED)
        d.set_default_response("logout")
        d.set_close_response("later")
        d.connect("response", lambda _d, r: log_out() if r == "logout" else None)
        if hasattr(Adw, "AlertDialog"):
            d.present(self)
        else:
            d.present()
        return GLib.SOURCE_REMOVE

    # ---------- Edge Portal page ----------

    def _edge_page(self):
        c = self.cfg["edge"]
        page = Adw.PreferencesPage()
        page.add(self._status_group(EDGE_UUID, EDGE_FLAG,
                                    "Animations when the mouse moves between monitors"))

        group = Adw.PreferencesGroup(
            title="Crossing animations",
            description="With several switched on, a different one plays each time.")
        for key, title, sub in EFFECTS:
            row = self._switch(title, sub, key in c["effects"],
                               lambda on, k=key: self._toggle_effect(k, on))
            row.add_suffix(self._preview_button(lambda k=key: self._preview_edge(k)))
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(title="Size")
        group.add(self._spin("Animation size", "Compared to your mouse cursor",
                             c["size"], 1, 10, 0.5, 1, lambda v: self._set("edge", "size", v)))
        page.add(group)

        group = Adw.PreferencesGroup(
            title="Edge barrier",
            description="Glow and particles when you push against a screen edge "
                        "with no monitor beyond it")
        barrier = self._switch("Barrier glow", None, c["barrier"],
                               lambda on: self._set("edge", "barrier", on))
        group.add(barrier)
        for key, title in EDGES:
            row = self._switch(title, None, key in c["barrierEdges"],
                               lambda on, k=key: self._toggle_edge(k, on))
            barrier.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        color_row = Adw.ActionRow(title="Color")
        color_btn = Gtk.ColorDialogButton(dialog=Gtk.ColorDialog(with_alpha=False),
                                          valign=Gtk.Align.CENTER)
        rgba = Gdk.RGBA()
        rgba.parse(f"rgb({c['barrierColor']})")
        color_btn.set_rgba(rgba)
        color_btn.connect("notify::rgba", self._color_changed)
        color_row.add_suffix(color_btn)
        barrier.bind_property("active", color_row, "sensitive", GObjectBindSync)
        group.add(color_row)
        page.add(group)
        return page

    def _toggle_effect(self, key, on):
        effects = [k for k, _t, _s in EFFECTS
                   if (k == key and on) or (k != key and k in self.cfg["edge"]["effects"])]
        self.cfg["edge"]["effects"] = effects
        self._changed()

    def _toggle_edge(self, key, on):
        edges = [k for k, _t in EDGES
                 if (k == key and on) or (k != key and k in self.cfg["edge"]["barrierEdges"])]
        self.cfg["edge"]["barrierEdges"] = edges
        self._changed()

    def _color_changed(self, btn, _p):
        self._set("edge", "barrierColor", rgb_text(btn))

    def _preview_edge(self, key):
        if not send(EDGE_PREVIEW_PORT, f"preview {key}"):
            self.toast("Edge Portal isn’t running yet — log out and back in once")

    # ---------- Terminal FX page ----------

    def _term_page(self):
        c = self.cfg["terminal"]
        page = Adw.PreferencesPage()
        page.add(self._status_group(TERM_UUID, TERM_FLAG,
                                    "Animations when a terminal command finishes"))

        group = Adw.PreferencesGroup(
            title="Which commands",
            description="“Every command” (bash only) gives even ls and cd an animation. "
                        "It switches instantly; terminals opened before installing this "
                        "update need reopening once. On a server over SSH, put "
                        "TERM_FX_ALL=1 in its ~/.bashrc instead.")
        group.add(self._combo("Animate", "Only with fx: put fx in front, e.g. fx make", COMMAND_MODES, c["commandMode"],
                              lambda v: self._set("terminal", "commandMode", v)))
        page.add(group)

        group = Adw.PreferencesGroup(title="When a command succeeds")
        row = self._switch("Confetti", "Falls from the top of your main screen", c["confetti"],
                           lambda on: self._set("terminal", "confetti", on))
        row.add_suffix(self._preview_button(lambda: self._preview_term("success")))
        group.add(row)
        group.add(self._switch("Green glow at the top", None, c["successGlow"],
                               lambda on: self._set("terminal", "successGlow", on)))
        group.add(self._spin("Amount of confetti", None, c["confettiCount"], 50, 800, 10, 0,
                             lambda v: self._set("terminal", "confettiCount", int(v))))
        group.add(self._spin("Keeps dropping for", "Seconds", c["confettiSpread"], 0.5, 5, 0.1, 1,
                             lambda v: self._set("terminal", "confettiSpread", round(v, 1))))
        page.add(group)

        group = Adw.PreferencesGroup(title="When a command fails")
        row = self._switch("Warning banner", "Drops down from the top and shakes", c["warning"],
                           lambda on: self._set("terminal", "warning", on))
        row.add_suffix(self._preview_button(lambda: self._preview_term("fail")))
        group.add(row)
        group.add(self._switch("Red glow at the top", None, c["failGlow"],
                               lambda on: self._set("terminal", "failGlow", on)))
        group.add(self._spin("Banner stays for", "Seconds", c["warningSeconds"], 0.5, 6, 0.1, 1,
                             lambda v: self._set("terminal", "warningSeconds", round(v, 1))))
        page.add(group)

        group = Adw.PreferencesGroup(
            title="git commands",
            description="Their own animation instead of the confetti or the warning banner.")
        for key, title, sub in GIT_EFFECTS:
            row = self._switch(title, sub, key in c["gitEffects"],
                               lambda on, k=key: self._toggle_list("terminal", "gitEffects",
                                                                   [g[0] for g in GIT_EFFECTS], k, on))
            row.add_suffix(self._preview_pair(lambda ok, k=key: self._preview_git(k, ok)))
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(
            title="Long commands",
            description="Fireworks instead of confetti when a command took a while.")
        long_row = self._switch("Fireworks for long commands", None, c["longCommand"],
                                lambda on: self._set("terminal", "longCommand", on))
        group.add(long_row)
        rows = [
            self._spin("Fireworks after", "Minutes", c["longMinutes"], 0.5, 60, 0.5, 1,
                       lambda v: self._set("terminal", "longMinutes", round(v, 1))),
            self._spin("Grand finale after", "Minutes; a bigger show plus confetti",
                       c["epicMinutes"], 1, 240, 1, 0,
                       lambda v: self._set("terminal", "epicMinutes", round(v, 1))),
        ]
        rows[0].add_suffix(self._preview_button(lambda: self._preview_long(1)))
        rows[1].add_suffix(self._preview_button(lambda: self._preview_long(2)))
        for row in rows:
            long_row.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(title="How to use")
        row = Adw.ActionRow(title="Put fx in front of a command", use_markup=False)
        row.set_subtitle('fx make build   ·   fx npm test   ·   fx eval "lint && test"')
        row.set_subtitle_selectable(True)
        group.add(row)
        group.add(Adw.ActionRow(
            title="Over SSH (Termius)",
            subtitle="Forward remote port 47321 to 127.0.0.1:47321 on this laptop"))
        page.add(group)
        return page

    def _preview_term(self, kind, rest="1 preview"):
        if not send(TERM_PORT, f"preview-{kind} {rest}"):
            self.toast("Terminal FX isn’t running yet — log out and back in once")

    def _preview_git(self, key, ok):
        self._preview_term("success" if ok else "fail", f"{0 if ok else 1} d=0 git {key}")

    def _preview_long(self, tier):
        c = self.cfg["terminal"]
        minutes = c["epicMinutes"] if tier == 2 else c["longMinutes"]
        self._preview_term("success", f"0 d={int(minutes * 60) + 1} long command")

    # "▶ Works" and "▶ Fails" preview buttons side by side.
    def _preview_pair(self, on_click):
        box = Gtk.Box(spacing=2, valign=Gtk.Align.CENTER)
        for ok, label, tip in [(True, "Works", "Preview: the command worked"),
                               (False, "Fails", "Preview: the command failed")]:
            btn = Gtk.Button(tooltip_text=tip, child=Adw.ButtonContent(
                icon_name="media-playback-start-symbolic", label=label))
            btn.add_css_class("flat")
            btn.connect("clicked", lambda _b, ok=ok: on_click(ok))
            box.append(btn)
        return box

    # ---------- Desktop FX pages (Cursor, Windows, Desktop) ----------

    def _desk_status(self, flag, description):
        return self._status_group(DESK_UUID, flag, description)

    def _combo(self, title, subtitle, options, current, on_change):
        row = Adw.ComboRow(title=title, subtitle=subtitle or "",
                           model=Gtk.StringList.new([label for _k, label in options]))
        keys = [k for k, _l in options]
        row.set_selected(keys.index(current) if current in keys else 0)
        row.connect("notify::selected", lambda r, _p: on_change(keys[r.get_selected()]))
        return row

    def _preview_desk(self, msg):
        if not send(DESK_PREVIEW_PORT, msg):
            self.toast("Desktop FX isn’t running yet — log out and back in once")

    def _cursor_page(self):
        c = self.cfg["desktop"]
        page = Adw.PreferencesPage()
        page.add(self._desk_status(CURSOR_FLAG, "Cursor trail and click ripples"))

        group = Adw.PreferencesGroup(title="Cursor trail",
                                     description="Follows the mouse whenever animations are on.")
        trail = self._switch("Trail", None, c["trail"], lambda on: self._set("desktop", "trail", on))
        trail.add_suffix(self._preview_button(
            lambda: self._preview_desk(f"trail {self.cfg['desktop']['trailStyle']}")))
        group.add(trail)
        rows = [
            self._combo("Style", None, TRAIL_STYLES, c["trailStyle"],
                        lambda v: self._set("desktop", "trailStyle", v)),
            self._spin("Size", "Compared to your mouse cursor", c["trailSize"], 0.5, 3, 0.1, 1,
                       lambda v: self._set("desktop", "trailSize", round(v, 1))),
        ]
        for row in rows:
            trail.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(title="Click ripples")
        ripples = self._switch("Ripple on every click", None, c["ripples"],
                               lambda on: self._set("desktop", "ripples", on))
        ripples.add_suffix(self._preview_button(
            lambda: self._preview_desk(f"ripple {self.cfg['desktop']['rippleStyle']}")))
        group.add(ripples)
        color_row = Adw.ActionRow(title="Color")
        color_btn = Gtk.ColorDialogButton(dialog=Gtk.ColorDialog(with_alpha=False),
                                          valign=Gtk.Align.CENTER)
        rgba = Gdk.RGBA()
        rgba.parse(f"rgb({c['rippleColor']})")
        color_btn.set_rgba(rgba)
        color_btn.connect("notify::rgba", lambda b, _p: self._set("desktop", "rippleColor", rgb_text(b)))
        color_row.add_suffix(color_btn)
        rows = [
            self._combo("Effect", None, RIPPLE_STYLES, c["rippleStyle"],
                        lambda v: self._set("desktop", "rippleStyle", v)),
            color_row,
            self._spin("Size", "Compared to your mouse cursor", c["rippleSize"], 0.5, 3, 0.1, 1,
                       lambda v: self._set("desktop", "rippleSize", round(v, 1))),
        ]
        for row in rows:
            ripples.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        page.add(group)
        return page

    def _windows_page(self):
        c = self.cfg["desktop"]
        page = Adw.PreferencesPage()
        page.add(self._desk_status(WINDOWS_FLAG, "Animations when you drag windows"))
        group = Adw.PreferencesGroup(title="Dragging windows")
        row = self._switch("Window snap", "Light runs along the whole screen edge, with sparks and "
                           "a light shockwave, when a window you drop there snaps or maximises",
                           c["windowSlam"],
                           lambda on: self._set("desktop", "windowSlam", on))
        row.add_suffix(self._preview_button(lambda: self._preview_desk("slam")))
        group.add(row)
        row = self._switch("Crossing screens", "A gate of light sweeps over a window you drag "
                           "onto another monitor", c["windowCross"],
                           lambda on: self._set("desktop", "windowCross", on))
        row.add_suffix(self._preview_button(lambda: self._preview_desk("cross")))
        group.add(row)
        page.add(group)
        return page

    def _desktop_page(self):
        c = self.cfg["desktop"]
        page = Adw.PreferencesPage()
        page.add(self._desk_status(DESKTOP_FLAG, "Battery, clipboard and the typing combo"))

        # (The low battery setting keys still say "batteryFire": it used to be flames.)
        group = Adw.PreferencesGroup(title="Battery")
        low = self._switch("Low battery warning", "A nearly empty battery blinks at the bottom of "
                           "your main screen, with a red pulse along the edge", c["batteryFire"],
                           lambda on: self._set("desktop", "batteryFire", on))
        low.add_suffix(self._preview_button(lambda: self._preview_desk("lowbattery")))
        group.add(low)
        rows = [
            self._spin("Warn below", "Percent, while not charging", c["batteryLevel"], 1, 50, 1, 0,
                       lambda v: self._set("desktop", "batteryLevel", int(v))),
            self._switch("Keep showing until plugged in",
                         "Off: a short warning each time it drops another percent",
                         c["batteryKeepBurning"],
                         lambda on: self._set("desktop", "batteryKeepBurning", on)),
        ]
        for row in rows:
            low.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        full = self._switch("Charged", "The same battery at the bottom fills up green, with a green "
                            "glow along the edge, when charging reaches the level below", c["batteryFull"],
                            lambda on: self._set("desktop", "batteryFull", on))
        full.add_suffix(self._preview_button(lambda: self._preview_desk("charged")))
        group.add(full)
        level = self._spin("Charged at", "Percent", c["batteryFullLevel"], 50, 100, 1, 0,
                           lambda v: self._set("desktop", "batteryFullLevel", int(v)))
        full.bind_property("active", level, "sensitive", GObjectBindSync)
        group.add(level)
        page.add(group)

        group = Adw.PreferencesGroup(
            title="Clipboard",
            description="GNOME doesn’t tell apps which keys you press, so these follow the clipboard: "
                        "copying or cutting text looks the same, and pasting can’t be detected.")
        for key, title, sub in CLIPBOARD_FX:
            row = self._switch(title, sub, key in c["clipboard"],
                               lambda on, k=key: self._toggle_list("desktop", "clipboard",
                                                                   [e[0] for e in CLIPBOARD_FX], k, on))
            row.add_suffix(self._preview_button(lambda k=key: self._preview_desk(k)))
            group.add(row)
        page.add(group)

        group = Adw.PreferencesGroup(
            title="Typing combo",
            description="An arcade “COMBO x25!” counter while you type without pausing. "
                        "Only key presses are counted, never which keys; it pauses on the lock screen.")
        combo = self._switch("Combo counter", None, c["combo"],
                             lambda on: self._set("desktop", "combo", on))
        combo.add_suffix(self._preview_button(lambda: self._preview_desk("combo")))
        group.add(combo)
        rows = [
            self._spin("Shows after", "Keys in a row", c["comboMin"], 2, 100, 1, 0,
                       lambda v: self._set("desktop", "comboMin", int(v))),
            self._combo("Corner", None, CORNERS, c["comboCorner"],
                        lambda v: self._set("desktop", "comboCorner", v)),
        ]
        for row in rows:
            combo.bind_property("active", row, "sensitive", GObjectBindSync)
            group.add(row)
        page.add(group)
        return page

    # ---------- System FX pages (Connections, Sound, Lock screen) ----------

    def _preview_sys(self, name):
        if not send(SYS_PREVIEW_PORT, f"preview {name}"):
            self.toast("System FX isn’t running yet — log out and back in once")

    # A group with one switch + preview button per animation in `effects`.
    def _effects_group(self, title, description, key, effects):
        c = self.cfg["system"]
        group = Adw.PreferencesGroup(title=title, description=description or "")
        order = [e[0] for e in effects]
        for name, label, sub in effects:
            row = self._switch(label, sub, name in c[key],
                               lambda on, n=name: self._toggle_list("system", key, order, n, on))
            row.add_suffix(self._preview_button(lambda n=name: self._preview_sys(n)))
            group.add(row)
        return group

    def _size_group(self):
        group = Adw.PreferencesGroup(title="Size")
        row = self._spin("Animation size", "Shared by the Connections, Sound and Lock screen tabs",
                         self.cfg["system"]["size"], 0.5, 2.5, 0.1, 1, self._sys_size_changed)
        self._sys_size_rows = getattr(self, "_sys_size_rows", []) + [row]
        group.add(row)
        return group

    def _sys_size_changed(self, value):
        self._set("system", "size", round(value, 1))
        for row in self._sys_size_rows:          # keep the copies on other tabs in step
            if abs(row.get_value() - value) > 1e-6:
                row.set_value(value)

    def _connections_page(self):
        page = Adw.PreferencesPage()
        page.add(self._status_group(SYS_UUID, CONN_FLAG, "Wi-Fi, Bluetooth and VPN connecting and "
                                    "disconnecting. Plays at the top middle of your main screen, under the top bar."))
        page.add(self._effects_group("Wi-Fi", None, "connections", CONNECTION_FX[:3]))
        page.add(self._effects_group("Bluetooth", None, "connections", CONNECTION_FX[3:5]))
        page.add(self._effects_group("VPN", "VPNs set up in GNOME’s settings (NetworkManager), "
                                     "including WireGuard.", "connections", CONNECTION_FX[5:]))
        group = Adw.PreferencesGroup()
        group.add(self._switch("Show names", "The network or device name under the animation "
                               "(never on the lock screen)", self.cfg["system"]["showNames"],
                               lambda on: self._set("system", "showNames", on)))
        page.add(group)
        page.add(self._size_group())
        return page

    def _sound_page(self):
        page = Adw.PreferencesPage()
        page.add(self._status_group(SYS_UUID, SOUND_FLAG, "Volume and microphone changes, from the "
                                    "keyboard keys or anywhere else."))
        page.add(self._effects_group("Volume", None, "sound", SOUND_FX[:6]))
        page.add(self._effects_group("Microphone", None, "sound", SOUND_FX[6:]))
        page.add(self._size_group())
        return page

    def _lock_page(self):
        page = Adw.PreferencesPage()
        page.add(self._status_group(SYS_UUID, LOCK_FLAG, "Locking and unlocking the screen. "
                                    "Plays in the middle of your main screen."))
        page.add(self._effects_group("Lock screen", None, "lock", LOCK_FX))
        page.add(self._size_group())
        return page

    def _toggle_list(self, section, key, order, item, on):
        cur = self.cfg[section][key]
        self.cfg[section][key] = [k for k in order if (k == item and on) or (k != item and k in cur)]
        self._changed()

    def _set(self, section, key, value):
        self.cfg[section][key] = value
        self._changed()


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)

    def do_activate(self):
        win = self.props.active_window or Window(self)
        win.present()


if __name__ == "__main__":
    sys.exit(App().run(sys.argv))
