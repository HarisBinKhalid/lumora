// Renders the full-screen scenes (Terminal FX git/fireworks, Desktop FX) to
// PNG contact sheets in ./out, using a canvas stand-in for GNOME's Cairo.
// Every scene is also run through its whole timeline and fails loudly on
// NaN/Infinity coordinates. Usage:  npm run scenes [-- name-filter]
import {createCanvas} from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {wrap} from './mockcairo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, '../../extensions');
const tmp = path.join(here, '.scenes-tmp');

// Copy a scenes module and the shared drawing helpers next to each other,
// pointing their Cairo import at the mock.
async function load(file) {
    fs.rmSync(tmp, {recursive: true, force: true});
    fs.mkdirSync(tmp);
    const fix = src => src.replace(/^import Cairo from 'cairo';/m,
        `import Cairo from '${pathToFileURL(path.join(here, 'mockcairo.mjs')).href}';`);
    fs.writeFileSync(path.join(tmp, 'draw.js'), fix(fs.readFileSync(path.join(ext, 'shared/draw.js'), 'utf8')));
    fs.writeFileSync(path.join(tmp, 'scenes.mjs'), fix(fs.readFileSync(file, 'utf8'))
        .replace("from './draw.js'", "from './draw.js'"));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type": "module"}');
    const mod = await import(pathToFileURL(path.join(tmp, 'scenes.mjs')).href + `?t=${Date.now()}`);
    return mod;
}

const only = process.argv[2];
const W = 1920, H = 1080;                        // design screen
// Optional: SHOT=0.5 (zoom) and TIMES=0.2,0.5,0.8 (fractions of the scene) env vars.
const SHOT = Number(process.env.SHOT) || 0.28;
const TIMES = process.env.TIMES ? process.env.TIMES.split(',').map(Number) : null;
const FRAMES = TIMES ? TIMES.length : 6;
// Optional: CROP=x,y,w,h (design units) to look at one part of the screen.
const CROP = process.env.CROP ? process.env.CROP.split(',').map(Number) : null;
fs.mkdirSync(path.join(here, 'out'), {recursive: true});

// pieces: list of scenes (each with optional delay in ms). Draws them all at
// absolute time ms onto ctx (already scaled to the design screen).
function drawAt(ctx, pieces, ms) {
    for (const p of pieces) {
        const t = (ms - (p.delay || 0)) / p.duration;
        if (t < 0 || t > 1)
            continue;
        ctx.save();
        ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();     // the canvas box
        ctx.translate(p.x, p.y);
        ctx.beginPath();
        p.draw(wrap(ctx), t);
        ctx.restore();
    }
}

function sheet(name, make, screen = [W, H], bg = '#1d2330') {
    if (only && !name.includes(only))
        return;
    const [sw, sh] = screen;
    const pieces = [].concat(make(sw, sh));
    const [cx0, cy0, cw, ch] = CROP ?? [0, 0, sw, sh];
    const total = Math.max(...pieces.map(p => (p.delay || 0) + p.duration));
    const tw = Math.round(cw * SHOT), th = Math.round(ch * SHOT);
    const c = createCanvas(tw * FRAMES, th);
    const s = c.getContext('2d');
    for (let i = 0; i < FRAMES; i++) {
        const ms = total * (TIMES ? TIMES[i] : (i + 0.5) / FRAMES);
        s.save();
        s.beginPath(); s.rect(i * tw, 0, tw, th); s.clip();
        s.fillStyle = bg; s.fillRect(i * tw, 0, tw, th);
        s.translate(i * tw, 0); s.scale(SHOT, SHOT); s.translate(-cx0, -cy0);
        drawAt(s, pieces, ms);
        s.restore();
        s.strokeStyle = '#555'; s.strokeRect(i * tw + 0.5, 0.5, tw - 1, th - 1);
        s.fillStyle = '#fff'; s.font = '12px sans-serif';
        s.fillText(`${name}  ${Math.round(ms)}ms`, i * tw + 6, 14);
    }
    // Full-timeline sanity check, also checks pieces stay inside their box.
    const scratch = createCanvas(8, 8).getContext('2d');
    const fresh = [].concat(make(sw, sh));
    for (const p of fresh) {
        for (const v of [p.x, p.y, p.w, p.h, p.duration])
            if (!Number.isFinite(v)) throw new Error(`${name}: bad box ${JSON.stringify(p)}`);
        for (let k = 0; k <= 120; k++)
            p.draw(wrap(scratch), k / 120);
    }
    const file = path.join(here, 'out', `scene-${name}.png`);
    fs.writeFileSync(file, c.toBuffer('image/png'));
    console.log(`ok  ${name}  (${pieces.length} piece${pieces.length > 1 ? 's' : ''}, ${total}ms)  ->  ${path.relative(process.cwd(), file)}`);
}

const term = await load(path.join(ext, 'term-fx@local/scenes.js'));
for (const [name, make] of Object.entries(term.SCENES))
    sheet(name, make);
sheet('fireworks-1', (w, h) => term.fireworks(w, h, 1));
sheet('fireworks-2', (w, h) => term.fireworks(w, h, 2));

const deskFile = path.join(ext, 'desktop-fx@local/scenes.js');
if (fs.existsSync(deskFile)) {
    const desk = await load(deskFile);
    for (const [name, make] of Object.entries(desk.PREVIEWS ?? {}))
        sheet(name, make, [W, H], '#3a3f4b');
}
fs.rmSync(tmp, {recursive: true, force: true});
