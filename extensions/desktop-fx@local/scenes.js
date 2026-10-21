// Desktop FX: Cairo drawings for click ripples, window slams, windows
// crossing monitors, the battery (low / charged) and the clipboard.
// Everything is drawn in design units and scaled by the extension.

import Cairo from 'cairo';
import {
    TAU, WHITE, rand, pick, seg, easeOut, easeIn, easeInOut, lerp, mix,
    glow, puff, disc, ring, glowStroke, roundRect,
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

// ---------- Battery (1080p design) ----------

const LOW = [1, 0.25, 0.22];
const CHARGED = [0.3, 0.95, 0.5];

// A battery icon centred on (x, y), w wide. level 0..1 of `fillCol`.
function battery(cr, x, y, w, level, fillCol, a, outline = [0.92, 0.94, 0.97]) {
    const h = w * 0.46, r = h * 0.2, t = Math.max(3, w * 0.045);
    // Inside fill.
    const pad = t * 1.6, iw = w - pad * 2, ih = h - pad * 2;
    if (level > 0) {
        cr.setSourceRGBA(fillCol[0], fillCol[1], fillCol[2], a);
        roundRect(cr, x - w / 2 + pad, y - h / 2 + pad, Math.max(ih * 0.3, iw * level), ih, r * 0.5);
        cr.fill();
    }
    // Case and terminal.
    cr.setLineWidth(t);
    cr.setSourceRGBA(outline[0], outline[1], outline[2], a);
    roundRect(cr, x - w / 2, y - h / 2, w, h, r);
    cr.stroke();
    roundRect(cr, x + w / 2 + t * 0.5, y - h * 0.22, t * 1.8, h * 0.44, t * 0.5);
    cr.fill();
}

// A lightning bolt centred on (x, y), s tall.
function bolt(cr, x, y, s, c, a, filled = true) {
    const k = s / 100;
    cr.moveTo(x + 10 * k, y - 50 * k);
    cr.lineTo(x - 26 * k, y + 8 * k);
    cr.lineTo(x - 2 * k, y + 8 * k);
    cr.lineTo(x - 12 * k, y + 50 * k);
    cr.lineTo(x + 26 * k, y - 10 * k);
    cr.lineTo(x + 2 * k, y - 10 * k);
    cr.closePath();
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    if (filled) {
        cr.fill();
    } else {
        cr.setLineWidth(3);
        cr.stroke();
    }
}

// Low battery: a nearly empty battery at the bottom of the screen whose last
// red bar blinks, a "plug me in" bolt flashing beside it, red energy
// draining out of it, and a red pulse along the bottom edge. Strip w x h;
// draw(cr, sec, strength, pct) takes seconds so it can run for as long as
// the battery stays low.
export function makeLowBattery(w, h = 170) {
    const cx = w / 2, cy = h - 74;
    const drips = Array.from({length: 7}, () => ({x: rand(-40, 40), off: rand(0, 1), sp: rand(0.5, 0.9)}));
    return {
        w, h,
        draw(cr, sec, strength = 1, pct = 8) {
            if (strength <= 0.01)
                return;
            const pulse = 0.5 + 0.5 * Math.sin(sec * 3.2);
            // Red pulse along the bottom edge.
            const g = new Cairo.LinearGradient(0, h, 0, h - 70);
            g.addColorStopRGBA(0, LOW[0], LOW[1], LOW[2], (0.18 + 0.22 * pulse) * strength);
            g.addColorStopRGBA(1, LOW[0], LOW[1], LOW[2], 0);
            cr.setSource(g);
            cr.rectangle(0, h - 70, w, 70);
            cr.fill();
            // Energy draining out of the battery into the edge.
            for (const d of drips) {
                const k = (sec * d.sp + d.off) % 1;
                const y = cy + 30 + k * (h - cy - 30);
                disc(cr, cx + d.x, y, 2.6 * (1 - k * 0.5), LOW, strength * (1 - k) * 0.9);
            }
            glow(cr, cx, cy, 120, LOW, (0.15 + 0.2 * pulse) * strength);
            // The battery, its red sliver blinking.
            const blink = 0.35 + 0.65 * (Math.sin(sec * 6.5) > -0.2 ? 1 : 0);
            battery(cr, cx, cy, 130, Math.max(0.04, Math.min(1, pct / 100)), LOW,
                strength * blink, [0.92, 0.94, 0.97]);
            // "Plug me in": a bolt beside it, flashing in turn with the bar.
            bolt(cr, cx + 112, cy, 54, [1, 0.85, 0.35], strength * (0.25 + 0.75 * (1 - pulse)));
        },
    };
}

// Charged to the chosen level: the same strip and battery as the low
// warning, but green. The battery fills up to full, the bottom edge glows
// green, a bolt flashes in the battery and a few sparks rise. The box is the
// whole strip along the bottom (anchor = bottom centre of the screen).
export function batteryCharged(w, from = 0.6, h = 170) {
    const cx = w / 2, cy = h - 74;
    const sparks = Array.from({length: 14}, () => ({x: rand(-70, 70), v: rand(40, 90), d: rand(0, 0.25)}));
    return {
        duration: 3000, w, h, ox: w / 2, oy: h,
        draw(cr, t) {
            const a = Math.min(1, t / 0.1) * (1 - seg(t, 0.78, 1));
            const fill = lerp(from, 1, easeInOut(seg(t, 0.05, 0.5)));
            const full = seg(t, 0.5, 0.62);           // the moment it's full
            const pulse = 0.5 + 0.5 * Math.sin(t * 14);
            // Green glow along the bottom edge, brightest when it fills up.
            const g = new Cairo.LinearGradient(0, h, 0, h - 70);
            g.addColorStopRGBA(0, CHARGED[0], CHARGED[1], CHARGED[2], (0.2 + 0.15 * pulse + 0.25 * full) * a);
            g.addColorStopRGBA(1, CHARGED[0], CHARGED[1], CHARGED[2], 0);
            cr.setSource(g);
            cr.rectangle(0, h - 70, w, 70);
            cr.fill();
            glow(cr, cx, cy, 120, CHARGED, (0.18 + 0.3 * full * (1 - seg(t, 0.62, 0.9))) * a);
            // The battery filling up.
            battery(cr, cx, cy, 130, fill, CHARGED, a);
            // Full: a bolt flashes inside it and sparks rise.
            if (full > 0) {
                bolt(cr, cx, cy, 44, WHITE, a * (1 - 0.5 * seg(t, 0.62, 0.78)));
                for (const p of sparks) {
                    const k = seg(t, 0.5 + p.d, 0.95);
                    if (k > 0 && k < 1)
                        disc(cr, cx + p.x, cy - 30 - p.v * easeOut(k), 2.2, [0.75, 1, 0.8], a * (1 - k));
                }
            }
        },
    };
}

// ---------- Clipboard (designed for a 24px cursor, like the ripples) ----------

const COPY = [0.45, 0.75, 1];
const CUT = [1, 0.6, 0.25];

function page(cr, x, y, c, a) {
    cr.setSourceRGBA(0.12, 0.14, 0.18, 0.85 * a);
    roundRect(cr, x - 11, y - 14, 22, 28, 4);
    cr.fill();
    cr.setLineWidth(2.2);
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    roundRect(cr, x - 11, y - 14, 22, 28, 4);
    cr.stroke();
    cr.setLineWidth(1.6);
    for (let i = 0; i < 3; i++) {
        cr.moveTo(x - 6, y - 6 + i * 6);
        cr.lineTo(x + (i === 2 ? 2 : 6), y - 6 + i * 6);
    }
    cr.stroke();
}

// Copied: a second page slides out of the first, with a little sparkle.
export function clipCopy() {
    return {
        duration: 850, w: 140, h: 140, ox: 70, oy: 70,
        draw(cr, t) {
            cr.translate(70, 70);
            const a = Math.min(1, t / 0.1) * (1 - seg(t, 0.7, 1));
            const k = easeOut(seg(t, 0.1, 0.5));
            cr.translate(26, -24);                    // up and right of the cursor
            page(cr, 0, 0, COPY, a);
            page(cr, 13 * k, -13 * k, mix(WHITE, COPY, k), a);
            const sp = seg(t, 0.45, 0.8);
            if (sp > 0 && sp < 1) {
                const sx = 26, sy = -26, r = 9 * Math.sin(Math.PI * sp);
                glowStroke(cr, [[sx - r, sy], [sx + r, sy]], COPY, a, 1.6);
                glowStroke(cr, [[sx, sy - r], [sx, sy + r]], COPY, a, 1.6);
            }
        },
    };
}

// Files cut in the Files app: scissors snip along a dashed line, which
// splits apart behind them.
export function clipCut() {
    return {
        duration: 950, w: 180, h: 140, ox: 90, oy: 70,
        draw(cr, t) {
            cr.translate(90, 70);
            const a = Math.min(1, t / 0.08) * (1 - seg(t, 0.75, 1));
            cr.translate(20, -26);
            const along = easeInOut(seg(t, 0.05, 0.7));
            const sx = lerp(-40, 40, along);
            // Dashed line: the part behind the scissors drifts apart.
            const apart = 7 * seg(t, 0.2, 0.9);
            cr.setLineWidth(2);
            for (let x = -50; x < 50; x += 8) {
                const cut = x < sx;
                cr.setSourceRGBA(CUT[0], CUT[1], CUT[2], a * (cut ? 0.8 : 0.5));
                const dy = cut ? (x % 16 === 0 ? -apart : apart) : 0;
                cr.moveTo(x, dy);
                cr.lineTo(x + 4, dy);
                cr.stroke();
            }
            // Scissors: two blades snipping open and shut.
            const open = 0.45 * Math.abs(Math.sin(t * 22));
            cr.save();
            cr.translate(sx, 0);
            for (const side of [-1, 1]) {
                cr.save();
                cr.rotate(side * open);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineWidth(3);
                cr.setSourceRGBA(0.92, 0.94, 0.97, a);
                cr.moveTo(0, 0);
                cr.lineTo(16, 0);
                cr.stroke();
                ring(cr, -8, side * 6, 5, 2.5, CUT, a);
                cr.restore();
            }
            disc(cr, 0, 0, 2, CUT, a);
            cr.restore();
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
    lowbattery: (W, H) => {
        const f = makeLowBattery(W);
        return [{duration: 3000, x: 0, y: H - f.h, w: W, h: f.h,
            draw: (cr, t) => f.draw(cr, t * 3, Math.min(1, t * 5), 7)}];
    },
    charged: (W, H) => [at(batteryCharged(W, 0.6), W / 2, H)],
    clipboard: () => [at(clipCopy(), 700, 400), at(clipCut(), 1100, 400)],
};
