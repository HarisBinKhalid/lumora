// Desktop FX: Cairo drawings for click ripples, window slams, windows
// crossing monitors and the battery fire. Everything is drawn in design
// units and scaled by the extension.

import Cairo from 'cairo';
import {
    TAU, WHITE, rand, pick, seg, easeOut, easeIn, mix,
    glow, puff, disc, ring, glowStroke,
} from './draw.js';

// ---------- Placing a drawing ----------

// A drawing in a local frame where +x points AWAY from an edge (or in the
// direction of travel) and (0, 0) is the anchor point. The canvas covers
// `back` units behind, `fwd` ahead and `half` to each side (as in Edge
// Portal). Returns the canvas box relative to the anchor, with the rotation
// baked into draw().
export function place(spec, [dx, dy]) {
    const {fwd, back = 0, half} = spec;
    let w, h, ox, oy;
    if (dx !== 0) {
        w = fwd + back; h = half * 2; oy = half; ox = dx > 0 ? back : fwd;
    } else {
        w = half * 2; h = fwd + back; ox = half; oy = dy > 0 ? back : fwd;
    }
    const theta = Math.atan2(dy, dx);
    return {
        duration: spec.duration, w, h, ox, oy,
        draw(cr, t) {
            cr.translate(ox, oy);
            cr.rotate(theta);
            spec.draw(cr, t);
        },
    };
}

// A drawing centred on the anchor, inside a box of radius r.
function centred(duration, r, draw) {
    return {
        duration, w: r * 2, h: r * 2, ox: r, oy: r,
        draw(cr, t) {
            cr.translate(r, r);
            draw(cr, t);
        },
    };
}

// ---------- Click ripples (designed for a 24px cursor) ----------

const CONFETTI = [[1, 0.3, 0.42], [1, 0.82, 0.25], [0.24, 0.86, 0.6], [0.3, 0.78, 0.95], [0.7, 0.53, 1]];

export const RIPPLE_STYLES = ['ripple', 'shockwave', 'sparks', 'confetti'];

export function ripple(style, c) {
    if (style === 'shockwave') {
        const streaks = Array.from({length: 10}, (_, i) => (i / 10) * TAU + rand(-0.15, 0.15));
        return centred(520, 80, (cr, t) => {
            glow(cr, 0, 0, 34, WHITE, 0.9 * (1 - seg(t, 0, 0.3)));
            const k = easeOut(t);
            ring(cr, 0, 0, 4 + 64 * k, 8 * (1 - t) + 0.5, c, 0.85 * (1 - t));
            ring(cr, 0, 0, 4 + 60 * k, 2.5 * (1 - t) + 0.3, WHITE, 0.9 * (1 - t));
            ring(cr, 0, 0, 2 + 40 * easeOut(seg(t, 0.1, 1)), 2, c, 0.4 * (1 - t));
            const sk = seg(t, 0, 0.6);
            if (sk < 1) {
                for (const a of streaks) {
                    const d1 = 10 + 50 * easeOut(sk), d2 = d1 - 16 * (1 - sk);
                    glowStroke(cr, [[Math.cos(a) * d2, Math.sin(a) * d2], [Math.cos(a) * d1, Math.sin(a) * d1]],
                        c, 1 - sk, 1.4);
                }
            }
        });
    }
    if (style === 'sparks') {
        const sparks = Array.from({length: 14}, () => ({a: rand(0, TAU), v: rand(34, 62), w: rand(1, 1.8)}));
        return centred(560, 76, (cr, t) => {
            glow(cr, 0, 0, 22, mix(WHITE, c, 0.4), 0.9 * (1 - seg(t, 0, 0.35)));
            for (const s of sparks) {
                const d = 6 + s.v * easeOut(t), tail = d - 18 * (1 - t);
                glowStroke(cr, [[Math.cos(s.a) * tail, Math.sin(s.a) * tail], [Math.cos(s.a) * d, Math.sin(s.a) * d]],
                    mix(WHITE, c, t), 1 - easeIn(t), s.w);
            }
        });
    }
    if (style === 'confetti') {
        const bits = Array.from({length: 16}, () => {
            const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
            const v = rand(40, 95);
            return {vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: rand(0, TAU), spin: rand(-12, 12),
                w: rand(4, 7), h: rand(2.5, 4), c: pick(CONFETTI)};
        });
        return centred(900, 96, (cr, t) => {
            const s = t * 1.3;
            for (const b of bits) {
                const x = b.vx * s, y = b.vy * s + 85 * s * s;
                cr.save();
                cr.translate(x, y);
                cr.rotate(b.rot + b.spin * t);
                cr.scale(1, Math.cos(b.rot + t * 14));
                cr.setSourceRGBA(b.c[0], b.c[1], b.c[2], 1 - seg(t, 0.6, 1));
                cr.rectangle(-b.w / 2, -b.h / 2, b.w, b.h);
                cr.fill();
                cr.restore();
            }
            glow(cr, 0, 0, 16, WHITE, 0.7 * (1 - seg(t, 0, 0.25)));
        });
    }
    // 'ripple': soft rings, like a drop in water.
    return centred(760, 70, (cr, t) => {
        glow(cr, 0, 0, 24, c, 0.5 * (1 - seg(t, 0, 0.4)));
        for (const d of [0, 0.16, 0.32]) {
            const k = seg(t, d, d + 0.68);
            if (k <= 0 || k >= 1)
                continue;
            ring(cr, 0, 0, 5 + 56 * easeOut(k), 2.6 * (1 - k) + 0.6, c, 0.85 * (1 - k));
        }
    });
}

// ---------- Window slam (designed for a 1080p screen) ----------

const DUST = [0.8, 0.76, 0.7];
const IMPACT = [0.65, 0.82, 1];

// The window hit the screen edge along a stretch `len` long. Local frame:
// the edge is the y axis, +x points into the screen.
export function slam(len) {
    const L = Math.max(80, len), half = L / 2;
    const n = Math.round(Math.max(8, Math.min(60, L / 28)));
    const dust = Array.from({length: n}, () => ({
        y: rand(-half, half), x: rand(40, 200), side: rand(-40, 40), r: rand(24, 52), d: rand(0, 0.18),
    }));
    // Soft flash spots along the edge (soft ends, unlike a rectangle).
    const nSpots = Math.max(2, Math.round(L / 70));
    const spots = Array.from({length: nSpots}, (_, i) => -half + 35 + (L - 70) * (i / (nSpots - 1)));
    const chips = Array.from({length: Math.min(30, n + 8)}, () => ({
        y: rand(-half, half), v: rand(80, 240), side: rand(-60, 60), s: rand(3, 6), rot: rand(0, TAU),
    }));
    const bulge = (y, amt) => amt * Math.cos((y / half) * Math.PI / 2);
    const line = (x, amt) => Array.from({length: 25}, (_, i) => {
        const y = -half + 20 + ((L - 40) * i) / 24;
        return [x + bulge(y, amt), y];
    });
    return {
        duration: 1000, fwd: 300, back: 0, half: half + 80,
        draw(cr, t) {
            // Flash right where the window hit.
            const f = 1 - seg(t, 0, 0.35);
            if (f > 0) {
                for (const y of spots)
                    glow(cr, 0, y, 95, IMPACT, 0.55 * f);
                glowStroke(cr, [[2, -half + 20], [2, half - 20]], IMPACT, f, 4);
            }
            // Two shockwaves rolling away from the edge.
            for (const [d, w] of [[0, 3.4], [0.12, 2]]) {
                const k = seg(t, d, d + 0.6);
                if (k > 0 && k < 1)
                    glowStroke(cr, line(8 + 230 * easeOut(k), 30 * k), IMPACT, 0.85 * (1 - k), w);
            }
            // Dust billowing out.
            for (const p of dust) {
                const lk = seg(t, p.d, 1);
                if (lk <= 0)
                    continue;
                puff(cr, 8 + p.x * easeOut(lk), p.y + p.side * lk, p.r * (0.45 + lk),
                    DUST, 0.62 * Math.sin(Math.PI * Math.pow(lk, 0.7)));
            }
            // Chips knocked loose.
            for (const c of chips) {
                const ck = seg(t, 0, 0.7);
                if (ck >= 1)
                    continue;
                const x = 4 + c.v * easeOut(ck), y = c.y + c.side * ck;
                cr.save();
                cr.translate(x, y);
                cr.rotate(c.rot + ck * 8);
                cr.setSourceRGBA(0.9, 0.9, 0.95, 1 - ck);
                cr.rectangle(-c.s / 2, -c.s / 2, c.s, c.s);
                cr.fill();
                cr.restore();
            }
        },
    };
}

// ---------- A window crossing to another monitor (1080p design) ----------

const CYAN = [0.4, 0.85, 1];
const VIOLET = [0.72, 0.5, 1];

// The big half, on the new monitor: a sheet of light the length of the
// window's edge, with waves rolling forward over the window.
export function crossEntry(len) {
    const L = Math.max(80, len), half = L / 2;
    const sparks = Array.from({length: Math.round(Math.max(14, Math.min(60, L / 18)))}, () => ({
        y: rand(-half, half), v: rand(60, 280), d: rand(0, 0.35), c: Math.random() < 0.7 ? CYAN : VIOLET,
        s: rand(1.3, 2.6),
    }));
    const wave = (x, amp, ph) => Array.from({length: 33}, (_, i) => {
        const y = -half + (L * i) / 32;
        return [x + Math.sin(i * 0.5 + ph) * amp, y];
    });
    return {
        duration: 850, fwd: 340, back: 0, half: half + 40,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.35, 1);
            // Bright band at the gate: a glow stretched along the edge, so it
            // fades out smoothly both into the window and towards the ends.
            cr.save();
            cr.scale(1, (half + 20) / 150);
            const g = new Cairo.RadialGradient(0, 0, 0, 0, 0, 150);
            g.addColorStopRGBA(0, CYAN[0], CYAN[1], CYAN[2], 0.5 * fade);
            g.addColorStopRGBA(0.6, CYAN[0], CYAN[1], CYAN[2], 0.3 * fade);
            g.addColorStopRGBA(1, CYAN[0], CYAN[1], CYAN[2], 0);
            cr.setSource(g);
            cr.rectangle(0, -150, 150, 300);
            cr.fill();
            cr.restore();
            glowStroke(cr, [[2, -half + 10], [2, half - 10]], CYAN, fade, 4.5);
            // Waves rolling forward over the window.
            for (const [d, c] of [[0, CYAN], [0.12, VIOLET], [0.24, CYAN]]) {
                const k = seg(t, d, d + 0.6);
                if (k > 0 && k < 1)
                    glowStroke(cr, wave(10 + 300 * easeOut(k), 6 * (1 - k), d * 20), c, 0.7 * (1 - k), 2);
            }
            for (const s of sparks) {
                const k = seg(t, s.d, s.d + 0.6);
                if (k <= 0 || k >= 1)
                    continue;
                const x = 4 + s.v * easeOut(k);
                disc(cr, x, s.y, s.s, s.c, 1 - k);
                glow(cr, x, s.y, s.s * 5, s.c, 0.5 * (1 - k));
            }
        },
    };
}

// The subtle half, on the old monitor: light pulled into the gate.
export function crossExit(len) {
    const L = Math.max(80, len), half = L / 2;
    const parts = Array.from({length: Math.round(Math.max(12, Math.min(40, L / 25)))}, () => ({
        y: rand(-half, half), x: rand(40, 200), d: rand(0, 0.4), c: Math.random() < 0.7 ? CYAN : VIOLET,
    }));
    return {
        duration: 600, fwd: 1, back: 220, half: half + 30,
        draw(cr, t) {
            for (const p of parts) {
                const k = seg(t, p.d, p.d + 0.55);
                if (k <= 0 || k >= 1)
                    continue;
                const x = -p.x * (1 - easeIn(k));
                const a = Math.min(1, k * 4) * (1 - k * k);
                glowStroke(cr, [[x - 14 * (1 - k), p.y], [x, p.y]], p.c, 0.6 * a, 1.2);
            }
            glowStroke(cr, [[-1, -half], [-1, half]], CYAN, 0.35 * Math.sin(Math.PI * t), 2);
        },
    };
}

// ---------- Battery fire (1080p design) ----------

// Flames along the bottom of a strip w wide and h tall. draw(cr, sec) takes
// the time in seconds, so the fire can burn for as long as it needs to.
export function makeFlames(w, h = 150) {
    const n = Math.max(4, Math.round(w / 22));
    const tongues = Array.from({length: n}, (_, i) => ({
        x: ((i + rand(0.2, 0.8)) / n) * w, base: rand(42, 84), wid: rand(22, 34),
        sp: rand(5, 9), ph: rand(0, TAU), sp2: rand(11, 17),
    }));
    const embers = Array.from({length: Math.max(6, Math.round(w / 70))}, () => ({
        x: rand(0, w), sp: rand(0.35, 0.7), off: rand(0, 1), sway: rand(6, 18), r: rand(1.2, 2.4),
    }));
    const tongue = (cr, x, hh, ww, sway) => {
        cr.moveTo(x - ww / 2, h);
        cr.curveTo(x - ww / 2, h - hh * 0.45, x - ww * 0.12 + sway * 0.5, h - hh * 0.75, x + sway, h - hh);
        cr.curveTo(x + ww * 0.12 + sway * 0.5, h - hh * 0.75, x + ww / 2, h - hh * 0.45, x + ww / 2, h);
        cr.closePath();
    };
    return {
        w, h,
        // strength 0..1 fades the whole fire in and out.
        draw(cr, sec, strength = 1) {
            if (strength <= 0.01)
                return;
            const top = h - 100;
            // Glow along the bottom.
            const base = new Cairo.LinearGradient(0, h, 0, h - 60);
            base.addColorStopRGBA(0, 1, 0.4, 0.05, 0.55 * strength);
            base.addColorStopRGBA(1, 1, 0.3, 0.05, 0);
            cr.setSource(base);
            cr.rectangle(0, h - 60, w, 60);
            cr.fill();
            // Outer flames: one path, one gradient (cheap to draw).
            for (const f of tongues) {
                const flick = 0.62 + 0.25 * Math.sin(sec * f.sp + f.ph) + 0.13 * Math.sin(sec * f.sp2 + f.ph * 2);
                tongue(cr, f.x, f.base * flick, f.wid, Math.sin(sec * 3 + f.ph) * 6);
            }
            const outer = new Cairo.LinearGradient(0, h, 0, top);
            outer.addColorStopRGBA(0, 1, 0.75, 0.3, 0.95 * strength);
            outer.addColorStopRGBA(0.35, 1, 0.45, 0.08, 0.85 * strength);
            outer.addColorStopRGBA(0.75, 0.85, 0.12, 0.04, 0.45 * strength);
            outer.addColorStopRGBA(1, 0.6, 0.05, 0, 0);
            cr.setSource(outer);
            cr.fill();
            // Hot inner cores.
            for (const f of tongues) {
                const flick = 0.62 + 0.25 * Math.sin(sec * f.sp + f.ph + 0.6);
                tongue(cr, f.x, f.base * flick * 0.5, f.wid * 0.5, Math.sin(sec * 3 + f.ph) * 3);
            }
            const inner = new Cairo.LinearGradient(0, h, 0, h - 50);
            inner.addColorStopRGBA(0, 1, 1, 0.85, 0.95 * strength);
            inner.addColorStopRGBA(1, 1, 0.85, 0.3, 0.2 * strength);
            cr.setSource(inner);
            cr.fill();
            // Embers drifting up.
            for (const e of embers) {
                const k = (sec * e.sp + e.off) % 1;
                const y = h - 20 - k * (h - 20);
                const x = e.x + Math.sin(sec * 2 + e.off * 9) * e.sway;
                const a = strength * Math.sin(Math.PI * k);
                disc(cr, x, y, e.r, [1, 0.75, 0.3], a);
                glow(cr, x, y, e.r * 4, [1, 0.45, 0.1], a * 0.5);
            }
        },
    };
}

// ---------- Previews for tools/effects-preview (screen positions) ----------

const at = (p, x, y, delay = 0) => ({...p, x: x - p.ox, y: y - p.oy, delay});

export const PREVIEWS = {
    ripples: () => RIPPLE_STYLES.map((s, i) => at(ripple(s, [0.35, 0.7, 1]), 300 + i * 420, 400)),
    slam: (W, H) => [at(place(slam(700), [1, 0]), 0, H / 2), at(place(slam(1200), [0, 1]), W / 2, 0, 0)],
    cross: (W, H) => [
        at(place(crossExit(520), [1, 0]), W / 2 - 1, H / 2),
        at(place(crossEntry(520), [1, 0]), W / 2, H / 2),
    ],
    fire: (W, H) => {
        const f = makeFlames(W);
        return [{duration: 3000, x: 0, y: H - f.h, w: W, h: f.h,
            draw: (cr, t) => f.draw(cr, t * 3, Math.min(1, t * 5))}];
    },
};
