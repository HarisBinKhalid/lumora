// System FX: Cairo drawings for connections (Wi-Fi, Bluetooth, VPN), sound
// (volume, mic) and the lock screen. Every scene is a box centred on its
// anchor, in design units of a 1080p screen (the extension scales them).
// t goes 0 -> 1. Keep everything inside the box and fade out before its edge.

import Cairo from 'cairo';
import {
    TAU, WHITE, rand, seg, easeOut, easeIn, easeInOut, lerp, mix,
    glow, disc, ring, glowStroke, jagged, arcPts, roundRect, centred, box,
} from './draw.js';

const WIFI = [0.3, 0.85, 1];
const BT = [0.35, 0.58, 1];
const VPN = [0.3, 0.95, 0.62];
const GREY = [0.62, 0.64, 0.68];
const RED = [1, 0.3, 0.3];
const GREEN = [0.35, 0.95, 0.55];
const GOLD = [1, 0.8, 0.3];
const LOCK = [0.55, 0.6, 1];

// Fade in quickly, hold, fade out at the end.
const life = (t, inEnd = 0.08, outStart = 0.78) => Math.min(1, t / inEnd) * (1 - seg(t, outStart, 1));

// Little bits that fall away with gravity (for things breaking up).
function makeBits(n, spread, c) {
    return Array.from({length: n}, () => ({
        x: rand(-spread, spread), y: rand(-spread, spread * 0.4),
        vx: rand(-60, 60), vy: rand(-80, 10), r: rand(1.4, 2.8), c,
    }));
}
function drawBits(cr, bits, k) {
    if (k <= 0 || k >= 1)
        return;
    for (const b of bits)
        disc(cr, b.x + b.vx * k, b.y + b.vy * k + 260 * k * k, b.r, b.c, 1 - k);
}

// ---------- Wi-Fi ----------

const WIFI_ARCS = [30, 58, 86];
const WIFI_A0 = -Math.PI * 0.75, WIFI_A1 = -Math.PI * 0.25;   // the fan points up

function wifiIcon(cr, oy, cols, alphas, grow = [1, 1, 1], w = 5) {
    disc(cr, 0, oy, 7, cols[0], alphas[0]);
    glow(cr, 0, oy, 22, cols[0], 0.5 * alphas[0]);
    WIFI_ARCS.forEach((r, i) => {
        const g = grow[i];
        if (g <= 0)
            return;
        const mid = (WIFI_A0 + WIFI_A1) / 2, half = (WIFI_A1 - WIFI_A0) / 2 * g;
        glowStroke(cr, arcPts(0, oy, r, mid - half, mid + half, 20), cols[i], alphas[i], w);
    });
}

export function wifiOn() {
    return centred(1700, 160, (cr, t) => {
        const a = life(t);
        const grow = WIFI_ARCS.map((_, i) => easeOut(seg(t, 0.08 + i * 0.12, 0.3 + i * 0.12)));
        wifiIcon(cr, 40, [WIFI, WIFI, WIFI], [a, a, a], grow);
        // A wave rolls out past the icon once it's lit.
        for (const d of [0.45, 0.58]) {
            const k = seg(t, d, d + 0.4);
            if (k > 0 && k < 1)
                glowStroke(cr, arcPts(0, 40, 86 + 60 * easeOut(k), WIFI_A0, WIFI_A1, 24), WIFI, 0.6 * (1 - k), 2.5);
        }
    });
}

export function wifiOff() {
    const bits = makeBits(26, 70, GREY);
    return centred(1500, 160, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        // Outer arcs die first, turning grey.
        const fade = WIFI_ARCS.map((_, i) => 1 - seg(t, 0.25 + (2 - i) * 0.1, 0.45 + (2 - i) * 0.1));
        const cols = fade.map(f => mix(GREY, WIFI, f));
        wifiIcon(cr, 40, cols, fade.map(f => a * (0.35 + 0.65 * f)));
        const k = easeOut(seg(t, 0.12, 0.32));
        if (k > 0)
            glowStroke(cr, [[-62, -40], [-62 + 124 * k, -40 + 112 * k]], RED, a, 4.5);
        cr.save();
        cr.translate(0, -20);
        drawBits(cr, bits, seg(t, 0.3, 1));
        cr.restore();
    });
}

// A small router: box, two antennas, and its own Wi-Fi fan when `lit`.
function router(cr, x, y, c, a, lit) {
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    roundRect(cr, x - 30, y, 60, 22, 6);
    cr.fill();
    cr.setLineWidth(3.5);
    for (const sx of [-1, 1]) {
        cr.moveTo(x + sx * 18, y);
        cr.lineTo(x + sx * 24, y - 22);
        cr.stroke();
    }
    for (let i = 0; i < 3; i++)
        disc(cr, x - 14 + i * 10, y + 11, 2.2, [0.1, 0.12, 0.15], a);
    if (lit > 0) {
        [22, 38].forEach((r, i) => {
            const g = seg(lit, i * 0.3, 0.6 + i * 0.3);
            if (g > 0)
                glowStroke(cr, arcPts(x, y - 12, r, -Math.PI * 0.75, -Math.PI * 0.25, 14), c, a * g, 3);
        });
    }
}

// Moved to another Wi-Fi network: a beam carries the signal from the old
// access point to the new one.
export function wifiSwitch() {
    const L = [-175, 40], R = [175, 40];
    const at = k => [lerp(L[0], R[0], k), lerp(L[1] - 20, R[1] - 20, k) - 110 * Math.sin(Math.PI * k)];
    const path = Array.from({length: 41}, (_, i) => at(i / 40));
    return box(2300, 580, 300, (cr, t) => {
        const a = life(t, 0.06, 0.82);
        const oldLit = 1 - seg(t, 0.3, 0.7);
        router(cr, L[0], L[1], mix(GREY, WIFI, oldLit), a, oldLit);
        const newLit = seg(t, 0.62, 0.9);
        router(cr, R[0], R[1], mix(GREY, GREEN, newLit), a, newLit);
        // The beam: a faint path with bright packets running along it.
        const run = seg(t, 0.12, 0.66);
        if (run > 0 && run < 1) {
            glowStroke(cr, path, WIFI, 0.25 * a, 1.6, Math.min(1, run * 1.3));
            for (let i = 0; i < 5; i++) {
                const k = run * 1.25 - i * 0.07;
                if (k <= 0 || k >= 1)
                    continue;
                const [x, y] = at(k), [px, py] = at(Math.max(0, k - 0.06));
                glowStroke(cr, [[px, py], [x, y]], mix(WIFI, GREEN, k), a, 3);
                glow(cr, x, y, 16, WIFI, 0.6 * a);
            }
        }
        const hit = seg(t, 0.64, 0.95);
        if (hit > 0 && hit < 1) {
            ring(cr, R[0], R[1] - 12, 20 + 70 * easeOut(hit), 3 * (1 - hit), GREEN, a * (1 - hit));
            glow(cr, R[0], R[1] - 12, 70, GREEN, 0.5 * a * (1 - hit));
        }
    });
}

// ---------- Bluetooth ----------

// The Bluetooth rune as line segments, each with which half it belongs to.
const RUNE = [
    [[-26, -30], [26, 26], 1], [[26, 26], [0, 50], 1], [[0, 50], [0, -50], 0],
    [[0, -50], [26, -26], 1], [[26, -26], [-26, 30], -1],
];

function runePath() {
    return [[-26, -30], [26, 26], [0, 50], [0, -50], [26, -26], [-26, 30]];
}

export function btOn() {
    const rune = runePath();
    return centred(1800, 170, (cr, t) => {
        const a = life(t, 0.05, 0.8);
        glow(cr, 0, 0, 90, BT, 0.35 * a * seg(t, 0.3, 0.5));
        glowStroke(cr, rune, BT, a, 5, easeInOut(seg(t, 0.02, 0.42)));
        // Two devices pair up: dots on each side send a beam to the middle.
        const k = seg(t, 0.42, 0.66);
        if (k > 0) {
            for (const sx of [-1, 1]) {
                const x = sx * 125;
                disc(cr, x, 0, 8, BT, a);
                glow(cr, x, 0, 26, BT, 0.6 * a);
                if (k < 1)
                    glowStroke(cr, [[x, 0], [x - sx * 95 * easeIn(k), 0]], BT, a * 0.9, 3);
            }
        }
        const hit = seg(t, 0.66, 0.95);
        if (hit > 0 && hit < 1)
            ring(cr, 0, 0, 40 + 90 * easeOut(hit), 4 * (1 - hit), BT, a * (1 - hit));
    });
}

export function btOff() {
    const sparks = Array.from({length: 18}, () => ({a: rand(0, TAU), v: rand(30, 90)}));
    return centred(1600, 170, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        const k = easeOut(seg(t, 0.25, 0.9));
        const col = mix(BT, GREY, seg(t, 0.2, 0.5));
        // The rune splits: its halves drift apart and tilt away.
        for (const [p, q, side] of RUNE) {
            const dx = side * 70 * k, rot = side * 0.35 * k;
            const tr = ([x, y]) => [x * Math.cos(rot) - y * Math.sin(rot) + dx,
                x * Math.sin(rot) + y * Math.cos(rot) + 30 * k * k];
            const sa = side === 0 ? a * (1 - seg(t, 0.25, 0.5)) : a * (1 - k * 0.6);
            glowStroke(cr, [tr(p), tr(q)], col, sa, 5);
        }
        const s = seg(t, 0.22, 0.6);
        if (s > 0 && s < 1) {
            for (const p of sparks)
                disc(cr, Math.cos(p.a) * p.v * easeOut(s), Math.sin(p.a) * p.v * easeOut(s), 2, BT, a * (1 - s));
        }
    });
}

// ---------- VPN ----------

function shieldPts(s = 1) {
    const pts = [];
    for (let i = 0; i <= 12; i++) {                            // top edge, slight arch
        const x = lerp(-62, 62, i / 12);
        pts.push([x * s, (-70 + 8 * Math.sin(Math.PI * i / 12) * -1) * s]);
    }
    for (let i = 1; i <= 16; i++) {                            // right side down to the tip
        const k = i / 16;
        pts.push([lerp(62, 0, easeIn(k)) * s, lerp(-70, 82, k) * s]);
    }
    for (let i = 1; i <= 16; i++) {                            // left side back up
        const k = i / 16;
        pts.push([lerp(0, -62, 1 - easeIn(1 - k)) * s, lerp(82, -70, k) * s]);
    }
    return pts;
}

function padlock(cr, x, y, s, c, a, shackleUp = 0, open = 0) {
    cr.save();
    cr.translate(x, y);
    cr.scale(s, s);
    // Shackle: a U that can rise (shackleUp) and swing open (open).
    cr.save();
    cr.translate(14, -8 - 26 * shackleUp);
    cr.rotate(-0.9 * open);
    cr.translate(-14, 0);
    cr.setLineWidth(7);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    cr.moveTo(-14, 6);
    cr.lineTo(-14, -12);
    cr.arc(0, -12, 14, Math.PI, 0);
    cr.lineTo(14, 6);
    cr.stroke();
    cr.restore();
    roundRect(cr, -26, -6, 52, 42, 8);
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    cr.fill();
    disc(cr, 0, 12, 5, [0.08, 0.1, 0.14], a);
    cr.setSourceRGBA(0.08, 0.1, 0.14, a);
    cr.rectangle(-2, 12, 4, 12);
    cr.fill();
    cr.restore();
}

export function vpnOn() {
    const shield = shieldPts();
    return centred(1900, 170, (cr, t) => {
        const a = life(t, 0.05, 0.8);
        // A tunnel of shields rushing in.
        for (let i = 0; i < 3; i++) {
            const k = seg(t, 0.05 + i * 0.1, 0.45 + i * 0.1);
            if (k > 0 && k < 1)
                glowStroke(cr, shieldPts(1.9 - 0.9 * easeOut(k)), VPN, 0.45 * a * (1 - k), 2);
        }
        glowStroke(cr, [...shield, shield[0]], VPN, a, 4.5, easeInOut(seg(t, 0.05, 0.45)));
        const lockIn = seg(t, 0.35, 0.5);
        if (lockIn > 0) {
            const close = easeIn(seg(t, 0.48, 0.62));
            padlock(cr, 0, 0, 1, VPN, a * lockIn, 1 - close);
        }
        const hit = seg(t, 0.62, 0.92);
        if (hit > 0 && hit < 1) {
            ring(cr, 0, 0, 50 + 90 * easeOut(hit), 4 * (1 - hit), VPN, a * (1 - hit));
            glow(cr, 0, 0, 110, VPN, 0.45 * a * (1 - hit));
        }
    });
}

export function vpnOff() {
    const shield = shieldPts();
    const crack = jagged(0, -72, 0, 84, 0.18, 4);
    const left = shield.filter(([x]) => x <= 0.5), right = shield.filter(([x]) => x >= -0.5);
    return centred(1700, 170, (cr, t) => {
        const a = life(t, 0.05, 0.85);
        const c = seg(t, 0.12, 0.3);
        const fall = seg(t, 0.38, 1);
        const col = mix(VPN, [1, 0.6, 0.3], seg(t, 0.1, 0.35));
        for (const [half, side] of [[left, -1], [right, 1]]) {
            cr.save();
            cr.translate(side * 40 * easeOut(fall), 55 * fall * fall);
            cr.rotate(side * 0.45 * fall);
            glowStroke(cr, half, col, a * (1 - fall), 4.5);
            cr.restore();
        }
        if (fall === 0 && c > 0)
            glowStroke(cr, crack, RED, a, 2.4, c);
        padlock(cr, 0, 0, 1, col, a * (1 - seg(t, 0.4, 0.7)), easeOut(seg(t, 0.3, 0.45)), easeOut(seg(t, 0.35, 0.55)));
    });
}

// ---------- Sound ----------

function speaker(cr, c, a, shake = 0) {
    cr.save();
    cr.translate(rand(-1, 1) * shake, rand(-1, 1) * shake);
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    roundRect(cr, -46, -16, 20, 32, 4);
    cr.fill();
    cr.moveTo(-28, -16);
    cr.lineTo(-4, -36);
    cr.lineTo(-4, 36);
    cr.lineTo(-28, 16);
    cr.closePath();
    cr.fill();
    cr.restore();
}

const WAVE = (r, c, a, w = 4) => [arcPts(4, 0, r, -0.85, 0.85, 14), c, a, w];

function waves(cr, rs, c, a, w = 4) {
    for (const r of rs)
        if (r > 4)
            glowStroke(cr, ...WAVE(r, c, a, w));
}

function chevron(cr, x, y, up, c, a) {
    const d = up ? -1 : 1;
    glowStroke(cr, [[x - 12, y - 6 * d], [x, y + 6 * d], [x + 12, y - 6 * d]], c, a, 3.5);
}

export function volUp() {
    return centred(950, 120, (cr, t) => {
        const a = life(t, 0.06, 0.7);
        speaker(cr, WHITE, a);
        for (let i = 0; i < 3; i++) {
            const k = seg(t, i * 0.13, 0.55 + i * 0.13);
            if (k > 0 && k < 1)
                waves(cr, [16 + 70 * easeOut(k)], WIFI, a * (1 - k) * 1.2);
        }
        const k = easeOut(seg(t, 0, 0.7));
        chevron(cr, 102, 10 - 50 * k, true, GREEN, a * (1 - seg(t, 0.4, 0.8)));
    });
}

export function volDown() {
    return centred(950, 120, (cr, t) => {
        const a = life(t, 0.06, 0.7);
        speaker(cr, WHITE, a);
        for (let i = 0; i < 3; i++) {
            const k = seg(t, i * 0.13, 0.55 + i * 0.13);
            if (k > 0 && k < 1)
                waves(cr, [86 - 70 * easeIn(k)], WIFI, a * Math.sin(Math.PI * k));
        }
        const k = easeOut(seg(t, 0, 0.7));
        chevron(cr, 102, -30 + 50 * k, false, [1, 0.7, 0.3], a * (1 - seg(t, 0.4, 0.8)));
    });
}

// Turned all the way up: the speaker shakes and blasts shockwaves.
export function volMax() {
    const sparks = Array.from({length: 22}, () => ({a: rand(-1.1, 1.1), v: rand(80, 150), r: rand(1.6, 3)}));
    return centred(1500, 175, (cr, t) => {
        const a = life(t, 0.05, 0.78);
        speaker(cr, GOLD, a, 4 * (1 - seg(t, 0, 0.6)));
        waves(cr, [24, 44, 64], GOLD, a, 5.5);
        for (let i = 0; i < 3; i++) {
            const k = seg(t, i * 0.12, 0.6 + i * 0.12);
            if (k > 0 && k < 1)
                glowStroke(cr, arcPts(4, 0, 70 + 90 * easeOut(k), -1.1, 1.1, 20), [1, 0.6, 0.2], a * (1 - k), 4 * (1 - k) + 1);
        }
        const s = seg(t, 0.05, 0.7);
        if (s > 0 && s < 1) {
            for (const p of sparks) {
                const d = 60 + p.v * easeOut(s);
                disc(cr, 4 + Math.cos(p.a) * d, Math.sin(p.a) * d, p.r, GOLD, a * (1 - s));
            }
        }
    });
}

// Turned all the way down: the waves drain away to a flat line.
export function volZero() {
    return centred(1300, 140, (cr, t) => {
        const a = life(t, 0.05, 0.78);
        const gone = [0, 1, 2].map(i => seg(t, 0.1 + (2 - i) * 0.12, 0.3 + (2 - i) * 0.12));
        speaker(cr, mix(WHITE, GREY, seg(t, 0.2, 0.6)), a);
        [24, 44, 64].forEach((r, i) => {
            if (gone[i] < 1)
                waves(cr, [r * (1 - 0.6 * gone[i])], mix(WIFI, GREY, gone[i]), a * (1 - gone[i]));
        });
        // Flat line with one last blip dying out.
        const k = seg(t, 0.4, 0.8);
        if (k > 0) {
            const amp = 14 * (1 - k);
            const pts = Array.from({length: 25}, (_, i) => {
                const x = 14 + i * 4;
                return [x, i > 8 && i < 16 ? -Math.sin((i - 8) / 7 * Math.PI) * amp : 0];
            });
            glowStroke(cr, pts, GREY, a, 2.5, seg(t, 0.4, 0.55));
        }
    });
}

export function mute() {
    const bits = makeBits(20, 40, RED);
    return centred(1200, 140, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        speaker(cr, mix(WHITE, RED, seg(t, 0.15, 0.35)), a);
        const cut = seg(t, 0.15, 0.35);
        if (cut < 1)
            waves(cr, [24, 44], WIFI, a * (1 - cut));
        cr.save();
        cr.translate(30, 0);
        drawBits(cr, bits, seg(t, 0.25, 1));
        cr.restore();
        const k = easeOut(cut);
        if (k > 0)
            glowStroke(cr, [[-58, -46], [-58 + 116 * k, -46 + 92 * k]], RED, a, 5);
    });
}

export function unmute() {
    return centred(1200, 140, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        speaker(cr, mix(RED, WHITE, seg(t, 0.1, 0.35)), a);
        const k = 1 - easeIn(seg(t, 0, 0.25));
        if (k > 0)
            glowStroke(cr, [[-58, -46], [-58 + 116 * k, -46 + 92 * k]], RED, a * k, 5);
        for (let i = 0; i < 2; i++) {
            const g = easeOut(seg(t, 0.2 + i * 0.12, 0.5 + i * 0.12));
            if (g > 0)
                waves(cr, [24 + 20 * i], GREEN, a * g);
        }
        const r = seg(t, 0.4, 0.85);
        if (r > 0 && r < 1)
            glowStroke(cr, arcPts(4, 0, 50 + 60 * easeOut(r), -0.9, 0.9, 16), GREEN, a * (1 - r), 2.5);
    });
}

// ---------- Microphone ----------

function mic(cr, c, a) {
    cr.setSourceRGBA(c[0], c[1], c[2], a);
    roundRect(cr, -14, -46, 28, 52, 14);
    cr.fill();
    cr.setLineWidth(5);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.arc(0, -8, 26, 0.15 * Math.PI, 0.85 * Math.PI);
    cr.stroke();
    cr.moveTo(0, 18);
    cr.lineTo(0, 36);
    cr.moveTo(-14, 38);
    cr.lineTo(14, 38);
    cr.stroke();
}

export function micMute() {
    return centred(1300, 130, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        mic(cr, mix(WHITE, RED, seg(t, 0.15, 0.35)), a);
        // Voice waves on both sides get squashed back in.
        const k = seg(t, 0, 0.4);
        if (k < 1) {
            for (const sx of [-1, 1])
                glowStroke(cr, arcPts(0, -16, 40 + 14 * (1 - k), sx > 0 ? -0.7 : Math.PI - 0.7,
                    sx > 0 ? 0.7 : Math.PI + 0.7, 12), WIFI, a * (1 - k), 3);
        }
        const s = easeOut(seg(t, 0.18, 0.38));
        if (s > 0)
            glowStroke(cr, [[-46, -58], [-46 + 92 * s, -58 + 108 * s]], RED, a, 5);
        const r = seg(t, 0.38, 0.75);
        if (r > 0 && r < 1)
            ring(cr, 0, -8, 30 + 60 * easeOut(r), 3 * (1 - r), RED, a * (1 - r));
    });
}

export function micUnmute() {
    return centred(1300, 130, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        mic(cr, mix(RED, WHITE, seg(t, 0.05, 0.3)), a);
        const s = 1 - easeIn(seg(t, 0, 0.22));
        if (s > 0)
            glowStroke(cr, [[-46, -58], [-46 + 92 * s, -58 + 108 * s]], RED, a * s, 5);
        // Voice ripples rising on both sides.
        for (let i = 0; i < 3; i++) {
            const k = seg(t, 0.2 + i * 0.13, 0.65 + i * 0.13);
            if (k <= 0 || k >= 1)
                continue;
            const r = 34 + 50 * easeOut(k);
            for (const sx of [-1, 1])
                glowStroke(cr, arcPts(0, -16, r, sx > 0 ? -0.7 : Math.PI - 0.7, sx > 0 ? 0.7 : Math.PI + 0.7, 12),
                    GREEN, a * (1 - k), 3);
        }
    });
}

// ---------- Lock screen ----------

// The shackle clicks shut at CLICK (fraction of the scene); the imploding
// shockwave is timed to arrive at the padlock at exactly that moment.
const CLICK = 0.42;

export function lock() {
    const parts = Array.from({length: 30}, () => ({a: rand(0, TAU), d: rand(120, 200), s: rand(1.5, 3)}));
    return centred(1600, 340, (cr, t) => {
        const a = life(t, 0.06, 0.8);
        // Light gathers in...
        const g = seg(t, 0, 0.35);
        if (g < 1) {
            for (const p of parts) {
                const d = p.d * (1 - easeIn(g));
                disc(cr, Math.cos(p.a) * d, Math.sin(p.a) * d, p.s, LOCK, 0.7 * a * Math.sin(Math.PI * g));
            }
        }
        // ...an imploding shockwave pulls in to the padlock, two rings that
        // both land as the shackle clicks shut...
        for (const start of [0.04, 0.16]) {
            const k = seg(t, start, CLICK);
            if (k > 0 && k < 1) {
                const r = lerp(305, 78, easeIn(k));
                glowStroke(cr, arcPts(0, 8, r, 0, TAU, 64), LOCK, a * (0.25 + 0.75 * k), 2.5 + 4 * k);
            }
        }
        // ...and the shackle drops and clicks shut.
        const drop = easeIn(seg(t, 0.2, CLICK));
        padlock(cr, 0, 0, 2.4, LOCK, a, 1 - drop);
        const hit = seg(t, CLICK, 0.7);
        if (hit > 0 && hit < 1) {
            glow(cr, 0, 10, 130, LOCK, 0.5 * a * (1 - hit));
            disc(cr, 0, 29, 12 * (1 - hit), WHITE, a * (1 - hit));
        }
    });
}

// The shackle springs open between POP and OPEN; the exploding shockwave
// starts the moment it begins to open (POP).
const OPEN = 0.4;
const POP = 0.15;   // the shackle starts popping open here

export function unlock() {
    const rays = Array.from({length: 16}, (_, i) => (i / 16) * TAU + rand(-0.08, 0.08));
    const sparks = Array.from({length: 26}, () => ({a: rand(0, TAU), v: rand(90, 150), s: rand(1.5, 3)}));
    return centred(1700, 340, (cr, t) => {
        const a = life(t, 0.05, 0.75);
        const pop = easeOut(seg(t, POP, OPEN));
        const rise = easeIn(seg(t, 0.6, 1));
        padlock(cr, 0, -40 * rise, 2.4, mix(LOCK, GOLD, pop), a, pop, pop);
        // Exploding shockwave: two rings bursting out of the padlock.
        for (const start of [POP, POP + 0.08]) {
            const k = seg(t, start, start + 0.4);
            if (k > 0 && k < 1)
                glowStroke(cr, arcPts(0, 8, lerp(78, 305, easeOut(k)), 0, TAU, 64), GOLD,
                    a * (1 - k), 6.5 * (1 - k) + 1);
        }
        const b = seg(t, POP, 0.7);
        if (b > 0 && b < 1) {
            glow(cr, 0, 0, 180, GOLD, 0.45 * a * (1 - b));
            for (const r of rays) {
                const d1 = 70 + 120 * easeOut(b), d0 = d1 - 50 * (1 - b);
                glowStroke(cr, [[Math.cos(r) * d0, Math.sin(r) * d0], [Math.cos(r) * d1, Math.sin(r) * d1]],
                    GOLD, a * (1 - b), 2.2);
            }
            for (const p of sparks) {
                const d = 40 + p.v * easeOut(b);
                disc(cr, Math.cos(p.a) * d, Math.sin(p.a) * d, p.s, [1, 0.95, 0.7], a * (1 - b));
            }
        }
    });
}

// Every scene by name (the names the settings and previews use).
export const SCENES = {
    'wifi-on': wifiOn, 'wifi-off': wifiOff, 'wifi-switch': wifiSwitch,
    'bt-on': btOn, 'bt-off': btOff, 'vpn-on': vpnOn, 'vpn-off': vpnOff,
    'vol-up': volUp, 'vol-down': volDown, 'vol-max': volMax, 'vol-zero': volZero,
    'mute': mute, 'unmute': unmute, 'mic-mute': micMute, 'mic-unmute': micUnmute,
    'lock': lock, 'unlock': unlock,
};

// For tools/effects-preview: every scene on a 1080p screen, in a grid.
export const PREVIEWS = Object.fromEntries(Object.entries(SCENES).map(([name, make]) => [
    `system-${name}`, (W, H) => {
        const s = make();
        return [{...s, x: W / 2 - s.ox, y: H / 2 - s.oy}];
    },
]));
