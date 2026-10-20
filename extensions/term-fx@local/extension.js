import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {LiveConfig, listen} from './config.js';
import {SCENES, fireworks} from './scenes.js';

const PORT = 47321;           // must match TERM_FX_PORT in fx.sh

// Defaults; the Lumora app changes these live via ~/.config/lumora/config.json
const DEFAULTS = {
    confetti: true,
    successGlow: true,
    confettiCount: 280,
    confettiSpread: 1.8,   // seconds over which confetti keeps dropping in
    warning: true,
    failGlow: true,
    warningSeconds: 1.8,
    // git commands with their own animation (instead of confetti / the banner).
    gitEffects: ['push', 'pull', 'commit', 'merge'],
    // Fireworks when a command took a long time: small show from longMinutes,
    // big finale from epicMinutes.
    longCommand: true,
    longMinutes: 1,
    epicMinutes: 5,
};

// git subcommands and the animation they get.
const GIT_KINDS = {
    push: 'push',
    pull: 'pull', fetch: 'pull', clone: 'pull',
    commit: 'commit',
    merge: 'merge', rebase: 'merge', 'cherry-pick': 'merge',
};
// git options that take a separate value (git -C dir push).
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// Words that can come before git in the command text (fx sudo git push).
const PREFIXES = new Set(['eval', 'sudo', 'command', 'time', 'nice', 'nohup', 'env']);

// Which git animation a command gets, or null. Exported for tests.
export function gitKind(cmd) {
    const words = cmd.trim().split(/\s+/).map(w => w.replace(/^["']+|["']+$/g, ''));
    let i = 0;
    while (i < words.length && PREFIXES.has(words[i]))
        i++;
    if (!/(^|\/)git$/.test(words[i] ?? ''))
        return null;
    for (i++; i < words.length; i++) {
        const w = words[i];
        if (GIT_ARG_OPTS.has(w))
            i++;
        else if (!w.startsWith('-'))
            return GIT_KINDS[w] ?? null;
    }
    return null;
}

// ---- Safety switch ----
// Does NOTHING unless this file exists. /run/user/<id>/ is wiped on every
// restart, so the effects are always OFF after a reboot.
//   Turn on:  touch "$XDG_RUNTIME_DIR/term-fx-on"
//   Turn off: rm "$XDG_RUNTIME_DIR/term-fx-on"
const FLAG_NAME = 'term-fx-on';

const COLORS = ['#ff4d6d', '#ffd23f', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8c42', '#ffffff', '#f72585'];
const rand = (a, b) => a + Math.random() * (b - a);

export default class TerminalFxExtension extends Extension {
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
        this._flagPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), FLAG_NAME]);
        this._actors = new Set();
        this._timelines = new Set();
        this._timeouts = new Set();
        this._warning = null;
        this._lastEvent = 0;

        this._cfg = new LiveConfig('terminal', DEFAULTS);

        // Listen for messages from fx.sh on localhost only (never the network).
        try {
            this._service = listen(PORT, line => this._handle(line));
        } catch (e) {
            console.error(`Terminal FX: could not listen on port ${PORT}: ${e}`);
            this._service = null;
        }
    }

    disable() {
        this._markRunning(false);
        if (this._service) {
            this._service.stop();
            this._service.close();
            this._service = null;
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
        this._warning = null;
        this._cfg?.destroy();
        this._cfg = null;
    }

    // ---------- Receiving events ----------

    // Message format: "<success|fail> <exit code> [d=<seconds>] <command text>"
    // (d= is how long the command ran; older fx.sh versions leave it out).
    // The Lumora app sends "preview-success" / "preview-fail" to test.
    _handle(line) {
        const m = line.match(/^(preview-)?(success|fail) (\d{1,3})(?: d=(\d{1,7}))? ?(.*)$/);
        if (!m)
            return;
        const preview = !!m[1];
        if (!preview && !GLib.file_test(this._flagPath, GLib.FileTest.EXISTS))
            return; // switched off
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastEvent < 400)
            return; // ignore spam
        this._lastEvent = now;

        const cfg = this._cfg.values;
        const mon = this._targetMonitor();
        const ok = m[2] === 'success';
        const git = gitKind(m[5]);
        const tier = ok ? this._longTier(Number(m[4] ?? 0)) : 0;
        let played = false;
        if (git && (preview || cfg.gitEffects.includes(git))) {
            this._gitScene(mon, `${git}-${ok ? 'success' : 'fail'}`, ok);
            played = true;
        }
        if (tier && (preview || cfg.longCommand)) {
            this._fireworks(mon, tier, !played);
            played = true;
        }
        if (played)
            return;
        if (ok) {
            if (preview || cfg.confetti)
                this._confetti(mon);
            else if (cfg.successGlow)
                this._glowOnly(mon, '60, 220, 120');
        } else if (preview || cfg.warning) {
            this._showWarning(mon);
        } else if (cfg.failGlow) {
            this._glowOnly(mon, '255, 40, 40');
        }
    }

    // 0 = normal, 1 = ran longer than longMinutes, 2 = longer than epicMinutes.
    _longTier(seconds) {
        const cfg = this._cfg.values;
        const long = Math.max(0.1, cfg.longMinutes) * 60;
        const epic = Math.max(long, cfg.epicMinutes * 60);
        if (seconds >= epic)
            return 2;
        return seconds >= long ? 1 : 0;
    }

    // ---------- Cairo scenes (git, fireworks) ----------

    // Scenes are designed for a 1080p screen; scale to this monitor.
    _sceneScale(mon) {
        return Math.max(0.5, Math.min(3, mon.height / 1080));
    }

    // Plays a list of scenes (each may have a `delay`) in one clipped layer,
    // then removes the layer when the last one ends.
    _playScenes(mon, pieces, layer = this._layer(mon)) {
        const sc = this._sceneScale(mon);
        let left = pieces.length;
        const done = () => {
            if (--left <= 0)
                this._remove(layer);
        };
        for (const spec of pieces) {
            const start = () => {
                if (!this._actors.has(layer))
                    return;
                this._playScene(layer, spec, sc, done);
            };
            if (spec.delay)
                this._later(spec.delay, start);
            else
                start();
        }
        return layer;
    }

    _playScene(layer, spec, sc, onDone) {
        const area = new St.DrawingArea({
            x: Math.round(spec.x * sc), y: Math.round(spec.y * sc),
            width: Math.max(1, Math.ceil(spec.w * sc)), height: Math.max(1, Math.ceil(spec.h * sc)),
            reactive: false,
        });
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
                    console.error(`Terminal FX draw error: ${e}`);
                }
            } finally {
                cr.$dispose();
            }
        });
        layer.add_child(area);
        const tl = new Clutter.Timeline({actor: area, duration: spec.duration});
        this._timelines.add(tl);
        tl.connect('new-frame', () => {
            t = tl.get_progress();
            area.queue_repaint();
        });
        tl.connect('completed', () => {
            this._timelines.delete(tl);
            area.destroy();
            onDone();
        });
        area.queue_repaint();
        tl.start();
    }

    _gitScene(mon, name, ok) {
        const cfg = this._cfg.values;
        const sc = this._sceneScale(mon);
        const spec = SCENES[name](mon.width / sc, mon.height / sc);
        const layer = this._playScenes(mon, [spec]);
        if (ok ? cfg.successGlow : cfg.failGlow) {
            const glow = this._topGlow(layer, mon, ok ? '60, 220, 120' : '255, 40, 40');
            this._later(900, () => glow.ease({
                opacity: 0, duration: 700, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
        }
    }

    // Long command finished: fireworks (tier 2 adds confetti at the end).
    _fireworks(mon, tier, withGlow) {
        const cfg = this._cfg.values;
        const sc = this._sceneScale(mon);
        const layer = this._playScenes(mon, fireworks(mon.width / sc, mon.height / sc, tier));
        if (withGlow && cfg.successGlow) {
            const glow = this._topGlow(layer, mon, '60, 220, 120');
            this._later(1200, () => glow.ease({
                opacity: 0, duration: 900, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
        }
        if (tier >= 2 && cfg.confetti)
            this._later(3600, () => this._confetti(mon, false));
    }

    // Just the coloured glow along the top, when the main effect is switched off.
    _glowOnly(mon, rgb) {
        const layer = this._layer(mon);
        const glow = this._topGlow(layer, mon, rgb);
        this._later(700, () => glow.ease({
            opacity: 0, duration: 600, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._remove(layer),
        }));
    }

    // Always the main (primary) screen.
    _targetMonitor() {
        return Main.layoutManager.primaryMonitor;
    }

    // A clipped layer covering exactly one monitor, so nothing can spill
    // onto a screen placed above or beside it.
    _layer(mon) {
        return this._add(new St.Widget({
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
            clip_to_allocation: true, reactive: false,
        }));
    }

    _topGlow(layer, mon, rgb) {
        const strip = new St.Widget({
            style: 'background-gradient-direction: vertical;' +
                   `background-gradient-start: rgba(${rgb}, 0.55);` +
                   `background-gradient-end: rgba(${rgb}, 0);`,
            reactive: false, x: 0, y: 0, width: mon.width, height: 140, opacity: 0,
        });
        layer.add_child(strip);
        strip.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return strip;
    }

    _add(actor) {
        Main.uiGroup.add_child(actor);
        this._actors.add(actor);
        return actor;
    }

    _remove(actor) {
        if (!this._actors.has(actor))
            return;
        this._actors.delete(actor);
        actor.destroy();
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // ---------- Confetti ----------

    _confetti(mon, withGlow = true) {
        const cfg = this._cfg.values;
        const count = Math.max(10, Math.min(1000, Math.round(cfg.confettiCount)));
        const spread = Math.max(0.2, Math.min(6, cfg.confettiSpread));
        const layer = this._layer(mon);
        if (withGlow && cfg.successGlow) {
            const glow = this._topGlow(layer, mon, '60, 220, 120');
            this._later(900, () => glow.ease({
                opacity: 0, duration: 700, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
        }
        const pieces = [];
        for (let i = 0; i < count; i++) {
            const round = Math.random() < 0.2;
            const w = round ? rand(6, 8) : rand(6, 12);
            const h = round ? w : rand(3, 6);
            const actor = new St.Widget({
                style: `background-color: ${COLORS[Math.floor(Math.random() * COLORS.length)]};` +
                       `border-radius: ${round ? w / 2 : 1}px;`,
                width: w, height: h, reactive: false, opacity: 0,
            });
            layer.add_child(actor);
            actor.set_pivot_point(0.5, 0.5);
            pieces.push({
                actor,
                x: rand(0, mon.width), y: -rand(14, 40),
                vx: rand(-60, 60), vy: rand(0, 150),
                fall: rand(230, 380),                     // terminal speed (px/s)
                delay: rand(0, spread),
                rot: rand(0, 360), spin: rand(-420, 420),
                flip: rand(0, Math.PI * 2), flipSpeed: rand(5, 13),
                sway: rand(0, Math.PI * 2), swayAmp: rand(15, 55), swayFreq: rand(1.2, 2.8),
            });
        }

        const duration = Math.min(12000, 1000 * (mon.height / 230 + 1.4 + spread));
        const tl = new Clutter.Timeline({actor: layer, duration});
        this._timelines.add(tl);
        let last = 0;
        tl.connect('new-frame', () => {
            const ms = tl.get_elapsed_time();
            const dt = Math.min(0.05, (ms - last) / 1000);
            last = ms;
            const sec = ms / 1000;
            const fadeOut = Math.min(1, Math.max(0, (duration - ms) / 700));
            for (const p of pieces) {
                const t = sec - p.delay;
                if (t < 0)
                    continue;
                p.vy = Math.min(p.fall, p.vy + 900 * dt);  // gravity, with air drag cap
                p.vx *= 0.985;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                const a = p.actor;
                if (p.y > mon.height + 20) {
                    a.opacity = 0;
                    continue;
                }
                a.set_position(p.x + Math.sin(p.sway + t * p.swayFreq) * p.swayAmp, p.y);
                a.rotation_angle_z = p.rot + p.spin * t;
                a.scale_y = Math.cos(p.flip + p.flipSpeed * t); // paper flipping over
                a.opacity = Math.round(255 * Math.min(1, t * 6) * fadeOut);
            }
        });
        tl.connect('completed', () => {
            this._timelines.delete(tl);
            this._remove(layer);
        });
        tl.start();
    }

    // ---------- Warning banner ----------

    _dismissWarning(instant = false) {
        const w = this._warning;
        if (!w)
            return;
        this._warning = null;
        if (instant) {
            this._remove(w.layer);
            return;
        }
        w.box.ease({
            translation_y: -w.height - 80, opacity: 0, duration: 260,
            mode: Clutter.AnimationMode.EASE_IN_BACK,
        });
        w.strip.ease({
            opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._remove(w.layer),
        });
    }

    _showWarning(mon) {
        this._dismissWarning(true);
        const cfg = this._cfg.values;
        const layer = this._layer(mon);
        const strip = this._topGlow(layer, mon, '255, 40, 40');
        if (!cfg.failGlow)
            strip.hide();

        // The banner.
        const box = new St.BoxLayout({
            reactive: false,
            style: 'background-color: rgba(38, 8, 10, 0.94);' +
                   'border: 2px solid rgba(255, 80, 80, 0.95);' +
                   'border-radius: 16px; padding: 14px 24px; spacing: 16px;' +
                   'box-shadow: 0 0 32px 6px rgba(255, 40, 40, 0.6);',
        });
        const icon = new St.Icon({
            icon_name: 'dialog-warning-symbolic', icon_size: 38,
            style: 'color: #ffcc33;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        icon.set_pivot_point(0.5, 0.5);
        const text = new St.Label({
            text: 'Command failed',
            style: 'color: #ffffff; font-weight: bold; font-size: 16pt;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);
        box.add_child(text);
        layer.add_child(box);

        const [, natW] = box.get_preferred_width(-1);
        const [, natH] = box.get_preferred_height(natW);
        box.set_position(Math.round((mon.width - natW) / 2), 52);
        box.translation_y = -natH - 80;

        const w = {layer, box, strip, height: natH};
        this._warning = w;

        // Drop in, then shake.
        box.ease({
            translation_y: 0, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                const steps = [-14, 12, -9, 6, -3, 0];
                const shake = i => {
                    if (i >= steps.length || this._warning !== w)
                        return;
                    box.ease({
                        translation_x: steps[i], duration: 45,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        onComplete: () => shake(i + 1),
                    });
                };
                shake(0);
            },
        });
        // Pulse the warning icon.
        icon.ease({
            scale_x: 1.25, scale_y: 1.25, duration: 200, delay: 320,
            repeatCount: 1, autoReverse: true,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        });

        const ms = Math.round(Math.max(0.5, Math.min(10, cfg.warningSeconds)) * 1000);
        this._later(ms, () => {
            if (this._warning === w)
                this._dismissWarning();
        });
    }
}
