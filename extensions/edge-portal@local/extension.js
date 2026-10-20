import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EFFECTS, setLineBoost} from './effects.js';
import {LiveConfig, listen} from './config.js';

// Defaults; the Lumora app changes these live via ~/.config/lumora/config.json
const DEFAULTS = {
    // Crossing animations to pick from (a different one each time).
    effects: ['teleport', 'shatter', 'lightning', 'warp', 'inferno', 'glitch'],
    // Size compared to the mouse cursor (4 = main burst about 4x the cursor).
    size: 4,
    // Glow when pushing against an edge with no monitor beyond it.
    barrier: true,
    barrierEdges: ['left', 'right', 'top', 'bottom'],
    barrierColor: '255, 40, 40',
};
const PREVIEW_PORT = 47322;        // the Lumora app sends previews here
const POLL_MS = 16;                // how often to check the mouse (~60 fps)
const COOLDOWN_MS = 250;           // ignore rapid back-and-forth crossings
const MAX_ACTORS = 300;            // safety cap on on-screen effect pieces

// ---- Safety switch ----
// The extension does NOTHING unless this file exists. It lives in
// /run/user/<your-id>/, which is wiped on every restart, so after a
// reboot the effects are always OFF until you switch them on again.
//   Turn on:  touch "$XDG_RUNTIME_DIR/edge-portal-on"
//   Turn off: rm "$XDG_RUNTIME_DIR/edge-portal-on"
const FLAG_NAME = 'edge-portal-on';

const rand = (min, max) => min + Math.random() * (max - min);

export default class EdgePortalExtension extends Extension {
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
        this._actors = new Set();
        this._lastMonitor = -1;
        this._lastFire = 0;
        this._timerId = 0;
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._flagPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), FLAG_NAME]);
        this._cfg = new LiveConfig('edge', DEFAULTS, () => {
            if (this._timerId)
                this._buildBarriers(); // edges or barrier on/off may have changed
        });
        try {
            this._preview = listen(PREVIEW_PORT, line => this._onPreview(line));
        } catch (e) {
            console.warn(`Edge Portal: preview listener unavailable: ${e}`);
            this._preview = null;
        }

        this._barriers = [];
        this._segments = [];
        this._barriersWork = false;

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._lastMonitor = -1;
            if (this._timerId)
                this._buildBarriers();
        }, this);

        // Check the on/off switch once a second; only track the mouse while on.
        this._checkFlag();
        this._flagTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._checkFlag();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._markRunning(false);
        if (this._flagTimerId) {
            GLib.source_remove(this._flagTimerId);
            this._flagTimerId = 0;
        }
        this._stopTracking();
        Main.layoutManager.disconnectObject(this);
        if (this._preview) {
            this._preview.stop();
            this._preview.close();
            this._preview = null;
        }
        this._cfg?.destroy();
        this._cfg = null;
        for (const a of this._actors) {
            a._edgeTimeline?.stop();
            a._edgeTimeline = null;
            a.remove_all_transitions();
            a.destroy();
        }
        this._actors.clear();
        this._actors = null;
        this._ifaceSettings = null;
    }

    // Scale factor so effects match the cursor size (effects are designed
    // so their core burst is about SIZE x the cursor).
    _scale() {
        let cursor = 24;
        try {
            cursor = this._ifaceSettings.get_int('cursor-size') || 24;
        } catch (e) {}
        const size = Math.max(0.5, Math.min(12, this._cfg.values.size));
        return Math.max(0.05, (cursor * size) / 300);
    }

    // ---------- On/off switch ----------

    _checkFlag() {
        const on = GLib.file_test(this._flagPath, GLib.FileTest.EXISTS);
        if (on && !this._timerId)
            this._startTracking();
        else if (!on && this._timerId)
            this._stopTracking();
    }

    _startTracking() {
        this._lastMonitor = -1;
        this._buildBarriers();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            try {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                // Something went wrong: stop quietly instead of misbehaving.
                console.error(`Edge Portal stopped after an error: ${e}`);
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _stopTracking() {
        this._destroyBarriers();
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    // ---------- Outer-edge barrier ----------

    // Works out which parts of each monitor's edges have NO monitor beyond
    // them. Shared edges are always left alone, so moving between your
    // monitors is never blocked.
    _computeOuterSegments() {
        const mons = Main.layoutManager.monitors;
        const T = 2; // tolerance in pixels
        const free = (a, b, covers) => {
            let parts = [[a, b]];
            for (const [s, e] of covers) {
                const next = [];
                for (const [p, q] of parts) {
                    if (e <= p || s >= q) {
                        next.push([p, q]);
                        continue;
                    }
                    if (s > p) next.push([p, s]);
                    if (e < q) next.push([e, q]);
                }
                parts = next;
            }
            return parts.filter(([p, q]) => q - p > 8);
        };

        const segs = [];
        for (const m of mons) {
            const others = mons.filter(o => o !== m);
            const vCover = test => others.filter(test).map(o => [o.y - T, o.y + o.height + T]);
            const hCover = test => others.filter(test).map(o => [o.x - T, o.x + o.width + T]);
            const sides = {
                left:   {pos: m.x,            a: m.y, b: m.y + m.height,
                         covers: vCover(o => Math.abs(o.x + o.width - m.x) <= T)},
                right:  {pos: m.x + m.width,  a: m.y, b: m.y + m.height,
                         covers: vCover(o => Math.abs(o.x - (m.x + m.width)) <= T)},
                top:    {pos: m.y,            a: m.x, b: m.x + m.width,
                         covers: hCover(o => Math.abs(o.y + o.height - m.y) <= T)},
                bottom: {pos: m.y + m.height, a: m.x, b: m.x + m.width,
                         covers: hCover(o => Math.abs(o.y - (m.y + m.height)) <= T)},
            };
            for (const side of this._cfg.values.barrierEdges) {
                const sd = sides[side];
                if (!sd) continue;
                for (const [a, b] of free(sd.a, sd.b, sd.covers))
                    segs.push({side, pos: sd.pos, a, b, lastHit: 0});
            }
        }
        return segs;
    }

    _newBarrier(props) {
        // The constructor changed between GNOME versions; try both forms.
        try {
            return new Meta.Barrier({backend: global.backend, ...props});
        } catch (e) {
            return new Meta.Barrier({display: global.display, ...props});
        }
    }

    _buildBarriers() {
        this._destroyBarriers();
        if (!this._cfg.values.barrier)
            return;
        this._segments = this._computeOuterSegments();
        this._barriersWork = true;
        try {
            for (const seg of this._segments) {
                const vertical = seg.side === 'left' || seg.side === 'right';
                const dirs = {
                    left: Meta.BarrierDirection.POSITIVE_X,
                    right: Meta.BarrierDirection.NEGATIVE_X,
                    top: Meta.BarrierDirection.POSITIVE_Y,
                    bottom: Meta.BarrierDirection.NEGATIVE_Y,
                };
                const barrier = this._newBarrier(vertical
                    ? {x1: seg.pos, x2: seg.pos, y1: seg.a, y2: seg.b, directions: dirs[seg.side]}
                    : {x1: seg.a, x2: seg.b, y1: seg.pos, y2: seg.pos, directions: dirs[seg.side]});
                barrier.connect('hit', (_b, ev) => {
                    try {
                        this._onBarrierHit(seg, ev.x, ev.y, vertical ? ev.dx : ev.dy);
                    } catch (e) {
                        console.error(`Edge Portal barrier error: ${e}`);
                    }
                });
                this._barriers.push(barrier);
            }
        } catch (e) {
            // Barriers not supported here: fall back to simple edge detection.
            console.warn(`Edge Portal: using fallback edge detection (${e})`);
            this._destroyBarriers();
            this._segments = this._computeOuterSegments();
            this._barriersWork = false;
        }
    }

    _destroyBarriers() {
        for (const b of this._barriers || [])
            b.destroy();
        this._barriers = [];
        this._barriersWork = false;
    }

    _onBarrierHit(seg, x, y, push) {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - seg.lastHit < 70 || this._actors.size >= MAX_ACTORS)
            return;
        seg.lastHit = now;
        // Snap the effect onto the visible edge pixel.
        if (seg.side === 'left') x = seg.pos;
        else if (seg.side === 'right') x = seg.pos - 1;
        else if (seg.side === 'top') y = seg.pos;
        else y = seg.pos - 1;
        const strength = Math.min(Math.max(Math.abs(push), 1), 30) / 30;
        this._barrierEffect(seg.side, x, y, strength);
    }

    // Fallback (no barrier support): fire when the cursor slides onto an outer edge.
    _checkEdgeFallback(x, y) {
        if (!this._cfg.values.barrier || this._barriersWork)
            return;
        for (const seg of this._segments) {
            const vertical = seg.side === 'left' || seg.side === 'right';
            const edgePx = seg.side === 'left' || seg.side === 'top' ? seg.pos : seg.pos - 1;
            const along = vertical ? y : x;
            const onEdge = (vertical ? x : y) === edgePx && along >= seg.a && along < seg.b;
            if (onEdge && (this._lastX !== x || this._lastY !== y)) {
                this._onBarrierHit(seg, x, y, 12);
                return;
            }
        }
    }

    _barrierEffect(side, x, y, strength) {
        const vertical = side === 'left' || side === 'right';
        const inward = {left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1]}[side];
        const sc = this._scale();
        const color = this._barrierColor();
        const len = (140 + strength * 160) * sc;

        // Red glow pressed against the edge.
        const glow = this._spawn(
            `background-color: rgba(${color}, 0.9);` +
            'border-radius: 6px;' +
            `box-shadow: 0 0 ${Math.round(30 * sc + 6)}px ${Math.round(12 * sc + 2)}px rgba(${color}, 0.75);`,
            vertical ? 6 : len, vertical ? len : 6, x, y);
        glow.opacity = Math.round(110 + strength * 145);
        glow.ease({
            opacity: 0,
            scale_x: vertical ? 2.5 : 1.15,
            scale_y: vertical ? 1.15 : 2.5,
            duration: 380,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._finish(glow),
        });

        // Particles pushed back into the screen.
        const base = Math.atan2(inward[1], inward[0]);
        const count = 3 + Math.round(strength * 9);
        for (let i = 0; i < count; i++) {
            const offset = rand(-len / 3, len / 3);
            const px = vertical ? x : x + offset;
            const py = vertical ? y + offset : y;
            const sp = this._spark(px, py, Math.max(2, rand(3, 7) * Math.sqrt(sc)), color);
            const a = base + rand(-0.9, 0.9);
            const d = rand(30, 110) * (0.5 + strength) * sc;
            sp.ease({
                translation_x: Math.cos(a) * d,
                translation_y: Math.sin(a) * d,
                opacity: 0,
                duration: rand(350, 650),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._finish(sp),
            });
        }
    }

    // ---------- Detecting the crossing ----------

    _monitorAt(x, y) {
        for (const m of Main.layoutManager.monitors) {
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return m;
        }
        return null;
    }

    _tick() {
        const [x, y] = global.get_pointer();
        this._checkEdgeFallback(x, y);
        const prevX = this._lastX ?? x, prevY = this._lastY ?? y;
        this._lastX = x;
        this._lastY = y;
        const mon = this._monitorAt(x, y);
        if (!mon)
            return;

        if (this._lastMonitor !== -1 && mon.index !== this._lastMonitor) {
            const oldMon = Main.layoutManager.monitors[this._lastMonitor];
            const now = GLib.get_monotonic_time() / 1000;
            if (oldMon && now - this._lastFire > COOLDOWN_MS &&
                this._actors.size < MAX_ACTORS) {
                this._lastFire = now;
                this._onCross(oldMon, mon, prevX, prevY, x, y);
            }
        }
        this._lastMonitor = mon.index;
    }

    _onCross(oldMon, newMon, px, py, x, y) {
        // Which way did the cursor travel?
        let dir;
        if (newMon.x >= oldMon.x + oldMon.width) dir = [1, 0];
        else if (newMon.x + newMon.width <= oldMon.x) dir = [-1, 0];
        else if (newMon.y >= oldMon.y + oldMon.height) dir = [0, 1];
        else dir = [0, -1];

        // Work out exactly where on the shared edge the cursor crossed, by
        // following the line from its last position to its current one. Fast
        // movements can land the cursor far inside the new screen before we
        // notice, so we never use the current position directly: both halves
        // of the animation are pinned to the crossing point on the edge.
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
        let exit, entry;
        if (dir[0] !== 0) {
            const X = dir[0] > 0 ? oldMon.x + oldMon.width : oldMon.x;
            const k = x !== px ? clamp((X - px) / (x - px), 0, 1) : 0;
            const lo = Math.max(oldMon.y, newMon.y);
            const hi = Math.min(oldMon.y + oldMon.height, newMon.y + newMon.height) - 1;
            const Y = Math.round(clamp(py + k * (y - py), lo, hi));
            exit = [dir[0] > 0 ? X - 1 : X, Y];
            entry = [dir[0] > 0 ? X : X - 1, Y];
        } else {
            const Y = dir[1] > 0 ? oldMon.y + oldMon.height : oldMon.y;
            const k = y !== py ? clamp((Y - py) / (y - py), 0, 1) : 0;
            const lo = Math.max(oldMon.x, newMon.x);
            const hi = Math.min(oldMon.x + oldMon.width, newMon.x + newMon.width) - 1;
            const X = Math.round(clamp(px + k * (x - px), lo, hi));
            exit = [X, dir[1] > 0 ? Y - 1 : Y];
            entry = [X, dir[1] > 0 ? Y : Y - 1];
        }

        const pool = this._cfg.values.effects.filter(n => EFFECTS[n]);
        if (!pool.length)
            return; // all crossing animations switched off
        const choices = pool.length > 1 ? pool.filter(n => n !== this._lastEffect) : pool;
        const name = choices[Math.floor(Math.random() * choices.length)];
        const fx = EFFECTS[name];
        this._lastEffect = name;

        this._play(fx.exit(), exit, dir);   // subtle, on the monitor being left
        this._play(fx.entry(), entry, dir); // the big moment, on the new monitor
    }

    // Runs one animation on its own Cairo canvas, sized to just the area it needs.
    _play(spec, [px, py], [dx, dy]) {
        const {duration, draw} = spec;
        const sc = this._scale();
        const fit = v => Math.max(1, Math.ceil(v * sc));
        const fwd = fit(spec.fwd), back = spec.back ? fit(spec.back) : 0, half = fit(spec.half);
        let w, h, ox, oy;
        if (dx !== 0) {
            w = fwd + back; h = half * 2; oy = half; ox = dx > 0 ? back : fwd;
        } else {
            w = half * 2; h = fwd + back; ox = half; oy = dy > 0 ? back : fwd;
        }
        const theta = Math.atan2(dy, dx);
        const area = new St.DrawingArea({
            width: w, height: h, reactive: false,
            x: Math.round(px - ox), y: Math.round(py - oy),
        });
        let t = 0;
        area.connect('repaint', a => {
            const cr = a.get_context();
            try {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);
                cr.translate(ox, oy);
                cr.rotate(theta);
                cr.scale(sc, sc);
                setLineBoost(Math.min(2.5, 1 / Math.sqrt(sc)));
                draw(cr, t);
            } catch (e) {
                if (!this._drawErrorLogged) {
                    this._drawErrorLogged = true;
                    console.error(`Edge Portal draw error: ${e}`);
                }
            } finally {
                cr.$dispose();
            }
        });
        Main.uiGroup.add_child(area);
        this._actors.add(area);

        const tl = new Clutter.Timeline({actor: area, duration});
        area._edgeTimeline = tl;
        tl.connect('new-frame', () => {
            t = tl.get_progress();
            area.queue_repaint();
        });
        tl.connect('completed', () => this._finish(area));
        area.queue_repaint();
        tl.start();
    }

    // Validated "r, g, b" (it goes into CSS, so never trust it blindly).
    _barrierColor() {
        const c = this._cfg.values.barrierColor;
        const m = /^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/.exec(c);
        if (!m || [m[1], m[2], m[3]].some(v => +v > 255))
            return DEFAULTS.barrierColor;
        return `${m[1]}, ${m[2]}, ${m[3]}`;
    }

    // "preview <effect>" from the Lumora app: play it mid-screen.
    _onPreview(line) {
        const m = /^preview (\w+)$/.exec(line.trim());
        if (!m || !EFFECTS[m[1]])
            return;
        const mon = Main.layoutManager.primaryMonitor;
        const cx = Math.round(mon.x + mon.width / 2), cy = Math.round(mon.y + mon.height / 2);
        const fx = EFFECTS[m[1]];
        this._play(fx.exit(), [cx - 1, cy], [1, 0]);
        this._play(fx.entry(), [cx, cy], [1, 0]);
    }

    // ---------- Helpers ----------

    // Creates a click-through actor centred on (cx, cy) above all windows.
    _spawn(style, w, h, cx, cy) {
        const actor = new St.Widget({
            style,
            width: w,
            height: h,
            reactive: false,
            x: Math.round(cx - w / 2),
            y: Math.round(cy - h / 2),
        });
        actor.set_pivot_point(0.5, 0.5);
        Main.uiGroup.add_child(actor);
        this._actors.add(actor);
        return actor;
    }

    _finish(actor) {
        if (!this._actors || !this._actors.has(actor))
            return;
        this._actors.delete(actor);
        actor._edgeTimeline?.stop();
        actor._edgeTimeline = null;
        actor.destroy();
    }

    _spark(cx, cy, size, color) {
        return this._spawn(
            `background-color: rgba(${color}, 1);` +
            `border-radius: ${size / 2}px;` +
            `box-shadow: 0 0 8px 2px rgba(${color}, 0.8);`,
            size, size, cx, cy);
    }
}
