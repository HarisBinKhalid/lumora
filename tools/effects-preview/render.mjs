// Renders every crossing animation in extensions/edge-portal@local/effects.js
// to PNG contact sheets in ./out, using a canvas stand-in for GNOME's Cairo.
// It also runs every effect through its whole timeline and fails loudly on
// NaN/Infinity coordinates. Usage:  npm install && npm run preview [-- name]
import {createCanvas} from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {wrap} from './mockcairo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '../../extensions/edge-portal@local/effects.js');
const tmp = path.join(here, '.effects.tmp.mjs');
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8')
    .replace(/^import Cairo from 'cairo';/m, "import Cairo from './mockcairo.mjs';"));
const {EFFECTS, setLineBoost} = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
fs.unlinkSync(tmp);

const SIZE = 4, CURSOR = 24;                  // same defaults as the extension
const sc = (CURSOR * SIZE) / 300;
setLineBoost(Math.min(2.5, 1 / Math.sqrt(sc)));
const only = process.argv[2];
const times = [0.05, 0.15, 0.3, 0.5, 0.75];
const W = 420, H = 260, EDGE = 110;
fs.mkdirSync(path.join(here, 'out'), {recursive: true});

for (const [name, fx] of Object.entries(EFFECTS)) {
    if (only && name !== only) continue;
    const sheet = createCanvas(W * times.length, H);
    const s = sheet.getContext('2d');
    s.fillStyle = '#1d2330';
    s.fillRect(0, 0, sheet.width, H);
    times.forEach((t, i) => {
        const ex = fx.exit(), en = fx.entry();
        const x0 = i * W, cx = x0 + EDGE, cy = H / 2;
        s.save();
        s.beginPath(); s.rect(x0, 0, W, H); s.clip();
        s.fillStyle = '#2a3245'; s.fillRect(x0, 0, EDGE, H);         // monitor being left
        s.save(); s.translate(cx - 1, cy); s.scale(sc, sc); s.beginPath(); ex.draw(wrap(s), t); s.restore();
        s.save(); s.beginPath(); s.rect(cx, 0, W, H); s.clip();       // monitor arrived on
        s.translate(cx, cy); s.scale(sc, sc); s.beginPath(); en.draw(wrap(s), t); s.restore();
        s.fillStyle = '#fff'; s.font = '13px sans-serif'; s.fillText(`${name}  t=${t}`, x0 + 8, 18);
        s.restore();
    });
    // Full-timeline sanity check (throws on non-finite numbers).
    const scratch = createCanvas(8, 8).getContext('2d');
    const ex = fx.exit(), en = fx.entry();
    for (let k = 0; k <= 90; k++) {
        ex.draw(wrap(scratch), k / 90);
        en.draw(wrap(scratch), k / 90);
    }
    const file = path.join(here, 'out', `${name}.png`);
    fs.writeFileSync(file, sheet.toBuffer('image/png'));
    console.log(`ok  ${name}  ->  ${path.relative(process.cwd(), file)}`);
}
