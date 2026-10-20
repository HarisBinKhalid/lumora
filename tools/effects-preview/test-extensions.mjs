// Runs the real Terminal FX and Desktop FX extension code against the fake
// GNOME in gnome-mock.mjs: simulates input, windows, battery and messages,
// checks for errors and leaks, and saves screenshots to out/test-*.png.
// Usage:  npm test            (both)
//         npm test -- desktop | terminal
import fsys from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];

// Each extension runs in its own process so the fake GNOME starts clean.
if (!which) {
    let failed = false;
    for (const w of ['desktop', 'terminal']) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), w], {stdio: 'inherit'});
        failed ||= r.status !== 0;
    }
    process.exit(failed ? 1 : 0);
}

const mock = await import('./gnome-mock.mjs');
const {advance, clock, errors, fs, pointer, inputEvent, display, battery, Main, FakeWindow} = mock;
globalThis.global = mock.globalObj;

// Copy the extension (+ shared modules) and point its imports at the mock.
async function loadExtension(uuid) {
    const ext = path.join(here, '../../extensions');
    const tmp = path.join(here, `.test-${uuid}`);
    fsys.rmSync(tmp, {recursive: true, force: true});
    fsys.mkdirSync(tmp);
    const mockUrl = pathToFileURL(path.join(here, 'gnome-mock.mjs')).href;
    const files = [...fsys.readdirSync(path.join(ext, uuid)).map(f => path.join(ext, uuid, f)),
        ...fsys.readdirSync(path.join(ext, 'shared')).map(f => path.join(ext, 'shared', f))];
    for (const f of files) {
        if (!f.endsWith('.js'))
            continue;
        const src = fsys.readFileSync(f, 'utf8')
            .replace(/^import (\w+) from 'gi:\/\/(\w+)';/gm, `import {$2 as $1} from '${mockUrl}';`)
            .replace(/^import Cairo from 'cairo';/m, `import {Cairo} from '${mockUrl}';`)
            .replace(/^import \* as Main from '[^']+';/m, `import {Main} from '${mockUrl}';`)
            .replace(/^import \{Extension\} from '[^']+';/m, `import {Extension} from '${mockUrl}';`);
        fsys.writeFileSync(path.join(tmp, path.basename(f)), src);
    }
    fsys.writeFileSync(path.join(tmp, 'package.json'), '{"type": "module"}');
    const meta = JSON.parse(fsys.readFileSync(path.join(ext, uuid, 'metadata.json'), 'utf8'));
    const mod = await import(pathToFileURL(path.join(tmp, 'extension.js')).href);
    process.on('exit', () => fsys.rmSync(tmp, {recursive: true, force: true}));
    return {Ext: mod.default, meta, mod};
}

// ---------- tiny test helpers ----------

let failures = 0;
function check(cond, what) {
    console.log(`${cond ? '  ok ' : 'FAIL '} ${what}`);
    if (!cond)
        failures++;
}
const consoleErrors = [];
for (const k of ['error', 'warn']) {
    const orig = console[k];
    console[k] = (...a) => {
        consoleErrors.push(a.join(' '));
        orig('    [extension log]', ...a);
    };
}
function noErrors(what) {
    check(errors.length === 0 && consoleErrors.length === 0,
        `${what}: no errors${errors.length || consoleErrors.length ? ` (${[...errors, ...consoleErrors].join(' | ')})` : ''}`);
    errors.length = 0;
    consoleErrors.length = 0;
}
function shot(name, x, y, w, h, scale = 0.5) {
    fsys.mkdirSync(path.join(here, 'out'), {recursive: true});
    fsys.writeFileSync(path.join(here, 'out', `test-${name}.png`),
        mock.screenshot(x, y, w, h, scale).toBuffer('image/png'));
}
const stage = () => Main.uiGroup.children.filter(a => !a.destroyed);
const findAll = (pred, root = Main.uiGroup, out = []) => {
    for (const c of root.children) {
        if (pred(c))
            out.push(c);
        findAll(pred, c, out);
    }
    return out;
};
const config = obj => mock.writeFile('/home/u/.config/lumora/config.json', JSON.stringify(obj));

// ======================================================================
if (which === 'desktop') {
    console.log('Desktop FX');
    const {Ext, meta} = await loadExtension('desktop-fx@local');
    const FLAGS = ['cursor', 'windows', 'desktop'].map(k => `/run/user/1000/desktop-fx-${k}-on`);
    const [CURSOR, WINDOWS, DESKTOP] = FLAGS;
    const allOn = () => FLAGS.forEach(f => fs.set(f, ''));
    const allOff = () => FLAGS.forEach(f => fs.delete(f));
    const ext = new Ext(meta);
    ext.enable();
    advance(100);
    check(fs.get('/run/user/1000/lumora/desktop-fx@local.running') === String(meta.version), 'writes its running version');
    check(mock.idleWatchCount() === 0 && display.handlerCount() === 0, 'switch off: no input watching at all');
    pointer.x = 500; pointer.y = 500;
    advance(500);
    check(stage().length === 0, 'switch off: nothing drawn when the mouse moves');

    // Each tab's switch only turns on its own part.
    fs.set(WINDOWS, '');
    advance(1100);
    check(display.handlerCount('grab-op-begin') === 1 && mock.idleWatchCount() === 0,
        'Windows switch alone: drag signals on, no click/key watching');
    pointer.x = 650; pointer.y = 450; advance(300);
    check(stage().length === 0, 'Windows switch alone: no cursor trail');
    allOff(); fs.set(CURSOR, '');
    advance(1100);
    check(display.handlerCount() === 0, 'Cursor switch alone: no window drag signals');
    for (let k = 0; k < 30; k++) {
        inputEvent(); advance(50);
    }
    check(findAll(a => a.text === 'COMBO').length === 0, 'Cursor switch alone: typing combo stays off');
    allOff(); fs.set(DESKTOP, '');
    advance(1100);
    pointer.x = 700; pointer.y = 500; pointer.mods = 256; inputEvent(); advance(40);
    pointer.mods = 0; inputEvent(); advance(100);
    check(findAll(a => a._canvas).length === 0, 'Desktop switch alone: clicks make no ripple');
    advance(2000);
    allOff();
    advance(1100);

    allOn();
    advance(1100);
    check(mock.idleWatchCount() === 1, 'switch on: idle watch added');
    check(display.handlerCount('grab-op-begin') === 1, 'switch on: window drag signals connected');
    noErrors('switching on');

    // --- cursor trail (comet) ---
    for (let i = 0; i <= 30; i++) {
        pointer.x = 400 + i * 20; pointer.y = 500 + Math.sin(i / 4) * 80;
        advance(16);
    }
    const dots = findAll(a => a.width > 0 && a.width < 20 && a.opacity > 0);
    check(dots.length > 10, `comet trail: ${dots.length} dots visible while moving`);
    shot('trail-comet', 300, 350, 900, 300, 1);
    advance(600);
    check(findAll(a => a.width > 0 && a.width < 20 && a.opacity > 0).length === 0, 'comet trail fades away when the mouse stops');

    for (const style of ['rainbow', 'sparkles', 'stars']) {
        config({desktop: {trailStyle: style}});
        advance(300);   // config reload
        for (let i = 0; i <= 30; i++) {
            pointer.x = 400 + i * 20; pointer.y = 500 + Math.cos(i / 4) * 80;
            advance(16);
        }
        const vis = findAll(a => a.opacity > 0 && (a.text || (a.width > 0 && a.width < 20)));
        check(vis.length > 5, `${style} trail: ${vis.length} pieces visible`);
        shot(`trail-${style}`, 300, 350, 900, 300, 1);
        advance(1200);
    }
    noErrors('trails');

    // --- click ripples, each style ---
    for (const style of ['ripple', 'shockwave', 'sparks', 'confetti']) {
        config({desktop: {rippleStyle: style, trail: false}});
        advance(300);
        pointer.x = 800; pointer.y = 400; pointer.mods = 256;   // left button down
        inputEvent();
        advance(40);
        pointer.mods = 0;
        inputEvent();
        advance(150);
        const areas = findAll(a => a._canvas);
        check(areas.length === 1, `${style}: one ripple drawn on click`);
        shot(`ripple-${style}`, 700, 300, 200, 200, 1.5);
        advance(1000);
        check(findAll(a => a._canvas).length === 0, `${style}: ripple removed when done`);
    }
    // A click seen by both the ticker and the idle watch must fire once.
    pointer.mods = 1024; advance(20); inputEvent(); advance(20);
    check(findAll(a => a._canvas).length === 1, 'right click: exactly one ripple (no doubles)');
    pointer.mods = 0; advance(1000);
    noErrors('ripples');

    // --- typing combo ---
    config({desktop: {trail: false, ripples: false, comboMin: 10}});
    advance(300);
    inputEvent();                              // the mouse's last motion event
    for (let k = 0; k < 30; k++) {             // 30 keys: press + release each
        inputEvent(); advance(40);
        inputEvent(); advance(60);
    }
    const labels = findAll(a => a.text && a.text.startsWith('x'));
    check(labels.length === 1 && labels[0].text.startsWith('x30'), `combo counter shows ${labels[0]?.text}`);
    const box = labels[0]?.parent;
    check(box && box.x > 1600 && box.y > 900, `combo sits in the bottom-right corner (${box?.x}, ${box?.y})`);
    shot('combo', 1500, 850, 420, 230, 1);
    pointer.x += 5; inputEvent(); advance(20);       // mouse moves: not a key
    check(findAll(a => a.text && a.text.startsWith('x'))[0]?.text.startsWith('x30'), 'mouse movement does not count as typing');
    advance(2600);
    check(findAll(a => a.text === 'COMBO').length === 0, 'combo disappears after a pause');
    // Touchpad scrolling: events every 5ms must not build a combo.
    for (let k = 0; k < 80; k++) {
        inputEvent(); advance(5, 5);
    }
    check(findAll(a => a.text === 'COMBO').length === 0, 'fast scroll-like events do not show a combo');
    advance(2000);
    // A long pause then typing again starts from zero.
    for (let k = 0; k < 12; k++) {
        inputEvent(); advance(50); inputEvent(); advance(50);
    }
    check(findAll(a => a.text && a.text.startsWith('x'))[0]?.text === 'x12', 'new combo starts from zero');
    advance(2600);
    Main.sessionMode.isLocked = true;
    for (let k = 0; k < 40; k++) {
        inputEvent(); advance(50);
    }
    check(findAll(a => a.text === 'COMBO').length === 0, 'locked screen: typing (a password) is not counted');
    Main.sessionMode.isLocked = false;
    noErrors('combo');

    // --- window dragged to another monitor ---
    config({desktop: {trail: false, ripples: false}});
    advance(300);
    const win = new FakeWindow({x: 1200, y: 300, width: 800, height: 500}, 0);
    display.emit('grab-op-begin', win, mock.Meta.GrabOp.MOVING);
    advance(50);
    win.rect.x = 1600; win.mon = 1;                 // majority now on the right monitor
    advance(100);
    const gate = findAll(a => a._canvas);
    check(gate.length === 2, `crossing: exit + entry halves drawn (${gate.length})`);
    const outline = findAll(a => /border: 3px/.test(a.style));
    check(outline.length === 1, 'crossing: glowing outline over the window');
    shot('window-cross', 1300, 200, 1000, 700, 0.6);
    win.rect.x = 1700; advance(100);
    check(Math.abs(outline[0].x - 1698) <= 2, 'crossing: outline follows the window while dragged');
    advance(1000);
    check(findAll(a => a._canvas || /border: 3px/.test(a.style)).length === 0, 'crossing: everything removed after');
    noErrors('window crossing');

    // --- window snapped to the left edge ---
    display.emit('grab-op-end', win, mock.Meta.GrabOp.MOVING);
    const win2 = new FakeWindow({x: 300, y: 200, width: 700, height: 500}, 0);
    display.emit('grab-op-begin', win2, mock.Meta.GrabOp.MOVING);
    advance(100);
    win2.rect = {x: 0, y: 32, width: 960, height: 1048};   // tiled left
    display.emit('grab-op-end', win2, mock.Meta.GrabOp.MOVING);
    advance(200);
    const slamArea = findAll(a => a._canvas);
    check(slamArea.length === 1, 'slam: plays when a window snaps to the left half');
    check(slamArea[0] && slamArea[0].parent.clip_to_allocation, 'slam: clipped to its monitor');
    shot('slam-left', 0, 0, 700, 1080, 0.5);
    advance(1200);
    // Moved but not snapped: no slam.
    const win3 = new FakeWindow({x: 300, y: 200, width: 700, height: 500}, 0);
    display.emit('grab-op-begin', win3, mock.Meta.GrabOp.MOVING);
    win3.rect.x = 0;
    display.emit('grab-op-end', win3, mock.Meta.GrabOp.MOVING);
    advance(600);
    check(findAll(a => a._canvas).length === 0, 'slam: a window just moved to the edge (same size) does not slam');
    // Resizing is not a move.
    display.emit('grab-op-begin', win3, mock.Meta.GrabOp.RESIZING_NE);
    win3.rect = {x: 0, y: 32, width: 1920, height: 1048};
    display.emit('grab-op-end', win3, mock.Meta.GrabOp.RESIZING_NE);
    advance(600);
    check(findAll(a => a._canvas).length === 0, 'slam: resizing a window is ignored');
    // Maximised by dragging to the top.
    const win4 = new FakeWindow({x: 300, y: 200, width: 700, height: 500}, 0);
    display.emit('grab-op-begin', win4, mock.Meta.GrabOp.MOVING);
    win4.rect = {x: 0, y: 32, width: 1920, height: 1048};
    display.emit('grab-op-end', win4, mock.Meta.GrabOp.MOVING);
    advance(200);
    const top = findAll(a => a._canvas)[0];
    check(top && top.parent.y === 0 && top.y <= 40, `slam: maximise slams the top edge (canvas at y=${top?.y})`);
    shot('slam-top', 0, 0, 1920, 400, 0.4);
    advance(1200);
    noErrors('window slam');

    // --- battery fire ---
    advance(100);
    battery.Percentage = 8; battery.State = 2;
    battery.proxy.emit('g-properties-changed');
    advance(1200);
    const fire = findAll(a => a._canvas);
    check(fire.length === 1 && fire[0].y > 900, 'battery 8% and discharging: flames along the bottom');
    shot('battery-fire', 0, 880, 1920, 200, 0.5);
    battery.State = 1;                       // plugged in
    battery.proxy.emit('g-properties-changed');
    advance(1500);
    check(findAll(a => a._canvas).length === 0, 'plugged in: flames go out');
    config({desktop: {batteryKeepBurning: false}});
    advance(300);
    battery.State = 2; battery.Percentage = 9;
    battery.proxy.emit('g-properties-changed');
    advance(1500);
    check(findAll(a => a._canvas).length === 1, 'burst mode: flames when it drops below the level');
    advance(9000);
    check(findAll(a => a._canvas).length === 0, 'burst mode: flames stop after a few seconds');
    battery.Percentage = 8.4;
    battery.proxy.emit('g-properties-changed');
    advance(1200);
    check(findAll(a => a._canvas).length === 1, 'burst mode: burns again one percent lower');
    advance(10000);
    battery.State = 1; battery.proxy.emit('g-properties-changed');
    advance(1500);
    noErrors('battery');

    // --- previews from the app, with the switch OFF ---
    allOff();
    advance(1100);
    check(mock.idleWatchCount() === 0 && display.handlerCount() === 0, 'switch off again: input watching removed');
    for (const p of ['trail comet', 'trail rainbow', 'trail sparkles', 'trail stars', 'ripple shockwave', 'slam', 'cross', 'fire', 'combo']) {
        ext._onPreview(p);
        advance(400);
        const n = stage().length;
        check(n > 0, `preview "${p}" shows something (${n} actors)`);
        if (p === 'cross')
            shot('preview-cross', 400, 200, 1100, 700, 0.6);
        if (p === 'trail stars')
            shot('preview-trail-stars', 200, 150, 1500, 800, 0.5);
        advance(9000);
        check(stage().length === 0, `preview "${p}" cleans up after itself`);
    }
    noErrors('previews');

    // --- disable in the middle of everything ---
    allOn();
    config({});
    advance(1100);
    ext._onPreview('fire');
    ext._onPreview('combo');
    ext._onPreview('cross');
    pointer.mods = 256; inputEvent(); pointer.mods = 0;
    display.emit('grab-op-begin', new FakeWindow({x: 10, y: 10, width: 300, height: 300}), mock.Meta.GrabOp.MOVING);
    advance(300);
    ext.disable();
    check(stage().length === 0, 'disable: every actor removed');
    check(mock.pendingSources() === 0, `disable: no timers left (${mock.pendingSources()})`);
    check(mock.runningTimelines() === 0, 'disable: no animations left running');
    check(mock.idleWatchCount() === 0 && display.handlerCount() === 0, 'disable: input watching removed');
    check(battery.proxy.handlerCount() === 0, 'disable: battery signal disconnected');
    check(!fs.has('/run/user/1000/lumora/desktop-fx@local.running'), 'disable: running marker removed');
    check(mock.dirMonitorCount() === 0, 'disable: settings watcher removed');
    noErrors('disable');
    // And enable again works.
    ext.enable();
    advance(1500);
    ext.disable();
    advance(100);
    noErrors('re-enable');
}

// ======================================================================
if (which === 'terminal') {
    console.log('Terminal FX');
    const {Ext, meta, mod} = await loadExtension('term-fx@local');
    const FLAG = '/run/user/1000/term-fx-on';
    const ext = new Ext(meta);
    ext.enable();
    advance(100);
    const send = line => {
        ext._handle(line);
        advance(450);  // past the spam guard
    };
    send('success 0 d=0 git push');
    check(stage().length === 0, 'switch off: real commands do nothing');
    fs.set(FLAG, '');

    const scenes = [
        ['success 0 d=3 git push origin main', 'push-success'],
        ['fail 1 d=3 git push', 'push-fail'],
        ['success 0 d=2 git pull', 'pull-success'],
        ['fail 128 d=2 git -C repo pull', 'pull-fail'],
        ['success 0 d=1 git commit -m "x"', 'commit-success'],
        ['fail 1 d=1 git commit', 'commit-fail'],
        ['success 0 d=1 git merge dev', 'merge-success'],
        ['fail 1 d=1 git merge dev', 'merge-fail'],
    ];
    for (const [line, name] of scenes) {
        ext._handle(line);
        advance(1500);
        const areas = findAll(a => a._canvas);
        check(areas.length === 1, `${name}: scene playing`);
        check(!findAll(a => a.text === 'Command failed').length, `${name}: no plain warning banner on top of it`);
        shot(`term-${name}`, 0, 0, 1920, 1080, 0.3);
        advance(4000);
        check(stage().length === 0, `${name}: cleaned up`);
    }
    noErrors('git scenes');

    send('success 0 d=5 make');
    check(findAll(a => a.width > 0 && a.width <= 12 && a.style.includes('background-color')).length > 50, 'short command: confetti as before');
    advance(12000);
    send('fail 2 d=5 make');
    check(findAll(a => a.text === 'Command failed').length === 1, 'failed command: warning banner as before');
    advance(4000);
    send('success 0 make');
    check(stage().length > 0, 'old fx.sh message without d= still works');
    advance(12000);

    ext._handle('success 0 d=90 npm run build');
    advance(1200);
    let n = findAll(a => a._canvas).length;
    check(n >= 1, `1.5 minute command: fireworks (${n} bursts so far)`);
    shot('term-fireworks-1', 0, 0, 1920, 1080, 0.3);
    advance(8000);
    check(stage().length === 0, 'fireworks: cleaned up');
    ext._handle('success 0 d=400 make world');
    advance(2500);
    shot('term-fireworks-2', 0, 0, 1920, 1080, 0.3);
    advance(2000);
    check(findAll(a => a.style.includes('background-color') && a.width <= 12).length > 50, '6+ minute command: fireworks finale then confetti');
    advance(15000);
    check(stage().length === 0, 'finale: cleaned up');
    ext._handle('success 0 d=400 git push');
    advance(1500);
    check(findAll(a => a._canvas).length >= 2, 'long git push: rocket AND fireworks');
    advance(15000);
    ext._handle('fail 1 d=400 make');
    advance(500);
    check(findAll(a => a.text === 'Command failed').length === 1, 'long command that failed: just the warning');
    advance(4000);
    noErrors('long commands');

    // Settings: git animations off -> confetti again; long off -> confetti.
    config({terminal: {gitEffects: [], longCommand: false}});
    advance(300);
    send('success 0 d=400 git push');
    check(findAll(a => a._canvas).length === 0 && stage().length > 0, 'with git + long switched off: plain confetti');
    advance(12000);
    // Previews ignore the settings.
    ext._handle('preview-success 0 d=0 git push');
    advance(500);
    check(findAll(a => a._canvas).length === 1, 'preview of a git animation plays even when switched off');
    advance(5000);
    config({});
    advance(300);

    // Disable mid-animation.
    ext._handle('success 0 d=400 git push');
    advance(1500);
    ext.disable();
    check(stage().length === 0, 'disable: every actor removed');
    check(mock.pendingSources() === 0, `disable: no timers left (${mock.pendingSources()})`);
    check(mock.runningTimelines() === 0, 'disable: no animations left running');
    check(mock.dirMonitorCount() === 0, 'disable: settings watcher removed');
    noErrors('disable');

    check(mod.gitKind('git push') === 'push' && mod.gitKind('npm test') === null, 'gitKind exported and sane');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
