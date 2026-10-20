// Terminal FX: Cairo scenes for git commands and long-command fireworks.
// A scene is {duration, x, y, w, h, draw(cr, t)}: a canvas of w x h placed at
// (x, y) inside the monitor, all in "design units" (a 1080p screen; the
// extension scales them to the real monitor). t goes 0 -> 1. Scenes that are
// a group of pieces (fireworks) return a list with a `delay` (ms) on each.

import Cairo from 'cairo';
import {
    TAU, WHITE, rand, pick, seg, easeOut, easeIn, easeInOut, lerp,
    glow, puff, disc, ring, glowStroke, jagged, makeExplosion, drawExplosion,
} from './draw.js';

const GREEN = [0.25, 0.9, 0.5];
const RED = [1, 0.25, 0.25];
const SMOKE = [0.82, 0.82, 0.85];
const DARK_SMOKE = [0.2, 0.19, 0.2];

// ---------- The rocket ----------

const ROCKET = 1.35; // drawn about 130 units long, then scaled up

// Rocket centred on (x, y), nose pointing along `ang` (0 = straight up).
// flame: 0..1 engine power. legs: 0..1 landing legs out.
function drawRocket(cr, x, y, ang, flame = 0, legs = 0, alpha = 1) {
    if (alpha <= 0.01)
        return;
    cr.save();
    cr.translate(x, y);
    cr.rotate(ang);
    cr.scale(ROCKET, ROCKET);

    if (flame > 0.02) {
        const len = (34 + 46 * flame) * rand(0.85, 1.15);
        glow(cr, 0, 52 + len * 0.4, len * 0.9, [1, 0.5, 0.1], 0.55 * flame * alpha);
        cr.moveTo(-11, 46);
        cr.curveTo(-13, 46 + len * 0.5, -3, 46 + len * 0.85, 0, 46 + len);
        cr.curveTo(3, 46 + len * 0.85, 13, 46 + len * 0.5, 11, 46);
        cr.closePath();
        cr.setSourceRGBA(1, 0.55, 0.12, 0.9 * flame * alpha);
        cr.fill();
        cr.moveTo(-6, 46);
        cr.curveTo(-7, 46 + len * 0.35, -1, 46 + len * 0.55, 0, 46 + len * 0.62);
        cr.curveTo(1, 46 + len * 0.55, 7, 46 + len * 0.35, 6, 46);
        cr.closePath();
        cr.setSourceRGBA(1, 0.95, 0.7, flame * alpha);
        cr.fill();
    }

    // Landing legs.
    if (legs > 0) {
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(3.5);
        cr.setSourceRGBA(0.55, 0.57, 0.62, alpha);
        for (const sx of [-1, 1]) {
            cr.moveTo(sx * 12, 26);
            cr.lineTo(sx * (14 + 16 * legs), 40 + 14 * legs);
            cr.stroke();
        }
    }

    // Fins.
    cr.setSourceRGBA(0.86, 0.2, 0.25, alpha);
    for (const sx of [-1, 1]) {
        cr.moveTo(sx * 15, 6);
        cr.curveTo(sx * 30, 20, sx * 32, 34, sx * 30, 46);
        cr.lineTo(sx * 15, 38);
        cr.closePath();
        cr.fill();
    }

    // Body with a little side shading.
    cr.moveTo(0, -66);
    cr.curveTo(16, -48, 18, -22, 17, 0);
    cr.lineTo(15, 42);
    cr.lineTo(-15, 42);
    cr.lineTo(-17, 0);
    cr.curveTo(-18, -22, -16, -48, 0, -66);
    cr.closePath();
    const body = new Cairo.LinearGradient(-18, 0, 18, 0);
    body.addColorStopRGBA(0, 0.72, 0.74, 0.8, alpha);
    body.addColorStopRGBA(0.4, 0.98, 0.98, 1, alpha);
    body.addColorStopRGBA(1, 0.62, 0.64, 0.7, alpha);
    cr.setSource(body);
    cr.fill();

    // Nose cone.
    cr.moveTo(0, -66);
    cr.curveTo(10, -55, 13, -46, 14, -38);
    cr.lineTo(-14, -38);
    cr.curveTo(-13, -46, -10, -55, 0, -66);
    cr.closePath();
    cr.setSourceRGBA(0.86, 0.2, 0.25, alpha);
    cr.fill();

    // Window.
    disc(cr, 0, -14, 8.5, [0.3, 0.32, 0.38], alpha);
    disc(cr, 0, -14, 6, [0.35, 0.75, 1], alpha);
    disc(cr, -2, -16, 2, WHITE, 0.8 * alpha);

    // Nozzle.
    cr.moveTo(-9, 42);
    cr.lineTo(9, 42);
    cr.lineTo(12, 48);
    cr.lineTo(-12, 48);
    cr.closePath();
    cr.setSourceRGBA(0.35, 0.36, 0.4, alpha);
    cr.fill();
    cr.restore();
}

// Where the exhaust comes out, for a rocket at (x, y) turned by ang.
const exhaustAt = (x, y, ang, d = 56 * ROCKET) => [x - Math.sin(ang) * d, y + Math.cos(ang) * d];

// A trail of smoke puffs. emit(i) is called once per puff to pick where and
// when (in t) it was released; the puff then grows and fades with age.
function makeTrail(n, life, emit) {
    return Array.from({length: n}, (_, i) => ({...emit(i / n), life, drift: rand(-26, 26)}));
}

function drawTrail(cr, trail, t, fadeAll = 1) {
    for (const p of trail) {
        const age = (t - p.t) / p.life;
        if (age <= 0 || age >= 1)
            continue;
        puff(cr, p.x + p.drift * age, p.y + p.rise * age, p.r0 + p.grow * age,
            p.c, p.a * (1 - age) * fadeAll);
    }
}

// Ground smoke billowing sideways from the launch pad / landing spot.
function makeGroundCloud(n) {
    return Array.from({length: n}, () => ({
        dir: pick([-1, 1]), dist: rand(40, 210), r: rand(18, 40), d: rand(0, 0.5),
    }));
}

function drawGroundCloud(cr, cloud, x, y, k, a = 1) {
    if (k <= 0)
        return;
    for (const p of cloud) {
        const lk = seg(k, p.d, 1);
        if (lk <= 0)
            continue;
        puff(cr, x + p.dir * p.dist * easeOut(lk), y - 8 - 14 * lk, p.r * (0.5 + lk),
            SMOKE, 0.6 * a * Math.sin(Math.PI * lk));
    }
}

// git push worked: the rocket lifts off and flies off the top of the screen.
export function rocketLaunch(W, H) {
    const w = 520, cx = w / 2, pad = H - 100;
    const climb = p => pad - (pad + 220) * p * p;           // accelerating
    const ground = makeGroundCloud(26);
    const trail = makeTrail(70, 0.4, f => {
        const t = lerp(0.2, 0.8, f);
        const [x, y] = exhaustAt(cx, climb(seg(t, 0.2, 0.8)), 0);
        return {t, x, y, rise: rand(-10, 30), r0: rand(8, 14), grow: rand(30, 60), c: SMOKE, a: 0.55};
    });
    return {
        duration: 3200, x: W / 2 - cx, y: 0, w, h: H,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.82, 1);
            drawGroundCloud(cr, ground, cx, H - 40, seg(t, 0.05, 0.9), fade);
            drawTrail(cr, trail, t, fade);
            const ign = seg(t, 0, 0.2);
            glow(cr, cx, H - 50, 140, [1, 0.6, 0.2], 0.4 * ign * (1 - seg(t, 0.2, 0.5)));
            const shake = t < 0.2 ? rand(-1.5, 1.5) * ign : 0;
            const y = climb(seg(t, 0.2, 0.8));
            if (y > -150)
                drawRocket(cr, cx + shake, y, 0, t < 0.2 ? ign * 0.7 : 1);
        },
    };
}

// git push failed: lifts off, sputters, flips over and crashes back down.
export function rocketLaunchCrash(W, H) {
    const w = 860, cx = 320, pad = H - 100, apex = H * 0.32, ground = H - 50;
    const ex = makeExplosion(1);
    const groundCloud = makeGroundCloud(20);
    // Where the rocket is, as [x, y, angle].
    const at = t => {
        if (t < 0.15)
            return [cx, pad, 0];
        if (t < 0.45)
            return [cx, lerp(pad, apex, easeOut(seg(t, 0.15, 0.45))), Math.sin(t * 60) * 0.04];
        if (t < 0.6) {
            const p = seg(t, 0.45, 0.6);
            return [cx + 70 * p, apex - 30 * Math.sin(Math.PI * p), Math.PI * easeInOut(p)];
        }
        const p = seg(t, 0.6, 0.76);
        return [cx + 70 + 70 * p, lerp(apex, ground - 60, p * p), Math.PI + Math.sin(p * 30) * 0.08];
    };
    const trail = makeTrail(70, 0.35, f => {
        const t = lerp(0.15, 0.76, f);
        const [x, y, a] = at(t);
        const [ex2, ey] = exhaustAt(x, y, a);
        const sick = t > 0.33;
        return {t, x: ex2, y: ey, rise: rand(-20, 10), r0: rand(8, 13), grow: rand(25, 50),
            c: sick ? DARK_SMOKE : SMOKE, a: sick ? 0.6 : 0.5};
    });
    return {
        duration: 4400, x: W / 2 - cx, y: 0, w, h: H,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.9, 1);
            drawGroundCloud(cr, groundCloud, cx, H - 40, seg(t, 0.03, 0.6), fade);
            drawTrail(cr, trail, t, fade);
            if (t < 0.76) {
                const [x, y, a] = at(t);
                // Engine: full power, then coughing, then dead.
                let flame = t < 0.15 ? seg(t, 0, 0.15) * 0.7 : 1;
                if (t > 0.33)
                    flame = t < 0.47 && Math.random() < 0.5 ? rand(0.2, 0.7) : 0;
                drawRocket(cr, x, y, a, flame);
            } else {
                const [x] = at(0.76);
                drawExplosion(cr, x, ground, ex, seg(t, 0.76, 1));
            }
        },
    };
}

// git pull worked: the rocket comes down from the top and lands softly.
export function rocketLand(W, H) {
    const w = 520, cx = w / 2, pad = H - 100;
    const descend = p => lerp(-160, pad, easeOut(p));
    const dust = makeGroundCloud(24);
    const trail = makeTrail(60, 0.35, f => {
        const t = lerp(0, 0.68, f);
        const [x, y] = exhaustAt(cx, descend(seg(t, 0, 0.7)), 0);
        return {t, x, y, rise: rand(-10, 25), r0: rand(7, 12), grow: rand(25, 45), c: SMOKE, a: 0.45};
    });
    return {
        duration: 3400, x: W / 2 - cx, y: 0, w, h: H,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.85, 1);
            drawTrail(cr, trail, t, fade);
            drawGroundCloud(cr, dust, cx, H - 40, seg(t, 0.55, 1), fade);
            const p = seg(t, 0, 0.7);
            // Squash a little on touchdown.
            const bump = t > 0.7 ? Math.sin(seg(t, 0.7, 0.8) * Math.PI) * 4 : 0;
            const flame = t < 0.7 ? 0.45 + 0.55 * seg(p, 0.5, 0.9) : 1 - seg(t, 0.7, 0.75);
            drawRocket(cr, cx, descend(p) + bump, 0, flame, seg(p, 0.55, 0.85), fade);
        },
    };
}

// git pull failed: comes down, the engine cuts out, and it crashes.
export function rocketLandCrash(W, H) {
    const w = 860, cx = 380, ground = H - 50, stall = H * 0.5;
    const ex = makeExplosion(1);
    const at = t => {
        if (t < 0.42)
            return [cx, lerp(-160, stall, easeOut(seg(t, 0, 0.42))), 0];
        if (t < 0.55)
            return [cx + Math.sin(t * 80) * 3, stall + 20 * seg(t, 0.42, 0.55), Math.sin(t * 50) * 0.12];
        const p = seg(t, 0.55, 0.74);
        return [cx + 50 * p, lerp(stall + 20, ground - 55, p * p), 0.7 * p];
    };
    const trail = makeTrail(60, 0.33, f => {
        const t = lerp(0, 0.74, f);
        const [x, y, a] = at(t);
        const [ex2, ey] = exhaustAt(x, y, a);
        const sick = t > 0.4;
        return {t, x: ex2, y: ey, rise: rand(-25, 5), r0: rand(7, 12), grow: rand(25, 45),
            c: sick ? DARK_SMOKE : SMOKE, a: sick ? 0.6 : 0.45};
    });
    return {
        duration: 3800, x: W / 2 - cx, y: 0, w, h: H,
        draw(cr, t) {
            drawTrail(cr, trail, t, 1 - seg(t, 0.9, 1));
            if (t < 0.74) {
                const [x, y, a] = at(t);
                let flame = 0.6;
                if (t > 0.4)
                    flame = t < 0.55 && Math.random() < 0.45 ? rand(0.2, 0.6) : 0;
                drawRocket(cr, x, y, a, flame);
            } else {
                drawExplosion(cr, at(0.74)[0], ground, ex, seg(t, 0.74, 1));
            }
        },
    };
}

// ---------- git commit: a stamp slams down ----------

export function commitStamp(W, H, ok) {
    const size = 360, c = size / 2;
    const col = ok ? GREEN : RED;
    const sparks = Array.from({length: 18}, () => ({a: rand(0, TAU), v: rand(70, 160), r: rand(1.5, 3)}));
    const crack = ok ? null : jagged(-70, -60, 60, 70, 0.3, 4);
    return {
        duration: 2000, x: W / 2 - c, y: 40, w: size, h: size,
        draw(cr, t) {
            const drop = seg(t, 0, 0.22);
            const hit = seg(t, 0.22, 0.6);
            const fade = 1 - seg(t, 0.8, 1);
            const scale = lerp(2.2, 1, easeIn(drop));
            const a = Math.min(1, drop * 3) * fade;
            const shake = !ok && t > 0.22 && t < 0.45 ? Math.sin(t * 160) * 5 * (1 - seg(t, 0.22, 0.45)) : 0;
            if (hit > 0 && hit < 1) {
                ring(cr, c, c, 70 + 90 * easeOut(hit), 6 * (1 - hit), col, 0.8 * (1 - hit));
                glow(cr, c, c, 150, col, 0.5 * (1 - hit));
                for (const s of sparks) {
                    const d = 74 + s.v * easeOut(hit);
                    disc(cr, c + Math.cos(s.a) * d, c + Math.sin(s.a) * d, s.r, col, 1 - hit);
                }
            }
            cr.save();
            cr.translate(c + shake, c);
            cr.scale(scale, scale);
            // Badge: filled disc with a double ring.
            disc(cr, 0, 0, 72, [0.08, 0.1, 0.12], 0.85 * a);
            ring(cr, 0, 0, 66, 5, col, a);
            ring(cr, 0, 0, 56, 2, col, 0.7 * a);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineWidth(11);
            cr.setSourceRGBA(col[0], col[1], col[2], a);
            if (ok) {
                cr.moveTo(-28, 2);
                cr.lineTo(-8, 22);
                cr.lineTo(30, -20);
            } else {
                cr.moveTo(-24, -24);
                cr.lineTo(24, 24);
                cr.moveTo(24, -24);
                cr.lineTo(-24, 24);
            }
            cr.stroke();
            if (crack && t > 0.22)
                glowStroke(cr, crack, RED, a * 0.9, 2.2, seg(t, 0.22, 0.4));
            cr.restore();
        },
    };
}

// ---------- git merge: two branches join (or collide) ----------

export function mergeScene(W, H, ok) {
    const w = 700, h = 420, mx = w / 2, my = 190;
    const L = [[60, 400], [130, 330], [260, 300], [mx, my]];
    const R = [[w - 60, 400], [w - 130, 330], [w - 260, 300], [mx, my]];
    const curve = (p, n = 30) => Array.from({length: n + 1}, (_, i) => {
        const k = i / n, u = 1 - k;
        return [
            u * u * u * p[0][0] + 3 * u * u * k * p[1][0] + 3 * u * k * k * p[2][0] + k * k * k * p[3][0],
            u * u * u * p[0][1] + 3 * u * u * k * p[1][1] + 3 * u * k * k * p[2][1] + k * k * k * p[3][1],
        ];
    });
    const left = curve(L), right = curve(R);
    const up = [[mx, my], [mx, 30]];
    const sparks = Array.from({length: 26}, () => ({a: rand(0, TAU), v: rand(50, 170), r: rand(1.5, 3.2)}));
    const bolts = ok ? [] : [jagged(mx - 30, my, mx + 30, my, 0.6, 4), jagged(mx - 26, my - 14, mx + 26, my + 12, 0.6, 4)];
    const CYAN = [0.35, 0.8, 1], VIOLET = [0.75, 0.45, 1];
    return {
        duration: 2400, x: W / 2 - mx, y: 50, w, h,
        draw(cr, t) {
            const fade = 1 - seg(t, 0.8, 1);
            const grow = easeInOut(seg(t, 0, 0.42));
            const meet = seg(t, 0.42, 0.8);
            if (ok) {
                glowStroke(cr, left, CYAN, fade, 3.2, grow);
                glowStroke(cr, right, VIOLET, fade, 3.2, grow);
                if (meet > 0) {
                    glowStroke(cr, up, GREEN, fade, 4.2, easeOut(seg(t, 0.42, 0.65)));
                    ring(cr, mx, my, 20 + 110 * easeOut(meet), 4 * (1 - meet), GREEN, 1 - meet);
                    glow(cr, mx, my, 120, GREEN, 0.7 * (1 - meet));
                }
            } else {
                // They stop short of each other, then spark and pull back.
                const reach = Math.min(grow, 0.94) * (1 - 0.35 * easeOut(seg(t, 0.5, 0.8)));
                glowStroke(cr, left, CYAN, fade, 3.2, reach);
                glowStroke(cr, right, VIOLET, fade, 3.2, reach);
                if (meet > 0 && meet < 1) {
                    for (const b of bolts)
                        glowStroke(cr, b, RED, (Math.random() < 0.7 ? 1 : 0.3) * (1 - meet), 2);
                    glow(cr, mx, my, 130, RED, 0.6 * (1 - meet));
                }
            }
            if (meet > 0 && meet < 1) {
                for (const s of sparks) {
                    const d = s.v * easeOut(meet);
                    disc(cr, mx + Math.cos(s.a) * d, my + Math.sin(s.a) * d + 60 * meet * meet,
                        s.r, ok ? [0.8, 1, 0.85] : [1, 0.6, 0.3], 1 - meet);
                }
            }
        },
    };
}

// ---------- Fireworks for long commands ----------

const FIREWORK_COLORS = [
    [1, 0.3, 0.4], [1, 0.82, 0.25], [0.3, 0.9, 0.55], [0.3, 0.75, 1],
    [0.75, 0.5, 1], [1, 0.55, 0.2], [1, 1, 1],
];

// One rocket shell rising and bursting at (bx, by) of the monitor.
function firework(bx, by, R, delay, gold = false) {
    const rise = 320, pad = 12;
    const w = 2 * (R + pad), h = 2 * R + rise + pad;
    const cx = w / 2, cy = R + pad;                       // burst point inside the canvas
    const col = gold ? [1, 0.78, 0.35] : pick(FIREWORK_COLORS);
    const col2 = Math.random() < 0.4 ? pick(FIREWORK_COLORS) : col;
    const n = gold ? 110 : Math.round(rand(70, 100));
    const parts = Array.from({length: n}, (_, i) => ({
        a: (i / n) * TAU + rand(-0.05, 0.05), v: R * rand(0.7, 1), r: rand(2, 3.2),
        c: Math.random() < 0.5 ? col : col2, tw: rand(0, TAU),
    }));
    const RISE = 0.22;
    return {
        delay, duration: gold ? 2600 : 2000, x: bx - cx, y: by - cy, w, h,
        draw(cr, t) {
            if (t < RISE) {
                const p = easeOut(t / RISE);
                const y = lerp(cy + rise, cy, p);
                glowStroke(cr, [[cx, y + 34 * (1 - p) + 6], [cx, y]], col, 0.8, 2);
                return;
            }
            const k = seg(t, RISE, 1);
            if (k < 0.25)
                glow(cr, cx, cy, R * 0.9, col, 0.5 * (1 - k / 0.25));
            const fall = gold ? 0.55 : 0.3;      // gold "willow" droops further
            for (const p of parts) {
                const d = p.v * easeOut(Math.min(1, k * 1.6));
                const drop = R * fall * k * k;
                const x = cx + Math.cos(p.a) * d, y = cy + Math.sin(p.a) * d + drop;
                const a = (1 - k * k) * (k > 0.5 ? 0.6 + 0.4 * Math.sin(p.tw + k * 40) : 1);
                // Short streak behind each spark.
                const d2 = p.v * easeOut(Math.max(0, k * 1.6 - 0.12));
                const x2 = cx + Math.cos(p.a) * d2, y2 = cy + Math.sin(p.a) * d2 + R * fall * Math.max(0, k - 0.05) ** 2;
                cr.setLineWidth(p.r * 1.3);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setSourceRGBA(p.c[0], p.c[1], p.c[2], a * 0.45);
                cr.moveTo(x2, y2);
                cr.lineTo(x, y);
                cr.stroke();
                disc(cr, x, y, p.r, a > 0.6 ? [1, 1, 1] : p.c, a);
            }
        },
    };
}

// tier 1: a few bursts across the top. tier 2: a long show with a gold finale.
export function fireworks(W, H, tier) {
    const out = [];
    const count = tier >= 2 ? 24 : 9;
    const span = tier >= 2 ? 4200 : 2400;
    // Spread across the width, but fired in a shuffled order.
    const slots = Array.from({length: count}, (_, i) => i).sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
        const R = tier >= 2 ? rand(200, 300) : rand(160, 220);
        const bx = lerp(W * 0.12, W * 0.88, (slots[i] + rand(0.15, 0.85)) / count);
        const by = rand(H * 0.16, H * (tier >= 2 ? 0.42 : 0.34));
        out.push(firework(bx, by, R, Math.round((i / count) * span + rand(0, 200))));
    }
    if (tier >= 2) {
        // Gold finale: a row of big willows all at once.
        for (let i = 0; i < 6; i++)
            out.push(firework(W * (0.12 + 0.152 * i), H * rand(0.2, 0.3), 300, span + 300 + i * 70, true));
    }
    // Keep everything on the screen.
    for (const f of out) {
        f.x = Math.max(-f.w * 0.1, Math.min(W - f.w * 0.9, f.x));
        f.y = Math.max(0, f.y);
    }
    return out;
}

// Every scene by name, for previews and tests.
export const SCENES = {
    'push-success': (W, H) => rocketLaunch(W, H),
    'push-fail': (W, H) => rocketLaunchCrash(W, H),
    'pull-success': (W, H) => rocketLand(W, H),
    'pull-fail': (W, H) => rocketLandCrash(W, H),
    'commit-success': (W, H) => commitStamp(W, H, true),
    'commit-fail': (W, H) => commitStamp(W, H, false),
    'merge-success': (W, H) => mergeScene(W, H, true),
    'merge-fail': (W, H) => mergeScene(W, H, false),
};
