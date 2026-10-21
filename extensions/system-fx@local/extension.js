import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {LiveConfig, listen} from './config.js';
import {Unredirect} from './unredirect.js';
import {SCENES} from './scenes.js';

// Defaults; the Lumora app changes these live via ~/.config/lumora/config.json
const DEFAULTS = {
    connections: ['wifi-on', 'wifi-off', 'wifi-switch', 'bt-on', 'bt-off', 'vpn-on', 'vpn-off'],
    showNames: true,              // network / device name under the animation
    sound: ['vol-up', 'vol-down', 'vol-max', 'vol-zero', 'mute', 'unmute', 'mic-mute', 'mic-unmute'],
    lock: ['lock', 'unlock'],
    size: 1,
};

// ---- Safety switches ----
// Each group does NOTHING unless its file exists. /run/user/<id>/ is wiped on
// every restart, so the effects are always OFF after a reboot.
//   Turn on:  touch "$XDG_RUNTIME_DIR/system-fx-sound-on"
const FLAGS = {
    connections: 'system-fx-connections-on',  // Wi-Fi, Bluetooth, VPN
    sound: 'system-fx-sound-on',              // volume, mute, microphone
    lock: 'system-fx-lock-on',                // locking / unlocking the screen
};
const GROUP_OF = Object.fromEntries(Object.entries(DEFAULTS)
    .filter(([, v]) => Array.isArray(v)).flatMap(([group, names]) => names.map(n => [n, group])));

const PREVIEW_PORT = 47324;       // the Lumora app sends previews here
const SETTLE_MS = 4000;           // ignore what devices report when we first look at them
const SWITCH_WAIT_MS = 2500;      // Wi-Fi off: wait this long for a new network first
const SWITCH_MAX_MS = 30000;      // ...and up to this long while one is still connecting
const REPEAT_MS = 250;            // the same animation again within this is skipped
const ROAM_MS = 30000;            // at most one "switched access point" per this

const PREVIEW_NAMES = {'wifi-on': 'Home Wi-Fi', 'wifi-off': 'Home Wi-Fi', 'wifi-switch': 'Office Wi-Fi',
    'bt-on': 'Headphones', 'bt-off': 'Headphones', 'vpn-on': 'Work VPN', 'vpn-off': 'Work VPN'};

export default class SystemFxExtension extends Extension {
    // Tells the Lumora app which version of this code GNOME is running,
    // so it can tell you when a log out is needed to load an update.
    _markRunning(on) {
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'lumora']);
        const path = GLib.build_filenamev([dir, `${this.metadata.uuid}.running`]);
        try {
            if (on) {
                GLib.mkdir_with_parents(dir, 0o700);
                GLib.file_set_contents(path, String(this.metadata.version ?? 0));
            } else {
                Gio.File.new_for_path(path).delete(null);
            }
        } catch (e) {}
    }

    enable() {
        this._markRunning(true);
        this._flagPaths = Object.fromEntries(Object.entries(FLAGS).map(
            ([k, name]) => [k, GLib.build_filenamev([GLib.get_user_runtime_dir(), name])]));
        this._on = {connections: false, sound: false, lock: false};
        this._actors = new Set();
        this._timelines = new Set();
        this._timeouts = new Set();
        this._unredirect = new Unredirect();
        this._slots = {};               // 'status' / 'lock': the animation showing there
        this._lastShow = {};
        this._netGen = 0;
        this._btGen = 0;
        this._acs = null;
        this._btDevs = null;
        this._mixer = null;
        this._streams = {sink: null, source: null};
        this._lockWatch = false;

        this._cfg = new LiveConfig('system', DEFAULTS);
        try {
            this._preview = listen(PREVIEW_PORT, line => this._safe(() => this._onPreview(line)));
        } catch (e) {
            console.warn(`System FX: preview listener unavailable: ${e}`);
            this._preview = null;
        }
        this._sync();
        this._flagTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._safe(() => this._sync());
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._markRunning(false);
        if (this._flagTimerId) {
            GLib.source_remove(this._flagTimerId);
            this._flagTimerId = 0;
        }
        this._on = {connections: false, sound: false, lock: false};
        this._stopNetwork();
        this._stopBluetooth();
        this._stopSound();
        this._stopLock();
        if (this._preview) {
            this._preview.stop();
            this._preview.close();
            this._preview = null;
        }
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        for (const tl of this._timelines)
            tl.stop();
        this._timelines.clear();
        for (const a of this._actors) {
            a.remove_all_transitions();
            a.destroy();
        }
        this._actors.clear();
        this._slots = {};
        this._unredirect.release();
        this._cfg?.destroy();
        this._cfg = null;
    }

    // ---------- Switching groups on and off ----------

    _sync() {
        for (const k in this._flagPaths)
            this._on[k] = GLib.file_test(this._flagPaths[k], GLib.FileTest.EXISTS);
        if (this._on.connections) {
            this._startNetwork();
            this._startBluetooth();
        } else {
            this._stopNetwork();
            this._stopBluetooth();
        }
        if (this._on.sound)
            this._startSound();
        else
            this._stopSound();
        if (this._on.lock)
            this._startLock();
        else
            this._stopLock();
    }

    // ---------- Helpers ----------

    _safe(fn) {
        try {
            fn();
        } catch (e) {
            console.error(`System FX: ${e}`);
        }
    }

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            this._safe(fn);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _cancelLater(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
    }

    _add(actor) {
        Main.uiGroup.add_child(actor);
        this._actors.add(actor);
        this._unredirect.set(true);
        return actor;
    }

    _remove(actor) {
        if (!this._actors.has(actor))
            return;
        this._actors.delete(actor);
        this._unredirect.set(this._actors.size > 0);
        if (actor._fxTimeline) {
            actor._fxTimeline.stop();
            this._timelines.delete(actor._fxTimeline);
        }
        actor.destroy();
    }

    _locked() {
        return Main.sessionMode.isLocked;
    }

    // ---------- Showing an animation ----------

    // A real event: only if its group is switched on and it's ticked in settings.
    _play(name, label = null) {
        const group = GROUP_OF[name];
        if (!group || !this._on[group] || !this._cfg.values[group].includes(name))
            return;
        this._show(name, label);
    }

    // Status animations sit at the top middle, just under the top bar;
    // lock / unlock in the middle of the screen.
    _show(name, label = null) {
        const make = SCENES[name];
        if (!make)
            return;
        const now = this._now();
        if (now - (this._lastShow[name] ?? -1e9) < REPEAT_MS)
            return;
        this._lastShow[name] = now;

        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const size = Math.max(0.4, Math.min(3, this._cfg.values.size));
        const sc = Math.max(0.5, Math.min(3, mon.height / 1080)) * size;
        const spec = make();
        const slot = GROUP_OF[name] === 'lock' ? 'lock' : 'status';
        let x, y;
        if (slot === 'lock') {
            x = mon.x + mon.width / 2;
            y = mon.y + mon.height / 2;
        } else {
            const panel = Main.panel?.height ?? 0;
            x = mon.x + mon.width / 2;
            y = mon.y + panel + 8 * sc + spec.h * sc / 2;
        }
        // One animation per spot: a new one replaces the one showing there.
        if (this._slots[slot])
            this._remove(this._slots[slot]);
        const showName = label && this._cfg.values.showNames && !this._locked() ? label : null;
        const root = this._playPlaced(spec, x, y, sc, mon, showName, () => {
            if (this._slots[slot] === root)
                delete this._slots[slot];
        });
        this._slots[slot] = root;
    }

    // Plays a scene centred on (x, y), clipped to the monitor, with an
    // optional name label under it. Returns the root actor.
    _playPlaced(spec, x, y, sc, mon, label, onDone) {
        const root = new St.Widget({
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
            clip_to_allocation: true, reactive: false,
        });
        const area = new St.DrawingArea({
            width: Math.max(1, Math.ceil(spec.w * sc)), height: Math.max(1, Math.ceil(spec.h * sc)),
            reactive: false,
        });
        area.set_position(Math.round(x - spec.ox * sc - mon.x), Math.round(y - spec.oy * sc - mon.y));
        root.add_child(area);
        let t = 0;
        area.connect('repaint', a => {
            const cr = a.get_context();
            try {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);
                cr.scale(sc, sc);
                spec.draw(cr, t);
            } catch (e) {
                if (!this._drawErrorLogged) {
                    this._drawErrorLogged = true;
                    console.error(`System FX draw error: ${e}`);
                }
            } finally {
                cr.$dispose();
            }
        });
        if (label) {
            // The name is set as text, never put into the CSS.
            const text = new St.Label({
                text: label.length > 40 ? `${label.slice(0, 39)}…` : label,
                reactive: false, opacity: 0,
                style: `color: #ffffff; font-weight: bold; font-size: ${Math.round(15 * sc)}px;` +
                       'background-color: rgba(20, 22, 28, 0.78); border-radius: 10px;' +
                       `padding: ${Math.round(4 * sc)}px ${Math.round(12 * sc)}px;`,
            });
            root.add_child(text);
            const [, w] = text.get_preferred_width(-1);
            text.set_position(Math.round(x - mon.x - w / 2), Math.round(y - mon.y + spec.h * sc * 0.36));
            text.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._later(Math.max(400, spec.duration - 450), () => {
                if (this._actors.has(root))     // not replaced in the meantime
                    text.ease({opacity: 0, duration: 400, mode: Clutter.AnimationMode.EASE_IN_QUAD});
            });
        }
        this._add(root);
        const tl = new Clutter.Timeline({actor: area, duration: spec.duration});
        root._fxTimeline = tl;
        this._timelines.add(tl);
        tl.connect('new-frame', () => {
            t = tl.get_progress();
            area.queue_repaint();
        });
        tl.connect('completed', () => {
            this._timelines.delete(tl);
            root._fxTimeline = null;
            this._remove(root);
            onDone?.();
        });
        area.queue_repaint();
        tl.start();
        return root;
    }

    // ---------- Wi-Fi and VPN (NetworkManager) ----------

    _startNetwork() {
        if (this._acs || this._netStarting)
            return;
        this._netStarting = true;
        const gen = ++this._netGen;
        this._netCancel = new Gio.Cancellable();
        import('gi://NM').then(({default: NM}) => {
            if (gen !== this._netGen)
                return;
            NM.Client.new_async(this._netCancel, (_o, res) => {
                let client;
                try {
                    client = NM.Client.new_finish(res);
                } catch (e) {
                    if (gen === this._netGen)
                        console.warn(`System FX: no NetworkManager (${e})`);
                    this._netStarting = false;
                    return;
                }
                if (gen !== this._netGen)
                    return;
                this._safe(() => this._netReady(NM, client));
            });
        }).catch(e => {
            console.warn(`System FX: NetworkManager not available (${e})`);
            this._netStarting = false;
        });
    }

    _netReady(NM, client) {
        this._netStarting = false;
        this._NM = NM;
        this._nm = client;
        this._acs = new Map();          // active connection -> what we know about it
        this._netSince = this._now();
        client.connectObject(
            'active-connection-added', (_c, ac) => this._safe(() => this._trackAc(ac)),
            'active-connection-removed', (_c, ac) => this._safe(() => this._untrackAc(ac, true)),
            this);
        for (const ac of client.get_active_connections() ?? [])
            this._trackAc(ac);
    }

    _stopNetwork() {
        this._netGen++;
        this._netStarting = false;
        this._netCancel?.cancel();
        this._netCancel = null;
        for (const ac of [...(this._acs?.keys() ?? [])])
            this._untrackAc(ac, false);
        this._acs = null;
        this._nm?.disconnectObject(this);
        this._nm = null;
        if (this._wifiPending) {
            this._cancelLater(this._wifiPending.timer);
            this._wifiPending = null;
        }
    }

    _acKind(ac) {
        const type = ac.get_connection_type();
        if (type === '802-11-wireless')
            return 'wifi';
        if (ac.get_vpn?.() || ['vpn', 'wireguard', 'tun'].includes(type))
            return 'vpn';
        return null;
    }

    _trackAc(ac) {
        if (!this._acs || this._acs.has(ac))
            return;
        const kind = this._acKind(ac);
        if (!kind)
            return;
        const NM = this._NM;
        const rec = {kind, name: ac.get_id() ?? '', active: ac.get_state() === NM.ActiveConnectionState.ACTIVATED,
            dev: null, bssid: null};
        ac.connectObject('notify::state', () => this._safe(() => this._acState(ac)), rec);
        if (kind === 'wifi') {
            const dev = ac.get_devices?.()?.[0];
            if (dev?.get_active_access_point) {
                rec.dev = dev;
                rec.bssid = dev.get_active_access_point()?.get_bssid() ?? null;
                dev.connectObject('notify::active-access-point', () => this._safe(() => this._apChanged(rec)), rec);
            }
        }
        this._acs.set(ac, rec);
    }

    _untrackAc(ac, removed) {
        const rec = this._acs?.get(ac);
        if (!rec)
            return;
        ac.disconnectObject(rec);
        rec.dev?.disconnectObject(rec);
        this._acs.delete(ac);
        if (removed && rec.active) {
            rec.active = false;
            this._disconnected(rec);
        }
    }

    _acState(ac) {
        const rec = this._acs?.get(ac);
        if (!rec)
            return;
        const S = this._NM.ActiveConnectionState;
        const st = ac.get_state();
        if (st === S.ACTIVATED && !rec.active) {
            rec.active = true;
            rec.name = ac.get_id() ?? rec.name;
            rec.bssid = rec.dev?.get_active_access_point()?.get_bssid() ?? null;
            this._connected(rec);
        } else if ((st === S.DEACTIVATING || st === S.DEACTIVATED) && rec.active) {
            rec.active = false;
            this._disconnected(rec);
        }
    }

    _settling() {
        return this._now() - (this._netSince ?? 0) < SETTLE_MS;
    }

    _connected(rec) {
        if (this._settling())
            return;
        if (rec.kind === 'vpn') {
            this._play('vpn-on', rec.name);
            return;
        }
        const pending = this._wifiPending;
        if (pending) {
            // Wi-Fi went down a moment ago and now this one is up: that's
            // a switch from one network to another (or a quick reconnect).
            this._cancelLater(pending.timer);
            this._wifiPending = null;
            this._play(pending.name !== rec.name ? 'wifi-switch' : 'wifi-on', rec.name);
        } else {
            this._play('wifi-on', rec.name);
        }
    }

    _disconnected(rec) {
        if (this._settling())
            return;
        if (rec.kind === 'vpn') {
            this._play('vpn-off', rec.name);
            return;
        }
        // Wait a little: if another network is connecting, this is a switch.
        if (this._wifiPending)
            this._cancelLater(this._wifiPending.timer);
        const pending = {name: rec.name, since: this._now(), timer: 0};
        const check = () => {
            if (this._wifiPending !== pending)
                return;
            const S = this._NM.ActiveConnectionState;
            const connecting = [...(this._acs?.entries() ?? [])].some(
                ([ac, r]) => r.kind === 'wifi' && ac.get_state() === S.ACTIVATING);
            if (connecting && this._now() - pending.since < SWITCH_MAX_MS) {
                pending.timer = this._later(1000, check);
                return;
            }
            this._wifiPending = null;
            this._play('wifi-off', pending.name);
        };
        pending.timer = this._later(SWITCH_WAIT_MS, check);
        this._wifiPending = pending;
    }

    // Same network, different access point (moving between routers of a
    // mesh, or a building's Wi-Fi).
    _apChanged(rec) {
        const bssid = rec.dev?.get_active_access_point()?.get_bssid() ?? null;
        const prev = rec.bssid;
        if (bssid)
            rec.bssid = bssid;
        if (!rec.active || !bssid || !prev || bssid === prev || this._settling())
            return;
        const now = this._now();
        if (now - (this._lastRoam ?? -1e9) < ROAM_MS)
            return;
        this._lastRoam = now;
        this._play('wifi-switch', rec.name);
    }

    // ---------- Bluetooth ----------

    _startBluetooth() {
        if (this._btDevs || this._btStarting)
            return;
        this._btStarting = true;
        const gen = ++this._btGen;
        import('gi://GnomeBluetooth?version=3.0').then(({default: GnomeBluetooth}) => {
            if (gen !== this._btGen)
                return;
            this._btStarting = false;
            this._safe(() => this._btReady(GnomeBluetooth));
        }).catch(e => {
            console.warn(`System FX: Bluetooth not available (${e})`);
            this._btStarting = false;
        });
    }

    _btReady(GnomeBluetooth) {
        this._bt = new GnomeBluetooth.Client();
        this._btDevs = new Map();       // object path -> {dev, connected}
        this._btSince = this._now();
        const store = this._bt.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            this._trackBt(store.get_item(i));
        this._bt.connectObject(
            'device-added', (_c, dev) => this._safe(() => this._trackBt(dev)),
            'device-removed', (_c, path) => this._safe(() => this._untrackBt(path)),
            this);
    }

    _stopBluetooth() {
        this._btGen++;
        this._btStarting = false;
        for (const path of [...(this._btDevs?.keys() ?? [])])
            this._untrackBt(path);
        this._btDevs = null;
        this._bt?.disconnectObject(this);
        this._bt = null;
    }

    _trackBt(dev) {
        const path = dev?.get_object_path?.();
        if (!path || !this._btDevs || this._btDevs.has(path))
            return;
        const rec = {dev, connected: !!dev.connected};
        dev.connectObject('notify::connected', () => this._safe(() => {
            const now = !!dev.connected;
            if (now === rec.connected)
                return;
            rec.connected = now;
            if (this._now() - this._btSince < SETTLE_MS)
                return;
            this._play(now ? 'bt-on' : 'bt-off', dev.alias || dev.name || '');
        }), rec);
        this._btDevs.set(path, rec);
    }

    _untrackBt(path) {
        const rec = this._btDevs?.get(path);
        if (!rec)
            return;
        rec.dev.disconnectObject(rec);
        this._btDevs.delete(path);
    }

    // ---------- Volume and microphone ----------

    _startSound() {
        if (this._mixer)
            return;
        this._mixer = getMixerControl();    // GNOME's own, shared: never close it
        const rebind = () => this._safe(() => {
            this._bindStream('sink');
            this._bindStream('source');
        });
        this._mixer.connectObject(
            'default-sink-changed', () => this._safe(() => this._bindStream('sink')),
            'default-source-changed', () => this._safe(() => this._bindStream('source')),
            'state-changed', rebind,
            this);
        rebind();
    }

    _stopSound() {
        if (!this._mixer)
            return;
        this._mixer.disconnectObject(this);
        for (const kind of ['sink', 'source']) {
            this._streams[kind]?.stream.disconnectObject(this._streams[kind]);
            this._streams[kind] = null;
        }
        this._mixer = null;
    }

    _bindStream(kind) {
        const old = this._streams[kind];
        const stream = kind === 'sink' ? this._mixer.get_default_sink() : this._mixer.get_default_source();
        if (old?.stream === stream)
            return;
        old?.stream.disconnectObject(old);
        this._streams[kind] = null;
        if (!stream)
            return;
        // A different device (headphones plugged in...): take its volume as
        // the starting point instead of animating the jump.
        const rec = {stream, volume: stream.volume, muted: stream.is_muted, since: this._now()};
        stream.connectObject(
            'notify::volume', () => this._safe(() => this._streamChanged(kind)),
            'notify::is-muted', () => this._safe(() => this._streamChanged(kind)),
            rec);
        this._streams[kind] = rec;
    }

    _streamChanged(kind) {
        const rec = this._streams[kind];
        if (!rec)
            return;
        const {stream} = rec;
        const settling = this._now() - rec.since < 600;
        if (stream.is_muted !== rec.muted) {
            rec.muted = stream.is_muted;
            rec.volume = stream.volume;
            if (!settling) {
                if (kind === 'sink')
                    this._play(rec.muted ? 'mute' : 'unmute');
                else
                    this._play(rec.muted ? 'mic-mute' : 'mic-unmute');
            }
            return;
        }
        const prev = rec.volume, vol = stream.volume;
        rec.volume = vol;
        if (kind !== 'sink' || vol === prev || settling)
            return;
        const max = this._mixer.get_vol_max_norm();
        let name;
        if (vol >= max && prev < max)
            name = 'vol-max';
        else if (vol <= 0 && prev > 0)
            name = 'vol-zero';
        else
            name = vol > prev ? 'vol-up' : 'vol-down';
        this._play(name);
    }

    // ---------- Lock screen ----------

    // metadata.json lists "unlock-dialog" in session-modes, so GNOME keeps
    // this extension running while the screen is locked (other Lumora
    // extensions are switched off there, as usual).
    _startLock() {
        const shield = Main.screenShield;
        if (this._lockWatch || !shield)
            return;
        this._lockWatch = true;
        this._wasLocked = !!shield.locked;
        shield.connectObject('locked-changed', () => this._safe(() => {
            const locked = !!shield.locked;
            if (locked === this._wasLocked)
                return;
            this._wasLocked = locked;
            this._play(locked ? 'lock' : 'unlock');
        }), this);
    }

    _stopLock() {
        if (!this._lockWatch)
            return;
        Main.screenShield?.disconnectObject(this);
        this._lockWatch = false;
    }

    // ---------- Previews from the Lumora app (ignore the on/off switches) ----------

    _onPreview(line) {
        const m = /^preview ([\w-]+)$/.exec(line.trim());
        if (m && SCENES[m[1]])
            this._show(m[1], PREVIEW_NAMES[m[1]] ?? null);
    }
}
