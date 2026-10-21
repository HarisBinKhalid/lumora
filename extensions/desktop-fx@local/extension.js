import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {LiveConfig, listen} from './config.js';
import {Unredirect} from './unredirect.js';
import {
    place, ripple, RIPPLE_STYLES, slam, crossEntry, crossExit, makeLowBattery, batteryCharged,
    clipCopy, clipCut,
} from './scenes.js';

// Defaults; the Lumora app changes these live via ~/.config/lumora/config.json
const DEFAULTS = {
    trail: true,
    trailStyle: 'comet',          // comet, rainbow, sparkles, stars
    trailSize: 1,
    ripples: true,
    rippleStyle: 'ripple',        // ripple, shockwave, sparks, confetti
    rippleColor: '80, 170, 255',
    rippleSize: 1,
    windowSlam: true,             // dust + shockwave when a window snaps to an edge
    windowCross: true,            // light gate when a dragged window changes monitor
    batteryFire: true,            // the low battery warning (kept its old name)
    batteryLevel: 10,             // percent
    batteryKeepBurning: true,     // false = a short warning at each percent lost
    batteryFull: true,            // animation when charged up to batteryFullLevel
    batteryFullLevel: 100,
    clipboard: ['copy', 'cut'],
    combo: true,
    comboMin: 10,                 // keys before the counter shows
    comboCorner: 'bottom-right',
};
const TRAIL_STYLES = ['comet', 'rainbow', 'sparkles', 'stars'];
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const PREVIEW_PORT = 47323;       // the Lumora app sends previews here
const TICK_MS = 16;               // pointer polling (~60 fps), only while needed
const COMBO_GAP_MS = 1500;        // a pause longer than this ends the combo
const MAX_RIPPLES = 12;
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

// ---- Safety switches ----
// Each group does NOTHING unless its file exists. /run/user/<id>/ is wiped on
// every restart, so the effects are always OFF after a reboot.
//   Turn on:  touch "$XDG_RUNTIME_DIR/desktop-fx-cursor-on"
//   Turn off: rm "$XDG_RUNTIME_DIR/desktop-fx-cursor-on"
const FLAGS = {
    cursor: 'desktop-fx-cursor-on',     // trail, click ripples
    windows: 'desktop-fx-windows-on',   // window slam, crossing screens
    desktop: 'desktop-fx-desktop-on',   // battery, typing combo, clipboard
};

const rand = (a, b) => a + Math.random() * (b - a);

// Colours used in CSS: fixed lists, never config values.
const TRAIL_GLOW = '80, 180, 255';
const RAINBOW = ['255, 70, 90', '255, 150, 50', '255, 220, 60', '90, 230, 120', '70, 190, 255', '150, 110, 255'];
const STAR_COLORS = ['#ffe066', '#ffffff', '#9fdcff', '#ffb3e6'];
const COMBO_TIERS = [ // [from, text colour, glow colour]
    [0, '#ffffff', '120, 200, 255'],
    [25, '#7dffb0', '60, 220, 120'],
    [50, '#ffe066', '255, 200, 40'],
    [100, '#ff9a3c', '255, 120, 30'],
    [200, '#ff4d8d', '255, 40, 120'],
];

export default class DesktopFxExtension extends Extension {
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
        this._on = {cursor: false, windows: false, desktop: false};
        this._actors = new Set();      // top-level actors we added to the stage
        this._unredirect = new Unredirect();
        this._timelines = new Set();
        this._timeouts = new Set();
        this._tickId = 0;
        this._idleWatch = 0;
        this._grabSignals = false;
        this._buttons = 0;
        this._grab = null;
        this._follows = [];            // overlays that follow a window
        this._ripples = 0;
        this._trail = null;
        this._low = null;
        this._clipWatch = false;
        this._combo = null;
        this._battery = null;
        this._previewTrailUntil = 0;
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._cfg = new LiveConfig('desktop', DEFAULTS, () => this._sync());
        try {
            this._preview = listen(PREVIEW_PORT, line => this._onPreview(line));
        } catch (e) {
            console.warn(`Desktop FX: preview listener unavailable: ${e}`);
            this._preview = null;
        }
        this._watchBattery();

        // Check the on/off switch once a second.
        this._sync();
        this._flagTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._markRunning(false);
        if (this._flagTimerId) {
            GLib.source_remove(this._flagTimerId);
            this._flagTimerId = 0;
        }
        this._on = {cursor: false, windows: false, desktop: false};
        this._stopTicker();
        this._setIdleWatch(false);
        this._setGrabSignals(false);
        this._stopLow(true);
        this._setClipboardWatch(false);
        this._endCombo(true);
        this._clearTrail();
        if (this._preview) {
            this._preview.stop();
            this._preview.close();
            this._preview = null;
        }
        this._batteryCancel?.cancel();
        this._batteryCancel = null;
        this._upower?.disconnectObject(this);
        this._upower = null;
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
        this._unredirect.release();
        this._follows = [];
        this._grab = null;
        this._cfg?.destroy();
        this._cfg = null;
        this._ifaceSettings = null;
    }

    // ---------- Switching parts on and off ----------

    _sync() {
        for (const k in this._flagPaths)
            this._on[k] = GLib.file_test(this._flagPaths[k], GLib.FileTest.EXISTS);
        const on = this._on, cfg = this._cfg.values;
        this._setIdleWatch((on.cursor && cfg.ripples) || (on.desktop && cfg.combo));
        this._setGrabSignals(on.windows && (cfg.windowSlam || cfg.windowCross));
        this._setClipboardWatch(on.desktop && cfg.clipboard.length > 0);
        if (this._wantTicker())
            this._startTicker();
        if (!on.cursor || !cfg.trail)
            this._clearTrail();
        if (!on.desktop || !cfg.combo)
            this._endCombo(true);
        this._batteryCheck();
    }

    _locked() {
        return Main.sessionMode.isLocked;
    }

    // ---------- Helpers ----------

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            try {
                fn();
            } catch (e) {
                console.error(`Desktop FX: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _add(actor) {
        Main.uiGroup.add_child(actor);
        this._actors.add(actor);
        this._updateUnredirect();
        return actor;
    }

    _remove(actor) {
        if (!this._actors.has(actor))
            return;
        this._actors.delete(actor);
        this._updateUnredirect();
        actor.destroy();
    }

    // Keep GNOME compositing while anything of ours is visible (see
    // unredirect.js). A resting cursor trail shows nothing, so it doesn't count.
    _updateUnredirect() {
        let n = this._actors.size;
        if (this._trail?.quiet && this._actors.has(this._trail.layer))
            n--;
        this._unredirect.set(n > 0);
    }

    // An empty click-through container covering every monitor; children
    // are placed in screen coordinates.
    _fullStage() {
        return new St.Widget({
            reactive: false, x: 0, y: 0, width: global.stage.width, height: global.stage.height,
        });
    }

    // Effects near the cursor match the cursor size (designed for 24px).
    _cursorScale() {
        let cursor = 24;
        try {
            cursor = this._ifaceSettings.get_int('cursor-size') || 24;
        } catch (e) {}
        return cursor / 24;
    }

    // Window effects are designed for a 1080p screen.
    _monScale(mon) {
        return Math.max(0.5, Math.min(3, mon.height / 1080));
    }

    _monitorAt(x, y) {
        for (const m of Main.layoutManager.monitors) {
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return m;
        }
        return Main.layoutManager.primaryMonitor;
    }

    // Validated "r, g, b" (it goes into CSS, so never trust it blindly).
    _rippleRgb() {
        const m = /^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/.exec(this._cfg.values.rippleColor);
        if (!m || [m[1], m[2], m[3]].some(v => +v > 255))
            return [80, 170, 255];
        return [+m[1], +m[2], +m[3]];
    }

    // Plays a placed scene (from scenes.js) with its anchor at (x, y). With
    // `mon`, it is clipped to that monitor so it can't spill onto a neighbour.
    _playPlaced(spec, x, y, sc, mon = null, onDone = null) {
        const area = new St.DrawingArea({
            width: Math.max(1, Math.ceil(spec.w * sc)), height: Math.max(1, Math.ceil(spec.h * sc)),
            reactive: false,
        });
        const left = Math.round(x - spec.ox * sc), top = Math.round(y - spec.oy * sc);
        let root = area;
        if (mon) {
            root = new St.Widget({
                x: mon.x, y: mon.y, width: mon.width, height: mon.height,
                clip_to_allocation: true, reactive: false,
            });
            root.add_child(area);
            area.set_position(left - mon.x, top - mon.y);
        } else {
            area.set_position(left, top);
        }
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
                    console.error(`Desktop FX draw error: ${e}`);
                }
            } finally {
                cr.$dispose();
            }
        });
        this._add(root);
        const tl = new Clutter.Timeline({actor: area, duration: spec.duration});
        this._timelines.add(tl);
        tl.connect('new-frame', () => {
            t = tl.get_progress();
            area.queue_repaint();
        });
        tl.connect('completed', () => {
            this._timelines.delete(tl);
            this._remove(root);
            onDone?.();
        });
        area.queue_repaint();
        tl.start();
    }

    // ---------- The pointer ticker (trail, clicks, dragged windows) ----------

    _wantTicker() {
        const cfg = this._cfg.values;
        return (this._on.cursor && (cfg.trail || cfg.ripples)) || this._grab !== null ||
            this._follows.length > 0 || this._previewTrailUntil > 0;
    }

    _startTicker() {
        if (this._tickId)
            return;
        this._lastTick = GLib.get_monotonic_time() / 1000;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            try {
                this._tick();
            } catch (e) {
                // Something went wrong: stop quietly instead of misbehaving.
                console.error(`Desktop FX stopped tracking after an error: ${e}`);
                this._tickId = 0;
                this._clearTrail();
                return GLib.SOURCE_REMOVE;
            }
            if (this._wantTicker())
                return GLib.SOURCE_CONTINUE;
            this._tickId = 0;
            this._clearTrail();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTicker() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1000;
        const dt = Math.min(0.05, (now - this._lastTick) / 1000);
        this._lastTick = now;
        const cfg = this._cfg.values;
        let [x, y, mods] = global.get_pointer();

        if (!this._locked())
            this._checkButtons(x, y, mods);

        // A preview draws a figure of eight instead of following the mouse.
        let trailOn = this._on.cursor && cfg.trail && !this._locked();
        let style = TRAIL_STYLES.includes(cfg.trailStyle) ? cfg.trailStyle : 'comet';
        if (this._previewTrailUntil) {
            if (now > this._previewTrailUntil) {
                this._previewTrailUntil = 0;
                this._clearTrail();
            } else {
                const mon = Main.layoutManager.primaryMonitor;
                const k = (now - this._previewTrailStart) / 1000 * 2.6;
                x = mon.x + mon.width / 2 + Math.sin(k) * mon.width * 0.22;
                y = mon.y + mon.height / 2 + Math.sin(k * 2) * mon.height * 0.16;
                trailOn = true;
                style = this._previewTrailStyle ?? style;
            }
        }
        if (trailOn)
            this._trailStep(x, y, now, dt, style);
        else
            this._clearTrail();         // e.g. the screen just locked

        if (this._grab)
            this._grabStep();
        this._followStep(now);
    }

    // ---------- Clicks ----------

    // Called from the ticker and the idle watch; fires on a newly pressed button.
    _checkButtons(x, y, mods) {
        const b = mods & BUTTONS;
        const pressed = b & ~this._buttons;
        this._buttons = b;
        if (pressed && this._on.cursor && this._cfg.values.ripples)
            this._ripple(x, y);
    }

    _ripple(x, y, style = null) {
        if (this._ripples >= MAX_RIPPLES)
            return;
        const cfg = this._cfg.values;
        style = style ?? (RIPPLE_STYLES.includes(cfg.rippleStyle) ? cfg.rippleStyle : 'ripple');
        const sc = this._cursorScale() * Math.max(0.3, Math.min(4, cfg.rippleSize));
        const c = this._rippleRgb().map(v => v / 255);
        this._ripples++;
        this._playPlaced(ripple(style, c), x, y, sc, null, () => this._ripples--);
    }

    // ---------- Idle watch: tells us about every key press ----------

    // GNOME's idle monitor resets on every input event, keyboard included,
    // even when an app has focus. If the pointer didn't move and no button
    // changed, the event came from the keyboard. Nothing about WHICH key is
    // ever seen; we only count them.
    _setIdleWatch(on) {
        if (on === !!this._idleWatch)
            return;
        const monitor = global.backend.get_core_idle_monitor();
        if (on) {
            this._lastInput = null;
            this._idleWatch = monitor.add_idle_watch(1, () => {
                try {
                    this._onInput();
                } catch (e) {
                    console.error(`Desktop FX input error: ${e}`);
                }
            });
        } else {
            monitor.remove_watch(this._idleWatch);
            this._idleWatch = 0;
        }
    }

    _onInput() {
        if (!(this._on.cursor || this._on.desktop) || this._locked())
            return;
        const [x, y, mods] = global.get_pointer();
        const key = `${x},${y},${mods & BUTTONS}`;
        const same = key === this._lastInput;
        this._lastInput = key;
        this._checkButtons(x, y, mods);
        if (same && this._on.desktop && this._cfg.values.combo)
            this._keyEvent();
    }

    // ---------- Cursor trail ----------

    _clearTrail() {
        if (!this._trail)
            return;
        this._remove(this._trail.layer);
        this._trail = null;
    }

    _ensureTrail(style) {
        const sc = this._cursorScale() * Math.max(0.3, Math.min(4, this._cfg.values.trailSize));
        if (this._trail && this._trail.style === style && this._trail.sc === sc)
            return this._trail;
        this._clearTrail();
        const layer = this._add(this._fullStage());
        const pool = [];
        const ribbon = style === 'comet' || style === 'rainbow';
        const n = ribbon ? 40 : 60;
        for (let i = 0; i < n; i++) {
            let a;
            if (style === 'stars') {
                const col = STAR_COLORS[i % STAR_COLORS.length];
                a = new St.Label({
                    text: i % 3 ? '✦' : '★', reactive: false, opacity: 0,
                    style: `color: ${col}; font-size: ${Math.round(13 * sc)}px;` +
                           `text-shadow: 0 0 ${Math.round(6 * sc)}px ${col};`,
                });
            } else {
                const d = Math.max(3, Math.round((ribbon ? 11 : 5) * sc));
                const glow = style === 'rainbow' ? RAINBOW[i % RAINBOW.length]
                    : style === 'sparkles' ? (i % 3 ? '255, 220, 120' : '255, 255, 255') : TRAIL_GLOW;
                a = new St.Widget({
                    reactive: false, opacity: 0, width: d, height: d,
                    style: `background-color: ${style === 'rainbow' ? `rgba(${glow}, 0.95)` : 'rgba(255, 255, 255, 0.95)'};` +
                           `border-radius: ${d / 2}px;` +
                           `box-shadow: 0 0 ${Math.round(8 * sc)}px ${Math.round(3 * sc)}px rgba(${glow}, 0.8);`,
                });
            }
            a.set_pivot_point(0.5, 0.5);
            layer.add_child(a);
            pool.push({actor: a, live: false});
        }
        this._trail = {layer, pool, style, sc, ribbon, pts: [], parts: [], lastX: null, lastY: null};
        return this._trail;
    }

    _trailStep(x, y, now, dt, style) {
        const cfg = this._cfg.values;
        const tr = this._ensureTrail(style);
        const moved = tr.lastX === null ? 0 : Math.hypot(x - tr.lastX, y - tr.lastY);
        // Mouse resting and nothing left on screen: no work this frame.
        if (moved <= 0.5 && tr.quiet)
            return;
        if (tr.ribbon) {
            // Keep recent positions; dots are laid out along that path.
            if (moved > 0.5 || !tr.pts.length)
                tr.pts.push({x, y, t: now});
            const life = 260 * Math.max(0.5, Math.min(3, cfg.trailSize));
            while (tr.pts.length && now - tr.pts[0].t > life)
                tr.pts.shift();
            this._layoutRibbon(tr, now, life);
            tr.quiet = tr.pts.length < 2;
            this._updateUnredirect();
        } else {
            // Particles thrown off as the cursor moves.
            let spawn = Math.min(4, Math.floor(moved / 9));
            for (const p of tr.pool) {
                if (spawn <= 0)
                    break;
                if (p.live)
                    continue;
                spawn--;
                const k = Math.random();
                Object.assign(p, {
                    live: true, born: now, life: rand(450, 800),
                    x: tr.lastX + (x - tr.lastX) * k + rand(-4, 4) * tr.sc,
                    y: tr.lastY + (y - tr.lastY) * k + rand(-4, 4) * tr.sc,
                    vx: rand(-30, 30) * tr.sc, vy: rand(-20, 30) * tr.sc,
                    spin: rand(-200, 200), size: rand(0.6, 1.2),
                });
            }
            for (const p of tr.pool) {
                if (!p.live)
                    continue;
                const age = (now - p.born) / p.life;
                if (age >= 1) {
                    p.live = false;
                    p.actor.opacity = 0;
                    continue;
                }
                p.vy += 70 * tr.sc * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                const a = p.actor;
                a.set_position(Math.round(p.x - a.width / 2), Math.round(p.y - a.height / 2));
                const twinkle = 0.65 + 0.35 * Math.sin(age * 25 + p.spin);
                a.opacity = Math.round(255 * (1 - age) * twinkle);
                a.scale_x = a.scale_y = p.size * (1 - age * 0.5);
                if (style === 'stars')
                    a.rotation_angle_z = p.spin * age;
            }
            tr.quiet = !tr.pool.some(p => p.live);
            this._updateUnredirect();
        }
        tr.lastX = x;
        tr.lastY = y;
    }

    // Spreads the comet's dots evenly along the recent path, head first.
    _layoutRibbon(tr, now, life) {
        const pts = tr.pts;
        const spacing = 6 * tr.sc;
        let i = pts.length - 1, used = 0;
        let seg = 0, segStart = 0; // distance along the path from the head
        for (const p of tr.pool) {
            const want = used * spacing;
            // Walk back along the path until we reach `want` distance.
            while (i > 0) {
                seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
                if (segStart + seg >= want)
                    break;
                segStart += seg;
                i--;
            }
            if (i <= 0 || pts.length < 2) {
                p.actor.opacity = 0;
                continue;
            }
            const k = seg > 0 ? (want - segStart) / seg : 0;
            const px = pts[i].x + (pts[i - 1].x - pts[i].x) * k;
            const py = pts[i].y + (pts[i - 1].y - pts[i].y) * k;
            const age = Math.min(1, (now - pts[i].t) / life);
            const along = used / tr.pool.length;
            const a = p.actor;
            a.set_position(Math.round(px - a.width / 2), Math.round(py - a.height / 2));
            a.scale_x = a.scale_y = Math.max(0.15, 1 - along);
            a.opacity = Math.round(230 * (1 - along) * (1 - age));
            used++;
        }
    }

    // ---------- Dragging windows: slams and monitor crossings ----------

    _setGrabSignals(on) {
        if (on === this._grabSignals)
            return;
        this._grabSignals = on;
        if (on) {
            global.display.connectObject(
                'grab-op-begin', (_d, win, op) => this._safe(() => this._grabBegin(win, op)),
                'grab-op-end', (_d, win, op) => this._safe(() => this._grabEnd(win, op)),
                this);
        } else {
            global.display.disconnectObject(this);
            this._grab = null;
        }
    }

    _safe(fn) {
        try {
            fn();
        } catch (e) {
            console.error(`Desktop FX: ${e}`);
        }
    }

    _isMoveOp(op) {
        const resize = Meta.GrabOp.RESIZING_N | Meta.GrabOp.RESIZING_S |
            Meta.GrabOp.RESIZING_E | Meta.GrabOp.RESIZING_W;
        const dirBits = resize & ~Meta.GrabOp.MOVING;
        return (op & Meta.GrabOp.MOVING) !== 0 && (op & dirBits) === 0;
    }

    _grabBegin(win, op) {
        if (!win || !this._isMoveOp(op))
            return;
        const r = win.get_frame_rect();
        this._grab = {win, rect: {x: r.x, y: r.y, width: r.width, height: r.height}, mon: win.get_monitor()};
        this._startTicker();
    }

    _grabEnd(win) {
        const g = this._grab;
        this._grab = null;
        if (!g || g.win !== win || !this._on.windows || !this._cfg.values.windowSlam)
            return;
        // Snapping happens just after the drop (sometimes by another
        // extension), so look twice.
        let done = false;
        const check = () => {
            if (done || !win.get_compositor_private())
                return;
            const side = this._snapSide(win, g.rect);
            if (side) {
                done = true;
                this._slam(win, side);
            }
        };
        this._later(90, check);
        this._later(380, check);
    }

    // 'left' / 'right' / 'top' when the window was just snapped or
    // maximised, else null. Judged from its size and place on the screen.
    _snapSide(win, before) {
        const r = win.get_frame_rect();
        const mon = win.get_monitor();
        if (mon < 0)
            return null;
        // A window that was only moved keeps its size; a snap changes it.
        if (Math.abs(r.width - before.width) < 12 && Math.abs(r.height - before.height) < 12)
            return null;
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon);
        const T = 12;
        const near = (a, b) => Math.abs(a - b) <= T;
        const left = near(r.x, wa.x), right = near(r.x + r.width, wa.x + wa.width);
        const top = near(r.y, wa.y), bottom = near(r.y + r.height, wa.y + wa.height);
        if (left && right && top && bottom)
            return 'top';                     // maximised
        if (top && bottom)
            return left ? 'left' : right ? 'right' : null;
        // Quarter tiles (e.g. Ubuntu's tiling assistant).
        if ((top || bottom) && (left || right) && r.width < wa.width * 0.75 && r.height < wa.height * 0.75)
            return left ? 'left' : 'right';
        return null;
    }

    _slam(win, side, rectOverride = null) {
        const r = rectOverride ?? win.get_frame_rect();
        const monIdx = win ? win.get_monitor() : Main.layoutManager.primaryIndex;
        const mon = Main.layoutManager.monitors[monIdx] ?? Main.layoutManager.primaryMonitor;
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index);
        const sc = this._monScale(mon);
        let x, y, dir, len;
        if (side === 'top') {
            x = r.x + r.width / 2; y = wa.y; dir = [0, 1]; len = r.width;
        } else if (side === 'left') {
            x = wa.x; y = r.y + r.height / 2; dir = [1, 0]; len = r.height;
        } else {
            x = wa.x + wa.width - 1; y = r.y + r.height / 2; dir = [-1, 0]; len = r.height;
        }
        this._playPlaced(place(slam(len / sc), dir), x, y, sc, mon);
    }

    // While a window is being dragged: did it just move to another monitor?
    _grabStep() {
        const g = this._grab;
        if (!g.win.get_compositor_private()) {
            this._grab = null;
            return;
        }
        const m = g.win.get_monitor();
        if (m >= 0 && m !== g.mon) {
            const old = g.mon;
            g.mon = m;
            if (this._on.windows && this._cfg.values.windowCross && !this._locked())
                this._windowCross(g.win, old, m);
        }
    }

    _windowCross(win, oldIdx, newIdx, rect = null) {
        const mons = Main.layoutManager.monitors;
        const oldMon = mons[oldIdx], newMon = mons[newIdx];
        if (!oldMon || !newMon)
            return;
        const r = rect ?? win.get_frame_rect();
        let dir;
        if (newMon.x >= oldMon.x + oldMon.width) dir = [1, 0];
        else if (newMon.x + newMon.width <= oldMon.x) dir = [-1, 0];
        else if (newMon.y >= oldMon.y + oldMon.height) dir = [0, 1];
        else dir = [0, -1];
        // The stretch of the shared edge that the window covers.
        let exit, entry, len;
        if (dir[0] !== 0) {
            const X = dir[0] > 0 ? oldMon.x + oldMon.width : oldMon.x;
            const lo = Math.max(r.y, oldMon.y, newMon.y);
            const hi = Math.min(r.y + r.height, oldMon.y + oldMon.height, newMon.y + newMon.height);
            len = hi - lo;
            const Y = Math.round((lo + hi) / 2);
            exit = [dir[0] > 0 ? X - 1 : X, Y];
            entry = [dir[0] > 0 ? X : X - 1, Y];
        } else {
            const Y = dir[1] > 0 ? oldMon.y + oldMon.height : oldMon.y;
            const lo = Math.max(r.x, oldMon.x, newMon.x);
            const hi = Math.min(r.x + r.width, oldMon.x + oldMon.width, newMon.x + newMon.width);
            len = hi - lo;
            const X = Math.round((lo + hi) / 2);
            exit = [X, dir[1] > 0 ? Y - 1 : Y];
            entry = [X, dir[1] > 0 ? Y : Y - 1];
        }
        if (len < 40)
            return;
        const scOld = this._monScale(oldMon), scNew = this._monScale(newMon);
        this._playPlaced(place(crossExit(len / scOld), dir), exit[0], exit[1], scOld, oldMon);
        this._playPlaced(place(crossEntry(len / scNew), dir), entry[0], entry[1], scNew, newMon);
        this._materialize(win, dir, rect);
    }

    // A glowing frame and a light beam sweeping over the window that just
    // arrived, following it while it's still being dragged.
    _materialize(win, dir, rect = null) {
        const horizontal = dir[0] !== 0;
        const box = new St.Widget({reactive: false, clip_to_allocation: true});
        const frame = new St.Widget({
            reactive: false,
            style: 'border: 3px solid rgba(120, 215, 255, 0.95); border-radius: 12px;' +
                   'background-color: rgba(80, 180, 255, 0.10);' +
                   'box-shadow: 0 0 26px 6px rgba(80, 180, 255, 0.55);',
        });
        // A beam made of two gradients back to back (St gradients have two stops).
        const grad = (a, b) => new St.Widget({
            reactive: false,
            style: `background-gradient-direction: ${horizontal ? 'horizontal' : 'vertical'};` +
                   `background-gradient-start: rgba(140, 225, 255, ${a});` +
                   `background-gradient-end: rgba(140, 225, 255, ${b});`,
        });
        const beamA = grad(0, 0.55), beamB = grad(0.55, 0);
        box.add_child(beamA);
        box.add_child(beamB);
        const root = this._add(this._fullStage());
        root.add_child(box);
        root.add_child(frame);
        this._follows.push({
            win, rect, dir, root, box, frame, beamA, beamB,
            start: GLib.get_monotonic_time() / 1000, duration: 750,
        });
        this._startTicker();
    }

    _followStep(now) {
        if (!this._follows.length)
            return;
        const keep = [];
        for (const f of this._follows) {
            const k = (now - f.start) / f.duration;
            const alive = f.rect || f.win.get_compositor_private();
            if (k >= 1 || !alive) {
                this._remove(f.root);
                continue;
            }
            keep.push(f);
            const r = f.rect ?? f.win.get_frame_rect();
            const pad = 2;
            f.frame.set_position(r.x - pad, r.y - pad);
            f.frame.set_size(r.width + pad * 2, r.height + pad * 2);
            f.box.set_position(r.x, r.y);
            f.box.set_size(r.width, r.height);
            // Beam travels across the window in the direction of travel.
            const horizontal = f.dir[0] !== 0;
            const span = horizontal ? r.width : r.height;
            const bw = Math.max(60, Math.min(220, span * 0.25));
            const sweep = k < 0.7 ? k / 0.7 : 1;
            let pos = -2 * bw + (span + 2 * bw) * sweep;
            if (f.dir[0] < 0 || f.dir[1] < 0)
                pos = span - pos - 2 * bw;
            if (horizontal) {
                f.beamA.set_position(pos, 0); f.beamA.set_size(bw, r.height);
                f.beamB.set_position(pos + bw, 0); f.beamB.set_size(bw, r.height);
            } else {
                f.beamA.set_position(0, pos); f.beamA.set_size(r.width, bw);
                f.beamB.set_position(0, pos + bw); f.beamB.set_size(r.width, bw);
            }
            f.root.opacity = Math.round(255 * Math.min(1, k * 8) * (k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1));
        }
        this._follows = keep;
    }

    // ---------- Battery: low warning and fully charged ----------

    _watchBattery() {
        this._batteryCancel = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', this._batteryCancel, (_o, res) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Desktop FX: no battery info (${e})`);
                    return;
                }
                this._upower.connectObject('g-properties-changed', () => this._batteryCheck(), this);
                this._batteryCheck();
            });
    }

    // {pct, state} of the battery, or null (no battery / no info yet).
    // UPower states: 1 charging, 2 discharging, 3 empty, 4 fully charged,
    // 5 pending charge, 6 pending discharge.
    _batteryState() {
        const p = this._upower;
        if (!p)
            return null;
        const get = name => p.get_cached_property(name)?.unpack();
        const pct = get('Percentage'), state = get('State');
        if (!get('IsPresent') || typeof pct !== 'number')
            return null;
        return {pct, state};
    }

    _batteryCheck() {
        if (!this._cfg)
            return;
        const cfg = this._cfg.values;
        const b = this._on.desktop ? this._batteryState() : null;
        this._checkCharged(b, cfg);

        // Low battery warning.
        const level = Math.max(1, Math.min(100, cfg.batteryLevel));
        const low = cfg.batteryFire && b && [2, 3, 6].includes(b.state) && b.pct <= level
            ? Math.floor(b.pct) : null;
        if (low === null) {
            this._lastLowPct = null;
            if (this._low && !this._low.preview)
                this._stopLow();
            return;
        }
        if (cfg.batteryKeepBurning) {
            this._startLow(0, low);
        } else if (this._lastLowPct === null || low < this._lastLowPct) {
            this._startLow(8000, low);  // a short warning at each percent lost
        }
        this._lastLowPct = low;
    }

    // Charged up to the chosen level while plugged in: play once, then wait
    // until it's unplugged or drops a few percent before it can play again.
    _checkCharged(b, cfg) {
        if (!b || !cfg.batteryFull) {
            this._chargedPrimed = false;   // look again from scratch next time
            return;
        }
        const level = Math.max(5, Math.min(100, cfg.batteryFullLevel));
        const plugged = [1, 4, 5].includes(b.state);
        const reached = plugged && (b.pct >= level - 0.5 || (b.state === 4 && level >= 95));
        if (!this._chargedPrimed) {
            // Just switched on (or started): no animation for a charge that
            // was already there.
            this._chargedPrimed = true;
            this._chargedShown = reached;
            return;
        }
        if (reached && !this._chargedShown) {
            this._chargedShown = true;
            this._playCharged();
        } else if (!plugged || b.pct < level - 3) {
            this._chargedShown = false;
        }
    }

    _playCharged() {
        const mon = Main.layoutManager.primaryMonitor;
        const sc = this._monScale(mon);
        // Same strip and battery as the low battery warning, in green.
        this._playPlaced(batteryCharged(mon.width / sc, 0.65), mon.x + mon.width / 2,
            mon.y + mon.height, sc, mon);
    }

    // ms = 0 shows the warning until stopped.
    _startLow(ms, pct, preview = false) {
        const mon = Main.layoutManager.primaryMonitor;
        if (this._low) {
            if (this._low.stopId) {
                GLib.source_remove(this._low.stopId);
                this._timeouts.delete(this._low.stopId);
                this._low.stopId = 0;
            }
            this._low.fadeTo = 1;
        } else {
            const sc = this._monScale(mon);
            const drawing = makeLowBattery(mon.width / sc);
            const area = new St.DrawingArea({
                x: mon.x, y: mon.y + mon.height - Math.ceil(drawing.h * sc),
                width: mon.width, height: Math.ceil(drawing.h * sc), reactive: false,
            });
            const low = {area, drawing, sc, strength: 0, fadeTo: 1, preview, stopId: 0, pct,
                start: GLib.get_monotonic_time() / 1e6};
            area.connect('repaint', a => {
                const cr = a.get_context();
                try {
                    cr.setOperator(Cairo.Operator.CLEAR);
                    cr.paint();
                    cr.setOperator(Cairo.Operator.OVER);
                    cr.scale(low.sc, low.sc);
                    low.drawing.draw(cr, GLib.get_monotonic_time() / 1e6 - low.start, low.strength, low.pct);
                } catch (e) {
                    if (!this._drawErrorLogged) {
                        this._drawErrorLogged = true;
                        console.error(`Desktop FX draw error: ${e}`);
                    }
                } finally {
                    cr.$dispose();
                }
            });
            this._add(area);
            // About 30 fps is plenty for a blinking warning.
            low.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                low.strength += Math.sign(low.fadeTo - low.strength) * 0.04;
                low.strength = Math.max(0, Math.min(1, low.strength));
                if (low.fadeTo === 0 && low.strength <= 0) {
                    low.timerId = 0;
                    this._stopLow(true);
                    return GLib.SOURCE_REMOVE;
                }
                if (!this._locked())
                    area.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            });
            this._low = low;
        }
        this._low.preview = preview;
        this._low.pct = pct;
        if (ms > 0)
            this._low.stopId = this._later(ms, () => {
                if (this._low)
                    this._low.stopId = 0;
                this._stopLow();
            });
    }

    _stopLow(instant = false) {
        const f = this._low;
        if (!f)
            return;
        if (!instant) {
            f.fadeTo = 0; // the timer removes it once faded out
            return;
        }
        if (f.timerId)
            GLib.source_remove(f.timerId);
        this._low = null;
        this._remove(f.area);
    }

    // ---------- Clipboard ----------

    // GNOME can't tell extensions which keys were pressed, so this follows
    // the clipboard instead: something new on it = copied (or cut; they look
    // the same), files marked "cut" by the Files app = cut. Pasting can't be
    // seen at all.
    _setClipboardWatch(on) {
        const selection = global.display.get_selection();
        if (on === !!this._clipWatch)
            return;
        this._clipWatch = on;
        if (on) {
            selection.connectObject('owner-changed', (_sel, type, source) =>
                this._safe(() => this._clipChanged(type, source)), this);
        } else {
            selection.disconnectObject(this);
        }
    }

    _clipChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source || !this._on.desktop || this._locked())
            return;
        // A memory source is GNOME itself (or an extension) setting the
        // clipboard, e.g. keeping it alive after the app that copied quit.
        if (source instanceof Meta.SelectionSourceMemory)
            return;
        const now = GLib.get_monotonic_time() / 1000;
        if (now - (this._lastClip ?? 0) < 250)
            return;
        this._lastClip = now;
        const kinds = this._cfg.values.clipboard;
        const FILES = 'x-special/gnome-copied-files';
        if ((source.get_mimetypes() ?? []).includes(FILES)) {
            St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, FILES, (_c, bytes) => {
                this._safe(() => {
                    const data = bytes?.get_data?.();
                    const text = data ? new TextDecoder().decode(data.slice(0, 8)) : '';
                    const kind = text.startsWith('cut') ? 'cut' : 'copy';
                    if (this._clipWatch && kinds.includes(kind))
                        this._clipAnim(kind);
                });
            });
        } else if (kinds.includes('copy')) {
            this._clipAnim('copy');
        }
    }

    _clipAnim(kind, at = null) {
        const [x, y] = at ?? global.get_pointer();
        this._playPlaced(kind === 'cut' ? clipCut() : clipCopy(), x, y, this._cursorScale());
    }

    // ---------- Typing combo ----------

    _keyEvent() {
        const now = GLib.get_monotonic_time() / 1000;
        if (this._combo && now - this._combo.last > COMBO_GAP_MS)
            this._endCombo();          // paused too long: start a new combo
        const c = this._combo ?? (this._combo = {halfKeys: 0, last: now, fast: 0, shown: 0, ui: null, endId: 0});
        const gap = now - c.last;
        c.last = now;
        // Touchpad scrolling sends events every few ms; typing never does.
        c.fast = gap < 10 ? c.fast + 1 : 0;
        if (c.fast >= 2)
            return;
        c.halfKeys++;                           // a key press and its release
        const combo = Math.floor(c.halfKeys / 2);
        if (combo !== c.shown && combo >= Math.max(2, this._cfg.values.comboMin))
            this._showCombo(combo);
        if (c.endId) {
            GLib.source_remove(c.endId);
            this._timeouts.delete(c.endId);
        }
        c.endId = this._later(COMBO_GAP_MS, () => {
            if (this._combo)
                this._combo.endId = 0;
            this._endCombo();
        });
    }

    _comboUi() {
        const c = this._combo;
        if (c.ui)
            return c.ui;
        const mon = Main.layoutManager.primaryMonitor;
        const sc = this._monScale(mon);
        const box = new St.BoxLayout({vertical: true, reactive: false, opacity: 0});
        const title = new St.Label({text: 'COMBO', x_align: Clutter.ActorAlign.CENTER});
        const count = new St.Label({text: '', x_align: Clutter.ActorAlign.CENTER});
        count.set_pivot_point(0.5, 0.5);
        box.add_child(title);
        box.add_child(count);
        box.set_pivot_point(0.5, 0.5);
        this._add(box);
        c.ui = {box, title, count, sc, mon, tier: -1};
        box.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return c.ui;
    }

    _placeCombo(ui) {
        const corner = CORNERS.includes(this._cfg.values.comboCorner) ? this._cfg.values.comboCorner : 'bottom-right';
        const wa = Main.layoutManager.getWorkAreaForMonitor(ui.mon.index);
        const [, w] = ui.box.get_preferred_width(-1);
        const [, h] = ui.box.get_preferred_height(w);
        const m = Math.round(36 * ui.sc);
        const x = corner.endsWith('right') ? wa.x + wa.width - w - m : wa.x + m;
        const y = corner.startsWith('bottom') ? wa.y + wa.height - h - m : wa.y + m;
        ui.box.set_position(Math.round(x), Math.round(y));
    }

    _showCombo(n) {
        const c = this._combo;
        c.shown = n;
        const ui = this._comboUi();
        let tier = 0;
        while (tier + 1 < COMBO_TIERS.length && n >= COMBO_TIERS[tier + 1][0])
            tier++;
        if (tier !== ui.tier) {
            ui.tier = tier;
            const [, color, glow] = COMBO_TIERS[tier];
            const big = Math.round((34 + tier * 5) * ui.sc);
            ui.title.style = `color: ${color}; font-weight: 800; font-size: ${Math.round(14 * ui.sc)}px;` +
                `letter-spacing: ${Math.round(4 * ui.sc)}px; text-shadow: 0 0 ${Math.round(8 * ui.sc)}px rgba(${glow}, 0.9);`;
            ui.count.style = `color: ${color}; font-weight: 900; font-style: italic; font-size: ${big}px;` +
                `text-shadow: 0 0 ${Math.round(14 * ui.sc)}px rgba(${glow}, 0.95);`;
        }
        const milestone = n % 25 === 0;
        ui.count.text = milestone ? `x${n}!` : `x${n}`;
        this._placeCombo(ui);
        // Bump and shake on every hit; harder as the combo grows.
        const power = Math.min(1, n / 120);
        ui.count.remove_all_transitions();
        ui.count.scale_x = ui.count.scale_y = milestone ? 1.8 : 1.25 + 0.2 * power;
        ui.count.rotation_angle_z = rand(-1, 1) * (3 + 9 * power);
        ui.count.ease({
            scale_x: 1, scale_y: 1, rotation_angle_z: 0,
            duration: milestone ? 380 : 140, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        ui.box.translation_x = rand(-1, 1) * 6 * power * ui.sc;
        ui.box.translation_y = rand(-1, 1) * 6 * power * ui.sc;
    }

    _endCombo(instant = false) {
        const c = this._combo;
        if (!c)
            return;
        this._combo = null;
        if (c.endId) {
            GLib.source_remove(c.endId);
            this._timeouts.delete(c.endId);
        }
        const ui = c.ui;
        if (!ui)
            return;
        if (instant) {
            this._remove(ui.box);
            return;
        }
        // Finale: pop, then float up and fade.
        ui.count.remove_all_transitions();
        ui.count.ease({scale_x: 1.4, scale_y: 1.4, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        ui.box.ease({
            translation_y: -40 * ui.sc, opacity: 0, delay: 350, duration: 500,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this._remove(ui.box),
        });
    }

    // ---------- Previews from the Lumora app (ignore the on/off switch) ----------

    _onPreview(line) {
        const [cmd, arg] = line.trim().split(/\s+/);
        const mon = Main.layoutManager.primaryMonitor;
        const cx = Math.round(mon.x + mon.width / 2), cy = Math.round(mon.y + mon.height / 2);
        if (cmd === 'trail') {
            this._previewTrailStyle = TRAIL_STYLES.includes(arg) ? arg : null;
            const now = GLib.get_monotonic_time() / 1000;
            this._previewTrailStart = now;
            this._previewTrailUntil = now + 2600;
            this._clearTrail();
            this._startTicker();
        } else if (cmd === 'ripple') {
            const style = RIPPLE_STYLES.includes(arg) ? arg : null;
            [[0, 0], [-90, 40], [80, -30]].forEach(([dx, dy], i) =>
                this._later(1 + i * 260, () => this._ripple(cx + dx, cy + dy, style)));
        } else if (cmd === 'slam') {
            const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index);
            const r = {x: wa.x, y: wa.y + wa.height * 0.15, width: wa.width / 2, height: wa.height * 0.7};
            this._slam(null, 'left', r);
            this._later(700, () => this._slam(null, 'top',
                {x: wa.x + wa.width * 0.2, y: wa.y, width: wa.width * 0.6, height: wa.height}));
        } else if (cmd === 'cross') {
            const r = {x: cx - 280, y: cy - 180, width: 560, height: 360};
            const sc = this._monScale(mon);
            this._playPlaced(place(crossExit(r.height / sc), [1, 0]), cx - 281, cy, sc, mon);
            this._playPlaced(place(crossEntry(r.height / sc), [1, 0]), cx - 280, cy, sc, mon);
            this._materialize(null, [1, 0], r);
        } else if (cmd === 'lowbattery') {
            this._startLow(8000, 7, true);
        } else if (cmd === 'charged') {
            this._playCharged();
        } else if (cmd === 'copy' || cmd === 'cut') {
            this._clipAnim(cmd, [cx, cy]);
        } else if (cmd === 'combo') {
            this._endCombo(true);
            this._combo = {halfKeys: 0, last: 0, fast: 0, shown: 0, ui: null, endId: 0};
            for (let i = 1; i <= 60; i++) {
                this._later(i * (90 - i * 0.6), () => {
                    if (this._combo)
                        this._showCombo(i);
                });
            }
            this._later(60 * 54 + 900, () => this._endCombo());
        }
    }
}
