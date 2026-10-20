// A small fake of the GNOME Shell APIs the Lumora extensions use, with a
// manual clock, so extension code can be run and checked in Node.
// Not a GNOME emulator: just enough behaviour to catch runtime mistakes
// (typos, wrong call order, leaked timers/actors) and to see what is drawn.
import {createCanvas} from '@napi-rs/canvas';
import CairoMock, {wrap} from './mockcairo.mjs';

// ---------- Clock + main loop ----------

export const clock = {ms: 0};
const sources = new Map();          // id -> {due, every, fn}
let nextId = 1;
export const errors = [];           // things real GLib/GNOME would complain about

function addSource(every, fn) {
    const id = nextId++;
    sources.set(id, {due: clock.ms + every, every, fn});
    return id;
}

export function advance(ms, step = 16) {
    const end = clock.ms + ms;
    while (clock.ms < end) {
        clock.ms = Math.min(end, clock.ms + step);
        for (const [id, s] of [...sources]) {
            if (!sources.has(id) || s.due > clock.ms)
                continue;
            const again = s.fn();
            if (again === true && sources.has(id))
                s.due = clock.ms + s.every;
            else
                sources.delete(id);
        }
        for (const tl of [...timelines])
            tl._frame();
        repaintAll();
    }
}

export const pendingSources = () => sources.size;

// ---------- Signals ----------

class Obj {
    constructor() {
        this._handlers = [];
    }
    connect(name, fn) {
        const id = nextId++;
        this._handlers.push({id, name, fn});
        return id;
    }
    disconnect(id) {
        this._handlers = this._handlers.filter(h => h.id !== id);
    }
    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2)
            this._handlers.push({id: nextId++, name: args[i], fn: args[i + 1], owner});
    }
    disconnectObject(owner) {
        this._handlers = this._handlers.filter(h => h.owner !== owner);
    }
    emit(name, ...args) {
        let r;
        for (const h of [...this._handlers])
            if (h.name === name)
                r = h.fn(this, ...args);
        return r;
    }
    handlerCount(name) {
        return this._handlers.filter(h => !name || h.name === name).length;
    }
}

// ---------- GLib ----------

const files = new Map();             // fake file system: path -> string
export const fs = files;
const dirMonitors = new Set();
// Write a file and tell directory watchers, like Gio.FileMonitor would.
export function writeFile(p, text) {
    files.set(p, text);
    for (const m of [...dirMonitors])
        m.emit('changed');
}
export const dirMonitorCount = () => dirMonitors.size;

export const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    FileTest: {EXISTS: 1},
    timeout_add: (_p, ms, fn) => addSource(ms, fn),
    timeout_add_seconds: (_p, s, fn) => addSource(s * 1000, fn),
    idle_add: (_p, fn) => addSource(0, fn),
    source_remove(id) {
        if (!sources.delete(id))
            errors.push(`GLib.source_remove(${id}): no such source (GLib would log a critical)`);
    },
    get_monotonic_time: () => Math.round(clock.ms * 1000),
    get_user_runtime_dir: () => '/run/user/1000',
    get_user_config_dir: () => '/home/u/.config',
    build_filenamev: parts => parts.join('/'),
    file_test: p => files.has(p),
    mkdir_with_parents: () => 0,
    file_set_contents: (p, v) => files.set(p, String(v)),
    file_get_contents(p) {
        if (!files.has(p))
            throw new Error('no such file');
        return [true, new TextEncoder().encode(files.get(p))];
    },
};

// ---------- Gio ----------

export const battery = {IsPresent: true, Percentage: 50, State: 2, proxy: null};

class DBusProxy extends Obj {
    get_cached_property(name) {
        return name in battery ? {unpack: () => battery[name]} : null;
    }
}

export const Gio = {
    Settings: class {
        get_int() {
            return 24;
        }
    },
    File: {
        new_for_path: p => ({
            delete: () => files.delete(p),
            monitor_directory: () => {
                const m = Object.assign(new Obj(), {cancel() {
                    dirMonitors.delete(m);
                }});
                dirMonitors.add(m);
                return m;
            },
        }),
    },
    FileMonitorFlags: {WATCH_MOVES: 1},
    SocketService: class extends Obj {
        add_address() {}
        start() {}
        stop() {}
        close() {}
    },
    InetSocketAddress: {new_from_string: () => ({})},
    SocketType: {STREAM: 1}, SocketProtocol: {TCP: 6},
    DBusProxy: {
        new_for_bus(_bus, _flags, _info, _name, _path, _iface, _cancel, cb) {
            addSource(5, () => {
                cb(null, 'res');
                return false;
            });
        },
        new_for_bus_finish() {
            battery.proxy = new DBusProxy();
            return battery.proxy;
        },
    },
    BusType: {SYSTEM: 1}, DBusProxyFlags: {DO_NOT_AUTO_START: 4},
    Cancellable: class {
        cancel() {}
    },
    IOErrorEnum: {CANCELLED: 19},
};

// ---------- Clutter ----------

const timelines = new Set();

export const Clutter = {
    ModifierType: {BUTTON1_MASK: 256, BUTTON2_MASK: 512, BUTTON3_MASK: 1024},
    AnimationMode: new Proxy({}, {get: (_t, k) => k}),
    ActorAlign: {CENTER: 'center', START: 'start', END: 'end'},
    Timeline: class extends Obj {
        constructor({duration}) {
            super();
            this.duration = duration;
            this.elapsed = 0;
        }
        start() {
            this.elapsed = 0;
            this._started = clock.ms;
            timelines.add(this);
        }
        stop() {
            timelines.delete(this);
        }
        get_elapsed_time() {
            return this.elapsed;
        }
        get_progress() {
            return Math.min(1, this.elapsed / this.duration);
        }
        _frame() {
            this.elapsed = Math.min(this.duration, clock.ms - this._started);
            this.emit('new-frame', this.elapsed);
            if (this.elapsed >= this.duration) {
                timelines.delete(this);
                this.emit('completed');
            }
        }
    },
};

export const runningTimelines = () => timelines.size;

// ---------- Meta ----------

const DIR = {W: 0x1000, E: 0x2000, S: 0x4000, N: 0x8000};
export const Meta = {
    GrabOp: {
        NONE: 0, MOVING: 1, KEYBOARD_MOVING: 1 | 0x100,
        RESIZING_N: 1 | DIR.N, RESIZING_S: 1 | DIR.S, RESIZING_E: 1 | DIR.E, RESIZING_W: 1 | DIR.W,
        RESIZING_NE: 1 | DIR.N | DIR.E,
    },
};

// ---------- St (actors) ----------

export const allActors = new Set();

class Actor extends Obj {
    constructor(props = {}) {
        super();
        Object.assign(this, {
            x: 0, y: 0, width: 0, height: 0, opacity: 255, visible: true,
            scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, rotation_angle_z: 0,
            style: '', reactive: false,          // St's default
        }, props);
        this.children = [];
        this.parent = null;
        this.destroyed = false;
        if (props.reactive === true)
            errors.push(`${this.constructor.name} created with reactive: true (would block clicks)`);
        allActors.add(this);
    }
    add_child(c) {
        if (this.destroyed || c.destroyed)
            errors.push('add_child on a destroyed actor');
        c.parent = this;
        this.children.push(c);
    }
    remove_child(c) {
        this.children = this.children.filter(x => x !== c);
        c.parent = null;
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.remove_all_transitions();
        for (const c of [...this.children])
            c.destroy();
        this.parent?.remove_child(this);
        allActors.delete(this);
        this.emit('destroy');
    }
    set_position(x, y) {
        this._num(x, y);
        this.x = x;
        this.y = y;
    }
    set_size(w, h) {
        this._num(w, h);
        this.width = w;
        this.height = h;
    }
    _num(...v) {
        if (v.some(n => !Number.isFinite(n)))
            errors.push(`non-finite position/size ${v} on ${this.constructor.name}`);
    }
    set_pivot_point() {}
    hide() {
        this.visible = false;
    }
    show() {
        this.visible = true;
    }
    remove_all_transitions() {
        for (const id of this._eases ?? [])
            sources.delete(id);
        this._eases = [];
    }
    ease(props) {
        const {duration = 0, delay = 0, onComplete, mode, repeatCount, autoReverse, ...vals} = props;
        void mode; void repeatCount; void autoReverse;
        // Real Clutter jumps to the end values when the transition finishes.
        const id = addSource(duration + delay, () => {
            this._eases = (this._eases ?? []).filter(e => e !== id);
            if (!this.destroyed) {
                Object.assign(this, vals);
                onComplete?.();
            }
            return false;
        });
        (this._eases ??= []).push(id);
    }
    get_preferred_width() {
        return [0, this.text ? this.text.length * 18 + 20 : 120];
    }
    get_preferred_height() {
        return [0, 60];
    }
    queue_repaint() {
        this._dirty = true;
    }
    absPos() {
        let x = 0, y = 0;
        for (let a = this; a; a = a.parent) {
            x += a.x + (a.translation_x || 0);
            y += a.y + (a.translation_y || 0);
        }
        return [x, y];
    }
}

class StageGroup extends Actor {}

class DrawingArea extends Actor {
    get_context() {
        const w = Math.max(1, Math.round(this.width)), h = Math.max(1, Math.round(this.height));
        if (!this._canvas || this._canvas.width !== w || this._canvas.height !== h)
            this._canvas = createCanvas(w, h);
        const ctx = this._canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return wrap(ctx);
    }
}

export const St = {
    Widget: class extends Actor {},
    DrawingArea,
    Label: class extends Actor {},
    Icon: class extends Actor {},
    BoxLayout: class extends Actor {},
};

let repaints = 0;
export const repaintCount = () => repaints;
function repaintAll() {
    for (const a of allActors) {
        if (a instanceof DrawingArea && a._dirty && !a.destroyed) {
            a._dirty = false;
            repaints++;
            a.emit('repaint');
        }
    }
}

// ---------- Main / global ----------

export const monitors = [
    {index: 0, x: 0, y: 0, width: 1920, height: 1080},
    {index: 1, x: 1920, y: 0, width: 1920, height: 1080},
    {index: 2, x: 0, y: -1080, width: 1920, height: 1080},     // a monitor ABOVE the primary
];
const uiGroup = new StageGroup({reactive: false});
export const Main = {
    uiGroup,
    layoutManager: Object.assign(new Obj(), {
        monitors, primaryMonitor: monitors[0], primaryIndex: 0,
        getWorkAreaForMonitor: i => {
            const m = monitors[i];
            return {x: m.x, y: m.y + 32, width: m.width, height: m.height - 32};
        },
    }),
    sessionMode: {isLocked: false},
};

export const pointer = {x: 100, y: 100, mods: 0};
const idleWatches = new Map();
export const display = new Obj();
export const globalObj = {
    get_pointer: () => [pointer.x, pointer.y, pointer.mods],
    backend: {
        get_core_idle_monitor: () => ({
            add_idle_watch(ms, cb) {
                const id = nextId++;
                idleWatches.set(id, cb);
                return id;
            },
            remove_watch(id) {
                if (!idleWatches.delete(id))
                    errors.push(`remove_watch(${id}): unknown watch`);
            },
        }),
    },
    display,
    stage: {width: 3840, height: 2160},
};
// One input event happened (like mutter's idle monitor resetting).
export function inputEvent() {
    for (const cb of [...idleWatches.values()])
        cb();
}
export const idleWatchCount = () => idleWatches.size;

export class Extension {
    constructor(metadata) {
        this.metadata = metadata;
    }
}

export const Cairo = {...CairoMock, Operator: {CLEAR: 0, OVER: 1}};

// A fake window for grab tests.
export class FakeWindow {
    constructor(rect, mon = 0) {
        this.rect = {...rect};
        this.mon = mon;
        this.alive = true;
    }
    get_frame_rect() {
        return {...this.rect};
    }
    get_monitor() {
        return this.mon;
    }
    get_compositor_private() {
        return this.alive ? {} : null;
    }
}

// Draws everything on the stage into a PNG-able canvas (rough: Cairo areas
// exactly, plain widgets as their background colour, labels as text).
export function screenshot(x0, y0, w, h, scale = 0.5) {
    const c = createCanvas(Math.round(w * scale), Math.round(h * scale));
    const s = c.getContext('2d');
    s.fillStyle = '#2b2f3a';
    s.fillRect(0, 0, c.width, c.height);
    s.scale(scale, scale);
    s.translate(-x0, -y0);
    const draw = a => {
        if (!a.visible || a.opacity <= 0)
            return;
        const [ax, ay] = a.absPos();
        s.save();
        s.globalAlpha = a.opacity / 255;
        if (a instanceof DrawingArea && a._canvas) {
            s.drawImage(a._canvas, ax, ay);
        } else if (a.text) {
            const m = /color: (#[0-9a-f]+)/i.exec(a.style);
            const size = /font-size: (\d+)px/.exec(a.style);
            s.fillStyle = m ? m[1] : '#fff';
            s.font = `bold ${size ? size[1] : 20}px sans-serif`;
            s.fillText(a.text, ax, ay + (size ? +size[1] : 20));
        } else {
            const m = /background-color: rgba?\(([^)]+)\)/.exec(a.style);
            const b = /border: (\d+)px solid rgba\(([^)]+)\)/.exec(a.style);
            const g = /background-gradient-start: rgba\(([^)]+)\)/.exec(a.style);
            const w2 = a.width * a.scale_x, h2 = a.height * a.scale_y;
            const cx = ax + (a.width - w2) / 2, cy = ay + (a.height - h2) / 2;
            if (m) {
                s.fillStyle = `rgba(${m[1]})`;
                s.fillRect(cx, cy, w2, h2);
            } else if (g) {
                s.fillStyle = `rgba(${g[1]})`;
                s.fillRect(cx, cy, w2, h2);
            }
            if (b) {
                s.strokeStyle = `rgba(${b[2]})`;
                s.lineWidth = +b[1];
                s.strokeRect(cx, cy, w2, h2);
            }
        }
        s.restore();
        for (const ch of a.children)
            draw(ch);
    };
    for (const a of uiGroup.children)
        draw(a);
    return c;
}
