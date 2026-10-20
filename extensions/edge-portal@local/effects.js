// Edge Portal: animation library.
// Every effect has an EXIT half (subtle, on the monitor the cursor leaves)
// and an ENTRY half (the big moment, on the monitor it arrives on).
// Drawing is done with Cairo in a local frame where +x points the way the
// cursor travelled and (0, 0) is the crossing point.

import Cairo from 'cairo';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp01 = v => Math.max(0, Math.min(1, v));
const seg = (t, a, b) => clamp01((t - a) / (b - a)); // local progress inside [a, b]
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeIn = t => t * t * t;
const lerp = (a, b, k) => a + (b - a) * k;
const mix = (c1, c2, k) => [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];

const WHITE = [1, 1, 1];

// Effects are scaled down to match the cursor size. Lines are thickened a
// little when shrunk so they stay crisp instead of turning into hairlines.
let LINE_BOOST = 1;
export function setLineBoost(b) {
    LINE_BOOST = b;
}
const setLW = (cr, w) => cr.setLineWidth(w * LINE_BOOST);

// ---------- Drawing helpers ----------

function glow(cr, x, y, r, c, a) {
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
function glowStroke(cr, pts, c, a, w, f = 1, halo = 1) {
    if (a <= 0.003 || w <= 0)
        return;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    for (const [mul, am] of [[7, 0.08], [3.5, 0.22], [1.6, 0.6]]) {
        if (!tracePath(cr, pts, f))
            return;
        setLW(cr, w * mul);
        cr.setSourceRGBA(c[0], c[1], c[2], a * am * (mul > 2 ? halo : 1));
        cr.stroke();
    }
    tracePath(cr, pts, f);
    setLW(cr, Math.max(0.6, w * 0.55));
    cr.setSourceRGBA(1, 1, 1, Math.min(1, a));
    cr.stroke();
}

// Jagged line by midpoint displacement (lightning, cracks).
function jagged(x1, y1, x2, y2, rough = 0.25, iters = 5) {
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

function circlePts(r, n = 64, wobble = 0) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = (i / n) * TAU;
        const rr = r + (wobble ? rand(-wobble, wobble) : 0);
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    return pts;
}

function polygon(cr, pts) {
    cr.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++)
        cr.lineTo(pts[i][0], pts[i][1]);
    cr.closePath();
}

function trailDot(cr, x, y, px, py, size, c, a) {
    glowStroke(cr, [[px, py], [x, y]], c, a, size);
    glow(cr, x, y, size * 4, c, a * 0.6);
}

// =====================================================================
// 1. TELEPORT — exit: implodes into the edge. entry: portal explodes open.
// =====================================================================
const CYAN = [0.45, 0.85, 1];
const VIOLET = [0.75, 0.45, 1];

function teleportExit() {
    const parts = Array.from({length: 28}, () => ({
        a: rand(Math.PI * 0.55, Math.PI * 1.45), r: rand(40, 140),
        size: rand(1.2, 2.6), swirl: rand(0.6, 1.4) * pick([-1, 1]),
        delay: rand(0, 0.3), c: Math.random() < 0.7 ? CYAN : VIOLET,
    }));
    const at = (p, k) => {
        const r = p.r * (1 - k), a = p.a + p.swirl * k;
        return [Math.cos(a) * r, Math.sin(a) * r];
    };
    return {
        duration: 520, fwd: 1, back: 170, half: 150,
        draw(cr, t) {
            for (const p of parts) {
                const lt = seg(t, p.delay, 1);
                if (lt <= 0) continue;
                const k = easeIn(lt), k0 = easeIn(Math.max(0, lt - 0.12));
                const [x, y] = at(p, k), [px, py] = at(p, k0);
                trailDot(cr, x, y, px, py, p.size, p.c, Math.min(1, lt * 4) * 0.9);
            }
            const s = Math.sin(Math.PI * t);
            glow(cr, 0, 0, 10 + 34 * s, CYAN, 0.55 * s);
            const pinch = seg(t, 0.82, 1);
            glow(cr, 0, 0, 16 * (1 - pinch) + 2, WHITE, 0.9 * Math.sin(Math.PI * pinch));
        },
    };
}

function teleportEntry() {
    const sparks = Array.from({length: 50}, () => ({
        a: rand(-1.5, 1.5), d: rand(90, 320), size: rand(1, 2.6),
        delay: rand(0, 0.12), c: pick([CYAN, CYAN, VIOLET, WHITE]),
    }));
    const rings = [
        {delay: 0, reach: 290, c: CYAN, w: 5},
        {delay: 0.1, reach: 220, c: VIOLET, w: 4},
        {delay: 0.2, reach: 150, c: WHITE, w: 3},
    ].map(r => ({...r, pts: circlePts(1, 90, 0.008)}));
    return {
        duration: 950, fwd: 340, back: 0, half: 340,
        draw(cr, t) {
            // Opening flash
            const f = seg(t, 0, 0.22);
            glow(cr, 0, 0, 60 + 220 * easeOut(f), WHITE, 0.85 * (1 - f));
            glow(cr, 0, 0, 120, CYAN, 0.45 * (1 - seg(t, 0, 0.7)));

            // Spinning portal arms
            const grow = easeOut(seg(t, 0, 0.3)), fade = 1 - seg(t, 0.35, 1);
            for (let arm = 0; arm < 5; arm++) {
                const pts = [];
                for (let k = 0; k <= 24; k++) {
                    const u = k / 24;
                    const r = 8 + u * 95 * grow;
                    const a = arm * TAU / 5 + u * 2.6 + t * 7;
                    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
                }
                glowStroke(cr, pts, arm % 2 ? VIOLET : CYAN, 0.8 * fade, 2.2 * (1 - u0(t)));
            }

            // Shockwave rings
            for (const ring of rings) {
                const lt = seg(t, ring.delay, ring.delay + 0.6);
                if (lt <= 0 || lt >= 1) continue;
                const r = easeOut(lt) * ring.reach;
                const pts = ring.pts.map(([x, y]) => [x * r, y * r]);
                glowStroke(cr, pts, ring.c, 1 - lt, ring.w * (1 - lt) + 0.5);
            }

            // Sparks flying out with trails
            for (const s of sparks) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const d = s.d * easeOut(lt), dp = s.d * easeOut(Math.max(0, lt - 0.08));
                trailDot(cr, Math.cos(s.a) * d, Math.sin(s.a) * d,
                    Math.cos(s.a) * dp, Math.sin(s.a) * dp, s.size * (1 - lt * 0.6), s.c, 1 - lt);
            }
        },
    };
}
const u0 = t => seg(t, 0.3, 1) * 0.7;

// =====================================================================
// 2. SHATTER — exit: a few glass particles. entry: the wall cracks open.
// =====================================================================
const ICE = [0.75, 0.9, 1];

function shatterExit() {
    const bits = Array.from({length: 18}, () => ({
        x: rand(-8, 0), y: rand(-50, 50), ...(() => {
            const a = rand(Math.PI * 0.55, Math.PI * 1.45), v = rand(15, 60);
            return {vx: Math.cos(a) * v, vy: Math.sin(a) * v};
        })(),
        size: rand(2, 5), rot: rand(0, TAU), spin: rand(-8, 8), delay: rand(0, 0.25),
    }));
    return {
        duration: 650, fwd: 1, back: 120, half: 160,
        draw(cr, t) {
            glow(cr, 0, 0, 40, ICE, 0.35 * (1 - t));
            for (const b of bits) {
                const lt = seg(t, b.delay, 1);
                if (lt <= 0) continue;
                const x = b.x + b.vx * easeOut(lt), y = b.y + b.vy * easeOut(lt);
                const a = 1 - lt;
                cr.save();
                cr.translate(x, y);
                cr.rotate(b.rot + b.spin * lt);
                polygon(cr, [[0, -b.size], [b.size * 0.9, b.size * 0.7], [-b.size * 0.8, b.size * 0.5]]);
                cr.setSourceRGBA(ICE[0], ICE[1], ICE[2], 0.45 * a);
                cr.fillPreserve();
                setLW(cr, 0.8);
                cr.setSourceRGBA(1, 1, 1, 0.9 * a);
                cr.stroke();
                cr.restore();
                if (Math.random() < 0.15)
                    glow(cr, x, y, 6, WHITE, a);
            }
        },
    };
}

function shatterEntry() {
    const N = 11;
    const cracks = [];
    for (let i = 0; i < N; i++) {
        const a = -1.45 + (i * 2.9) / (N - 1) + rand(-0.1, 0.1);
        const len = rand(170, 400);
        const pts = jagged(0, 0, Math.cos(a) * len, Math.sin(a) * len, 0.06, 4);
        const branches = [];
        for (let b = 0; b < 2; b++) {
            const p = pts[Math.floor(rand(0.3, 0.8) * pts.length)];
            const ba = a + rand(0.35, 0.8) * pick([-1, 1]), bl = len * rand(0.15, 0.3);
            branches.push(jagged(p[0], p[1], p[0] + Math.cos(ba) * bl, p[1] + Math.sin(ba) * bl, 0.08, 3));
        }
        cracks.push({pts, branches, len, delay: i * 0.008});
    }
    // Concentric cracks join neighbouring radial cracks, spider-web style.
    const pointAt = (pts, r) => pts.find(([x, y]) => Math.hypot(x, y) >= r);
    const webs = [45, 100, 175].map((r, ri) => {
        const pieces = [];
        for (let i = 0; i < N - 1; i++) {
            if (Math.random() < 0.2) continue;
            const p1 = pointAt(cracks[i].pts, r), p2 = pointAt(cracks[i + 1].pts, r);
            if (p1 && p2) pieces.push(jagged(p1[0], p1[1], p2[0], p2[1], 0.06, 2));
        }
        return {pieces, delay: 0.1 + ri * 0.06};
    });
    const shards = Array.from({length: 18}, () => {
        const n = pick([3, 3, 4]), s = rand(8, 30), pts = [];
        for (let k = 0; k < n; k++) {
            const a = (k / n) * TAU + rand(-0.4, 0.4);
            pts.push([Math.cos(a) * s * rand(0.5, 1), Math.sin(a) * s * rand(0.5, 1)]);
        }
        const a = rand(-1.45, 1.45), v = rand(60, 200);
        return {pts, x: 0, y: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
            rot: rand(0, TAU), spin: rand(-9, 9), delay: rand(0.04, 0.12)};
    });
    const glints = Array.from({length: 24}, () => {
        const c = pick(cracks);
        return {p: c.pts[Math.floor(rand(0.1, 1) * (c.pts.length - 1))], ph: rand(0, TAU)};
    });
    return {
        duration: 1300, fwd: 430, back: 0, half: 360,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.6, 1);
            const f = seg(t, 0, 0.16);
            glow(cr, 0, 0, 40 + 140 * easeOut(f), WHITE, 0.95 * (1 - f));
            glow(cr, 0, 0, 70, ICE, 0.4 * fade);

            for (const c of cracks) {
                const g = easeOut(seg(t, c.delay, 0.28));
                glowStroke(cr, c.pts, ICE, fade, 1.5, g, 0.35);
                const bg = seg(t, 0.15, 0.4);
                for (const b of c.branches)
                    glowStroke(cr, b, ICE, fade * 0.8, 1, bg, 0.35);
            }
            for (const w of webs) {
                const g = easeOut(seg(t, w.delay, w.delay + 0.18));
                for (const p of w.pieces)
                    glowStroke(cr, p, ICE, fade * 0.85, 1.1, g, 0.35);
            }
            for (const gl of glints) {
                const a = fade * Math.max(0, Math.sin(t * 30 + gl.ph)) * seg(t, 0.2, 0.3);
                glow(cr, gl.p[0], gl.p[1], 7, WHITE, a);
            }
            for (const s of shards) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const k = 1 - Math.pow(1 - lt, 4); // fast burst, then settles
                const x = s.x + s.vx * k, y = s.y + s.vy * k;
                const a = 1 - lt;
                cr.save();
                cr.translate(x, y);
                cr.rotate(s.rot + s.spin * 0.3 * (1 - Math.pow(1 - lt, 4)));
                polygon(cr, s.pts);
                const lg = new Cairo.LinearGradient(-20, -20, 20, 20);
                lg.addColorStopRGBA(0, 1, 1, 1, 0.55 * a);
                lg.addColorStopRGBA(1, ICE[0], ICE[1], ICE[2], 0.12 * a);
                cr.setSource(lg);
                cr.fillPreserve();
                setLW(cr, 1.2);
                cr.setSourceRGBA(1, 1, 1, 0.95 * a);
                cr.stroke();
                cr.restore();
            }
        },
    };
}

// =====================================================================
// 3. LIGHTNING — exit: small static crackle. entry: double lightning strike.
// =====================================================================
const BOLT = [0.55, 0.7, 1];
const PURPLE = [0.75, 0.55, 1];

function makeBolt(angle, len, branches, rough = 0.28) {
    const main = jagged(0, 0, Math.cos(angle) * len, Math.sin(angle) * len, rough, 6);
    const forks = [];
    for (let i = 0; i < branches; i++) {
        const p = main[Math.floor(rand(0.15, 0.8) * main.length)];
        const a = angle + rand(0.35, 0.9) * pick([-1, 1]), l = len * rand(0.18, 0.42);
        forks.push(jagged(p[0], p[1], p[0] + Math.cos(a) * l, p[1] + Math.sin(a) * l, 0.3, 4));
    }
    return {main, forks, end: main[main.length - 1]};
}

function lightningExit() {
    const variants = Array.from({length: 3}, () => Array.from({length: 5}, () => {
        const sx = rand(-25, 0), sy = rand(-35, 35);
        return jagged(sx, sy, sx - rand(10, 40), sy + rand(-30, 30), 0.45, 3);
    }));
    const sparks = Array.from({length: 10}, () => ({a: rand(Math.PI * 0.6, Math.PI * 1.4), d: rand(20, 70), delay: rand(0, 0.4)}));
    return {
        duration: 420, fwd: 1, back: 120, half: 100,
        draw(cr, t) {
            const v = variants[Math.floor(t * 16) % 3];
            const a = (1 - t) * rand(0.5, 1);
            glow(cr, 0, 0, 30, BOLT, 0.5 * (1 - t));
            for (const arc of v)
                glowStroke(cr, arc, BOLT, a, 0.9);
            for (const s of sparks) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const d = s.d * easeOut(lt), dp = s.d * easeOut(Math.max(0, lt - 0.1));
                trailDot(cr, Math.cos(s.a) * d, Math.sin(s.a) * d, Math.cos(s.a) * dp, Math.sin(s.a) * dp, 1, WHITE, 1 - lt);
            }
        },
    };
}

function lightningEntry() {
    const strike = () => {
        const bolts = [makeBolt(rand(-0.3, 0.3), rand(360, 500), 5)];
        for (const side of [-1, 1])
            bolts.push(makeBolt(side * rand(0.6, 1.2), rand(150, 270), 2, 0.32));
        return bolts;
    };
    const strikes = [strike(), strike()];
    const endSparks = strikes[1].map(b => Array.from({length: 12}, () => ({
        a: rand(0, TAU), d: rand(20, 90), size: rand(0.8, 1.8),
    })));
    return {
        duration: 850, fwd: 540, back: 0, half: 340,
        draw(cr, t) {
            const s1 = t < 0.17 ? 1 - seg(t, 0, 0.15) : 0;
            const s2 = t >= 0.17 ? 1 - seg(t, 0.19, 0.36) : 0;
            const after = t >= 0.36 ? 0.28 * (1 - seg(t, 0.36, 0.75)) : 0;
            const I = Math.max(s1, s2, after) * rand(0.8, 1);
            const bolts = strikes[t < 0.17 ? 0 : 1];

            glow(cr, 60, 0, 300, BOLT, 0.3 * Math.max(s1, s2));
            glow(cr, 0, 0, 90, WHITE, 0.8 * Math.max(s1, s2));

            bolts.forEach((b, i) => {
                const w = i === 0 ? 4.2 : 2.4;
                glowStroke(cr, b.main, i === 0 ? BOLT : PURPLE, I, w);
                for (const f of b.forks)
                    glowStroke(cr, f, BOLT, I * 0.8, w * 0.5);
            });

            // Electric ring around the entry point.
            const rl = seg(t, 0, 0.6);
            if (rl < 1)
                glowStroke(cr, circlePts(25 + 45 * easeOut(rl), 36, 7), PURPLE, 1 - rl, 1.4);

            // Sparks splashing off where the second strike lands.
            const sl = seg(t, 0.19, 0.8);
            if (sl > 0 && sl < 1) {
                strikes[1].forEach((b, i) => {
                    const [ex, ey] = b.end;
                    for (const s of endSparks[i]) {
                        const sp = Math.max(0, sl - 0.1);
                        const d = s.d * easeOut(sl), dp = s.d * easeOut(sp);
                        trailDot(cr, ex + Math.cos(s.a) * d, ey + Math.sin(s.a) * d + 60 * sl * sl,
                            ex + Math.cos(s.a) * dp, ey + Math.sin(s.a) * dp + 60 * sp * sp, s.size, BOLT, 1 - sl);
                    }
                    glow(cr, ex, ey, 40, BOLT, 0.6 * (1 - sl));
                });
            }
        },
    };
}

// =====================================================================
// 4. WARP — exit: light is sucked into the edge. entry: warp-drive beam.
// =====================================================================
const WARP_BLUE = [0.55, 0.85, 1];
const WARP_PINK = [1, 0.5, 0.85];

function warpExit() {
    const streaks = Array.from({length: 22}, () => ({
        y: rand(-60, 60), x: -rand(90, 280), delay: rand(0, 0.35), c: pick([WARP_BLUE, WARP_BLUE, WARP_PINK]),
    }));
    return {
        duration: 480, fwd: 1, back: 290, half: 80,
        draw(cr, t) {
            for (const s of streaks) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const k = easeIn(lt);
                const head = s.x * (1 - k), y = s.y * (1 - k * 0.85);
                const tail = head - (10 + 90 * k);
                const lg = new Cairo.LinearGradient(tail, 0, head, 0);
                lg.addColorStopRGBA(0, s.c[0], s.c[1], s.c[2], 0);
                lg.addColorStopRGBA(1, 1, 1, 1, 0.8 * Math.min(1, lt * 3));
                cr.setSource(lg);
                setLW(cr, 1.4);
                cr.moveTo(tail, y);
                cr.lineTo(head, y);
                cr.stroke();
            }
            glow(cr, 0, 0, 20 + 40 * t, WARP_BLUE, 0.6 * t * (1 - seg(t, 0.85, 1)));
        },
    };
}

function warpEntry() {
    const streaks = Array.from({length: 60}, () => {
        const g = (Math.random() + Math.random() + Math.random()) / 3 - 0.5; // bunched in the middle
        return {y: g * 330, speed: rand(450, 950), len: rand(90, 300), delay: rand(0, 0.28), w: rand(0.8, 2.2)};
    });
    const rings = [0, 0.12, 0.24].map(d => ({delay: d}));
    return {
        duration: 780, fwd: 1050, back: 0, half: 180,
        draw(cr, t) {
            // Burst at the entry point, stretched along the travel direction.
            const b = seg(t, 0, 0.3);
            cr.save();
            cr.scale(2.6, 1);
            glow(cr, 0, 0, 70, WARP_BLUE, 0.9 * (1 - b));
            glow(cr, 0, 0, 30, WHITE, 1 - b);
            cr.restore();

            // Central beam fires across the screen. It thins out toward its
            // tip, and the whole beam dissolves from the far end backwards,
            // so it never ends in a hard edge.
            const front = 900 * easeOut(seg(t, 0, 0.32));
            const bw = 7 * (1 - seg(t, 0.25, 1));
            const ba = 1 - seg(t, 0.4, 0.95);
            const reach = front * (1 - 0.85 * easeIn(seg(t, 0.35, 1)));
            if (ba > 0 && reach > 4) {
                cr.setLineCap(Cairo.LineCap.BUTT);
                for (const [mul, c, al] of [[7, WARP_BLUE, 0.08], [3.5, WARP_BLUE, 0.22], [1.6, WARP_BLUE, 0.6], [0.55, WHITE, 1]]) {
                    const lg = new Cairo.LinearGradient(0, 0, reach, 0);
                    lg.addColorStopRGBA(0, c[0], c[1], c[2], al * ba);
                    lg.addColorStopRGBA(0.55, c[0], c[1], c[2], al * ba * 0.8);
                    lg.addColorStopRGBA(1, c[0], c[1], c[2], 0);
                    cr.setSource(lg);
                    setLW(cr, Math.max(0.6, bw * mul));
                    cr.moveTo(0, 0);
                    cr.lineTo(reach, 0);
                    cr.stroke();
                }
            }
            glow(cr, front, 0, 45, WHITE, 0.9 * (1 - seg(t, 0.2, 0.4)));

            // Warp rings pushed forward.
            for (const r of rings) {
                const lt = seg(t, r.delay, r.delay + 0.55);
                if (lt <= 0 || lt >= 1) continue;
                const cx = 380 * easeOut(lt), rad = 30 + 130 * lt;
                cr.save();
                cr.translate(cx, 0);
                cr.scale(0.3, 1);
                cr.arc(0, 0, rad, 0, TAU);
                cr.restore();
                setLW(cr, 3 * (1 - lt) + 0.5);
                cr.setSourceRGBA(WARP_PINK[0], WARP_PINK[1], WARP_PINK[2], 0.8 * (1 - lt));
                cr.stroke();
            }

            // Light-speed streaks with a chromatic (RGB split) edge.
            for (const s of streaks) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const head = s.speed * easeOut(lt);
                const tail = Math.max(0, head - s.len * (1 - lt * 0.5));
                if (head - tail < 2) continue;
                // Fade out with time and as streaks near the far end, so none get cut off.
                const a = (1 - seg(lt, 0.55, 1)) * (1 - seg(head, 750, 1000));
                if (a <= 0) continue;
                for (const [dy, c, al, w] of [[-1.6, WARP_PINK, 0.45, s.w], [1.6, WARP_BLUE, 0.45, s.w], [0, WHITE, 0.95, s.w * 0.7]]) {
                    const lg = new Cairo.LinearGradient(tail, 0, head, 0);
                    lg.addColorStopRGBA(0, c[0], c[1], c[2], 0);
                    lg.addColorStopRGBA(1, c[0], c[1], c[2], al * a);
                    cr.setSource(lg);
                    setLW(cr, w);
                    cr.moveTo(tail, s.y + dy);
                    cr.lineTo(head, s.y + dy);
                    cr.stroke();
                }
            }
        },
    };
}

// =====================================================================
// 5. INFERNO — exit: a few drifting embers. entry: fireball blast.
// =====================================================================
const EMBER_HOT = [1, 0.92, 0.55];
const EMBER_MID = [1, 0.55, 0.12];
const EMBER_COOL = [0.85, 0.15, 0.05];
const emberColor = k => (k < 0.5 ? mix(EMBER_HOT, EMBER_MID, k * 2) : mix(EMBER_MID, EMBER_COOL, (k - 0.5) * 2));

function fireBlob(cr, x, y, r, a) {
    if (a <= 0.003 || r <= 0.5) return;
    const g = new Cairo.RadialGradient(x, y, 0, x, y, r);
    g.addColorStopRGBA(0, 1, 1, 0.85, a);
    g.addColorStopRGBA(0.25, 1, 0.85, 0.3, a * 0.95);
    g.addColorStopRGBA(0.55, 1, 0.45, 0.08, a * 0.7);
    g.addColorStopRGBA(0.8, 0.8, 0.12, 0.03, a * 0.3);
    g.addColorStopRGBA(1, 0.5, 0.05, 0, 0);
    cr.setSource(g);
    cr.arc(x, y, r, 0, TAU);
    cr.fill();
}

function infernoExit() {
    const embers = Array.from({length: 14}, () => ({
        x: rand(-20, 0), y: rand(-45, 45), dx: -rand(15, 50), rise: rand(40, 100),
        size: rand(1.2, 2.6), delay: rand(0, 0.35), wob: rand(0, TAU),
    }));
    return {
        duration: 700, fwd: 1, back: 120, half: 150,
        draw(cr, t) {
            glow(cr, 0, 0, 45, EMBER_MID, 0.4 * (1 - t));
            for (const e of embers) {
                const lt = seg(t, e.delay, 1);
                if (lt <= 0) continue;
                const x = e.x + e.dx * easeOut(lt) + Math.sin(e.wob + lt * 9) * 4;
                const y = e.y - e.rise * lt;
                const flick = rand(0.6, 1);
                glow(cr, x, y, e.size * 5, emberColor(lt), (1 - lt) * flick);
                glow(cr, x, y, e.size, WHITE, (1 - lt) * flick);
            }
        },
    };
}

function infernoEntry() {
    const blobs = Array.from({length: 6}, () => ({a: rand(0, TAU), d: rand(0.3, 0.65), r: rand(0.35, 0.6), spin: rand(-2, 2)}));
    const embers = Array.from({length: 42}, () => ({
        a: rand(-1.5, 1.5), v: rand(100, 340), size: rand(1.2, 3.4), delay: rand(0, 0.15), rise: rand(40, 140),
    }));
    const smoke = Array.from({length: 6}, () => ({
        x: rand(30, 160), y: rand(-90, 90), r: rand(25, 60), rise: rand(40, 110), delay: rand(0.25, 0.45),
    }));
    const shock = circlePts(1, 40, 0.01); // built once, not every frame
    const emberPos = (e, lt) => [Math.cos(e.a) * e.v * easeOut(lt), Math.sin(e.a) * e.v * easeOut(lt) - e.rise * lt * lt];
    return {
        duration: 1100, fwd: 400, back: 0, half: 320,
        draw(cr, t) {
            cr.setLineCap(Cairo.LineCap.ROUND);
            // Smoke behind the fire.
            for (const s of smoke) {
                const lt = seg(t, s.delay, 1);
                if (lt <= 0) continue;
                const g = new Cairo.RadialGradient(s.x, s.y - s.rise * lt, 0, s.x, s.y - s.rise * lt, s.r * (1 + lt));
                g.addColorStopRGBA(0, 0.25, 0.22, 0.22, 0.2 * Math.sin(Math.PI * lt));
                g.addColorStopRGBA(1, 0.25, 0.22, 0.22, 0);
                cr.setSource(g);
                cr.arc(s.x, s.y - s.rise * lt, s.r * (1 + lt), 0, TAU);
                cr.fill();
            }

            // Heat shockwave.
            const sl = seg(t, 0, 0.5);
            if (sl < 1)
                glowStroke(cr, shock.map(([x, y]) => [x * 300 * easeOut(sl), y * 300 * easeOut(sl)]),
                    EMBER_MID, 0.8 * (1 - sl), 5 * (1 - sl) + 0.5);

            // Turbulent fireball.
            const grow = easeOut(seg(t, 0, 0.35)), A = 1 - seg(t, 0.32, 1);
            const R = 30 + 135 * grow, cx = 50 * easeOut(t);
            fireBlob(cr, cx, 0, R * 1.25, A * 0.8);
            for (const b of blobs) {
                const a = b.a + b.spin * t;
                fireBlob(cr, cx + Math.cos(a) * R * b.d, Math.sin(a) * R * b.d - 30 * t, R * b.r, A * 0.75);
            }
            glow(cr, cx, 0, R * 0.5, WHITE, 0.9 * (1 - seg(t, 0, 0.4)));

            // Flying embers with trails.
            for (const e of embers) {
                const lt = seg(t, e.delay, 1);
                if (lt <= 0) continue;
                const [x, y] = emberPos(e, lt), [px, py] = emberPos(e, Math.max(0, lt - 0.06));
                const c = emberColor(lt), a = (1 - lt) * 0.9, w = e.size * (1 - lt * 0.5);
                cr.moveTo(px, py);
                cr.lineTo(x, y);
                setLW(cr, w * 3);
                cr.setSourceRGBA(c[0], c[1], c[2], a * 0.3);
                cr.stroke();
                cr.moveTo(px, py);
                cr.lineTo(x, y);
                setLW(cr, w);
                cr.setSourceRGBA(1, 0.95, 0.8, a);
                cr.stroke();
            }
        },
    };
}

// =====================================================================
// 6. GLITCH — exit: pixels disintegrate. entry: digital glitch burst.
// =====================================================================
const G_GREEN = [0.2, 1, 0.6];
const G_CYAN = [0.2, 0.9, 1];
const G_MAG = [1, 0.25, 0.8];
const snap = (v, g) => Math.round(v / g) * g;

function glitchExit() {
    const px = Array.from({length: 34}, () => ({
        x: snap(rand(-40, 0), 4), y: snap(rand(-45, 45), 4), dx: -rand(20, 90), dy: rand(-20, 20),
        size: pick([3, 4, 5, 6]), delay: rand(0, 0.4), c: pick([G_GREEN, G_CYAN, WHITE]),
    }));
    return {
        duration: 520, fwd: 1, back: 150, half: 110,
        draw(cr, t) {
            for (const p of px) {
                const lt = seg(t, p.delay, 1);
                if (lt <= 0 || Math.random() < 0.15) continue;
                const x = snap(p.x + p.dx * lt, 3), y = snap(p.y + p.dy * lt, 3);
                cr.setSourceRGBA(p.c[0], p.c[1], p.c[2], 0.85 * (1 - lt));
                cr.rectangle(x, y, p.size, p.size);
                cr.fill();
            }
        },
    };
}

function glitchEntry() {
    const bars = Array.from({length: 30}, () => {
        const on = [];
        for (let i = 0; i < 3; i++) {
            const s = rand(0, 0.6);
            on.push([s, s + rand(0.04, 0.15)]);
        }
        return {x: snap(rand(0, 260), 4), y: snap(rand(-150, 150), 4), w: snap(rand(20, 190), 4),
            h: pick([2, 3, 4, 6, 10, 14]), on, c: pick([G_GREEN, G_CYAN, WHITE])};
    });
    const px = Array.from({length: 70}, () => ({
        a: rand(-1.4, 1.4), v: rand(60, 300), size: pick([3, 4, 6, 8]), delay: rand(0, 0.12),
        c: pick([G_GREEN, G_CYAN, G_MAG, WHITE]),
    }));
    const rgbRect = (x, y, w, h, off, c, a) => {
        for (const [dx, cc, al] of [[-off, G_MAG, 0.6], [off, G_CYAN, 0.6], [0, c, 0.95]]) {
            cr_.setSourceRGBA(cc[0], cc[1], cc[2], al * a);
            cr_.rectangle(x + dx, y, w, h);
            cr_.fill();
        }
    };
    let cr_ = null;
    return {
        duration: 850, fwd: 400, back: 0, half: 240,
        draw(cr, t) {
            cr_ = cr;
            const fade = 1 - seg(t, 0.6, 1);
            glow(cr, 0, 0, 120, G_GREEN, 0.5 * (1 - seg(t, 0, 0.4)));

            // Scanlines.
            const sc = 0.12 * (1 - seg(t, 0, 0.7));
            if (sc > 0) {
                setLW(cr, 1);
                cr.setSourceRGBA(G_GREEN[0], G_GREEN[1], G_GREEN[2], sc);
                for (let y = -140; y <= 140; y += 5) {
                    cr.moveTo(0, y + 0.5);
                    cr.lineTo(280 * easeOut(seg(t, 0, 0.25)), y + 0.5);
                }
                cr.stroke();
            }

            // Expanding pixel-square shockwave.
            const ql = seg(t, 0, 0.55);
            if (ql < 1) {
                const s = snap(20 + 240 * easeOut(ql), 4);
                setLW(cr, 3);
                for (const [d, c] of [[-3, G_MAG], [3, G_CYAN], [0, WHITE]]) {
                    cr.setSourceRGBA(c[0], c[1], c[2], 0.8 * (1 - ql));
                    cr.rectangle(-s / 2 + d, -s / 2, s, s);
                    cr.stroke();
                }
            }

            // Flickering glitch slices with RGB split.
            for (const b of bars) {
                if (!b.on.some(([s, e]) => t >= s && t <= e)) continue;
                const off = snap(rand(2, 9) * (1 - t), 1) || 1;
                rgbRect(b.x + snap(rand(-10, 10), 4), b.y, b.w, b.h, off, b.c, fade);
            }

            // Pixels bursting outward in steps.
            for (const p of px) {
                const lt = seg(t, p.delay, 1);
                if (lt <= 0 || Math.random() < 0.12) continue;
                const d = snap(p.v * easeOut(lt), 6);
                const x = snap(Math.cos(p.a) * d, 4), y = snap(Math.sin(p.a) * d, 4);
                cr.setSourceRGBA(p.c[0], p.c[1], p.c[2], 0.9 * (1 - lt));
                cr.rectangle(x, y, p.size, p.size);
                cr.fill();
            }
        },
    };
}

export const EFFECTS = {
    teleport: {exit: teleportExit, entry: teleportEntry},
    shatter: {exit: shatterExit, entry: shatterEntry},
    lightning: {exit: lightningExit, entry: lightningEntry},
    warp: {exit: warpExit, entry: warpEntry},
    inferno: {exit: infernoExit, entry: infernoEntry},
    glitch: {exit: glitchExit, entry: glitchEntry},
};
