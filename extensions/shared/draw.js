// Shared Cairo drawing helpers for Lumora scenes.
// SINGLE SOURCE: install.sh copies this file into each extension when building.

import Cairo from 'cairo';

export const TAU = Math.PI * 2;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];
export const clamp01 = v => Math.max(0, Math.min(1, v));
export const seg = (t, a, b) => clamp01((t - a) / (b - a)); // local progress inside [a, b]
export const easeOut = t => 1 - Math.pow(1 - t, 3);
export const easeIn = t => t * t * t;
export const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a, b, k) => a + (b - a) * k;
export const mix = (c1, c2, k) => [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];

export const WHITE = [1, 1, 1];

// Hue 0..1 to an RGB triple (full saturation, slightly soft).
export function hue(h) {
    const f = n => {
        const k = (n + h * 6) % 6;
        return 1 - 0.85 * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

// Soft radial glow.
export function glow(cr, x, y, r, c, a) {
    if (a <= 0.003 || r <= 0.5)
        return;
    const g = new Cairo.RadialGradient(x, y, 0, x, y, r);
    g.addColorStopRGBA(0, c[0], c[1], c[2], a);
    g.addColorStopRGBA(0.35, c[0], c[1], c[2], a * 0.45);
    g.addColorStopRGBA(1, c[0], c[1], c[2], 0);
    cr.setSource(g);
    cr.arc(x, y, r, 0, TAU);
    cr.fill();
}

// A ball of smoke / dust: soft edge, fairly solid middle.
export function puff(cr, x, y, r, c, a) {
    if (a <= 0.003 || r <= 0.5)
        return;
    const g = new Cairo.RadialGradient(x, y, 0, x, y, r);
    g.addColorStopRGBA(0, c[0], c[1], c[2], a);
    g.addColorStopRGBA(0.6, c[0], c[1], c[2], a * 0.7);
    g.addColorStopRGBA(1, c[0], c[1], c[2], 0);
    cr.setSource(g);
    cr.arc(x, y, r, 0, TAU);
    cr.fill();
}

export function disc(cr, x, y, r, c, a) {
    if (a <= 0.003 || r <= 0)
        return;
    cr.setSourceRGBA(c[0], c[1], c[2], Math.min(1, a));
    cr.arc(x, y, r, 0, TAU);
    cr.fill();
}

export function ring(cr, x, y, r, w, c, a) {
    if (a <= 0.003 || r <= 0 || w <= 0)
        return;
    cr.setLineWidth(w);
    cr.setSourceRGBA(c[0], c[1], c[2], Math.min(1, a));
    cr.arc(x, y, r, 0, TAU);
    cr.stroke();
}

function tracePath(cr, pts, f = 1) {
    if (pts.length < 2 || f <= 0)
        return false;
    const last = (pts.length - 1) * clamp01(f);
    const n = Math.floor(last);
    cr.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= n; i++)
        cr.lineTo(pts[i][0], pts[i][1]);
    const frac = last - n;
    if (frac > 0 && n + 1 < pts.length) {
        const [ax, ay] = pts[n], [bx, by] = pts[n + 1];
        cr.lineTo(lerp(ax, bx, frac), lerp(ay, by, frac));
    }
    return true;
}

// A line with a soft coloured halo and a hot white core.
export function glowStroke(cr, pts, c, a, w, f = 1) {
    if (a <= 0.003 || w <= 0)
        return;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    for (const [mul, am] of [[6, 0.1], [3, 0.25], [1.5, 0.65]]) {
        if (!tracePath(cr, pts, f))
            return;
        cr.setLineWidth(w * mul);
        cr.setSourceRGBA(c[0], c[1], c[2], a * am);
        cr.stroke();
    }
    tracePath(cr, pts, f);
    cr.setLineWidth(Math.max(0.6, w * 0.55));
    cr.setSourceRGBA(1, 1, 1, Math.min(1, a));
    cr.stroke();
}

// Jagged line by midpoint displacement (lightning, cracks).
export function jagged(x1, y1, x2, y2, rough = 0.25, iters = 5) {
    let pts = [[x1, y1], [x2, y2]];
    let disp = Math.hypot(x2 - x1, y2 - y1) * rough;
    for (let i = 0; i < iters; i++) {
        const next = [pts[0]];
        for (let j = 1; j < pts.length; j++) {
            const [ax, ay] = pts[j - 1], [bx, by] = pts[j];
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const nx = -(by - ay) / len, ny = (bx - ax) / len;
            const o = rand(-disp, disp);
            next.push([(ax + bx) / 2 + nx * o, (ay + by) / 2 + ny * o], [bx, by]);
        }
        pts = next;
        disp /= 2;
    }
    return pts;
}

// A blast at (x, y): flash, fireball, flying debris and rising dark smoke.
// Make one with makeExplosion() up front, then draw it with k going 0 -> 1.
export function makeExplosion(size = 1) {
    return {
        size,
        debris: Array.from({length: 26}, () => ({
            a: rand(-Math.PI * 0.95, -Math.PI * 0.05), v: rand(120, 330) * size,
            r: rand(2, 5) * size, hot: Math.random() < 0.6,
        })),
        smoke: Array.from({length: 12}, () => ({
            x: rand(-60, 60) * size, rise: rand(60, 170) * size, r: rand(26, 54) * size, d: rand(0, 0.3),
        })),
    };
}

export function drawExplosion(cr, x, y, ex, k) {
    if (k <= 0 || k >= 1)
        return;
    const s = ex.size;
    // Dark smoke, rising slowly.
    for (const p of ex.smoke) {
        const lk = seg(k, p.d, 1);
        if (lk <= 0)
            continue;
        puff(cr, x + p.x * easeOut(lk), y - p.rise * easeOut(lk), p.r * (0.5 + lk),
            [0.22, 0.2, 0.2], 0.55 * Math.sin(Math.PI * lk));
    }
    // Fireball.
    const fk = seg(k, 0, 0.55);
    if (fk < 1) {
        const r = 150 * s * easeOut(fk);
        glow(cr, x, y - r * 0.3, r * 1.4, [1, 0.45, 0.1], 0.8 * (1 - fk));
        puff(cr, x, y - r * 0.3, r * 0.8, [1, 0.75, 0.3], 0.9 * (1 - fk));
        glow(cr, x, y - r * 0.2, r * 0.5, WHITE, 1 - fk);
    }
    // Debris, thrown up and falling back.
    const dt = k * 1.1;   // keeps debris within about 380 * size of the blast
    for (const d of ex.debris) {
        const px = x + Math.cos(d.a) * d.v * dt;
        const py = y + Math.sin(d.a) * d.v * dt + 520 * s * dt * dt;
        const a = 1 - k;
        disc(cr, px, py, d.r, d.hot ? [1, 0.7, 0.25] : [0.35, 0.33, 0.33], a);
        if (d.hot)
            glow(cr, px, py, d.r * 4, [1, 0.5, 0.1], a * 0.5);
    }
}
