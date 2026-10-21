// Runs the real Lumora extension code (Edge Portal, Terminal, Desktop and
// System FX) against the fake GNOME in gnome-mock.mjs: simulates input, windows, battery and messages,
// checks for errors and leaks, and saves screenshots to out/test-*.png.
// Usage:  npm test            (all)
//         npm test -- edge | desktop | terminal | system
import fsys from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];

// Each extension runs in its own process so the fake GNOME starts clean.
if (!which) {
    let failed = false;
    for (const w of ['edge', 'desktop', 'terminal', 'system']) {
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
            .replace(/^import \{Extension\} from '[^']+';/m, `import {Extension} from '${mockUrl}';`)
            .replace(/^import \{getMixerControl\} from '[^']+';/m, `import {getMixerControl} from '${mockUrl}';`)
            .replace(/import\('gi:\/\/(\w+)(\?[^']*)?'\)/g, `import('${mockUrl}').then(m => ({default: m.$1}))`);
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
    check(mock.unredirect.held === 0, 'resting cursor: no hold on direct scanout');

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
        check(mock.unredirect.held === 1, `${style}: keeps GNOME drawing over full-screen apps while showing`);
        shot(`ripple-${style}`, 700, 300, 200, 200, 1.5);
        advance(1000);
        check(findAll(a => a._canvas).length === 0, `${style}: ripple removed when done`);
        check(mock.unredirect.held === 0, `${style}: lets GNOME go back to direct scanout after`);
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

    // --- low battery warning ---
    advance(100);
    battery.Percentage = 8; battery.State = 2;
    battery.proxy.emit('g-properties-changed');
    advance(1200);
    const fire = findAll(a => a._canvas);
    check(fire.length === 1 && fire[0].y > 900, 'battery 8% and discharging: low battery warning along the bottom');
    shot('battery-low', 0, 880, 1920, 200, 0.5);
    battery.State = 1;                       // plugged in
    battery.proxy.emit('g-properties-changed');
    advance(1500);
    check(findAll(a => a._canvas).length === 0, 'plugged in: warning goes away');
    config({desktop: {batteryKeepBurning: false}});
    advance(300);
    battery.State = 2; battery.Percentage = 9;
    battery.proxy.emit('g-properties-changed');
    advance(1500);
    check(findAll(a => a._canvas).length === 1, 'burst mode: warning when it drops below the level');
    advance(9000);
    check(findAll(a => a._canvas).length === 0, 'burst mode: warning stops after a few seconds');
    battery.Percentage = 8.4;
    battery.proxy.emit('g-properties-changed');
    advance(1200);
    check(findAll(a => a._canvas).length === 1, 'burst mode: warns again one percent lower');
    advance(10000);
    battery.State = 1; battery.proxy.emit('g-properties-changed');
    advance(1500);

    // --- charged ---
    battery.State = 1; battery.Percentage = 97;
    battery.proxy.emit('g-properties-changed');
    advance(1200);
    check(findAll(a => a._canvas).length === 0, 'charging at 97%: nothing yet');
    battery.Percentage = 100; battery.State = 4;
    battery.proxy.emit('g-properties-changed');
    advance(600);
    const charged = findAll(a => a._canvas);
    check(charged.length === 1 && charged[0].y > 700, 'charged to 100%: battery fills up at the bottom of the screen');
    shot('battery-charged', 660, 700, 600, 380, 0.8);
    advance(3000);
    battery.proxy.emit('g-properties-changed'); advance(1200);
    check(findAll(a => a._canvas).length === 0, 'charged: plays only once while it stays plugged in');
    config({desktop: {batteryFullLevel: 80}});
    advance(300);
    battery.State = 2; battery.Percentage = 99; battery.proxy.emit('g-properties-changed'); advance(1200);
    battery.Percentage = 70; battery.proxy.emit('g-properties-changed'); advance(1200);
    battery.State = 1; battery.Percentage = 79; battery.proxy.emit('g-properties-changed'); advance(1200);
    check(findAll(a => a._canvas).length === 0, 'level 80%: not at 79%');
    battery.Percentage = 80; battery.proxy.emit('g-properties-changed'); advance(400);
    check(findAll(a => a._canvas).length === 1, 'level 80%: plays when charging reaches 80%');
    advance(3000);
    config({});
    advance(300);
    noErrors('battery');

    // --- clipboard ---
    pointer.x = 900; pointer.y = 500;
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_CLIPBOARD,
        new mock.SelectionSource(['text/plain;charset=utf-8', 'UTF8_STRING']));
    advance(200);
    const copied = findAll(a => a._canvas);
    check(copied.length === 1 && Math.abs(copied[0].x + copied[0].width / 2 - 900) < 120, 'text copied: copy animation by the cursor');
    shot('clip-copy', 820, 400, 200, 160, 2);
    advance(1200);
    mock.clipboardData.set('x-special/gnome-copied-files', 'cut\nfile:///home/u/a.txt');
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_CLIPBOARD,
        new mock.SelectionSource(['x-special/gnome-copied-files', 'text/uri-list']));
    advance(300);
    check(findAll(a => a._canvas).length === 1, 'files cut in Files: cut animation');
    shot('clip-cut', 820, 400, 240, 160, 2);
    advance(1200);
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_CLIPBOARD,
        new mock.SelectionSourceMemory(['text/plain']));
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_PRIMARY,
        new mock.SelectionSource(['text/plain']));
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_CLIPBOARD, null);
    advance(300);
    check(findAll(a => a._canvas).length === 0, 'GNOME keeping the clipboard / selecting text / clearing it: nothing');
    config({desktop: {clipboard: ['cut']}});
    advance(300);
    mock.selection.emit('owner-changed', mock.Meta.SelectionType.SELECTION_CLIPBOARD, new mock.SelectionSource(['text/plain']));
    advance(300);
    check(findAll(a => a._canvas).length === 0, 'copy switched off: no copy animation');
    config({});
    advance(300);
    noErrors('clipboard');

    // --- previews from the app, with the switch OFF ---
    allOff();
    advance(1100);
    check(mock.idleWatchCount() === 0 && display.handlerCount() === 0, 'switch off again: input watching removed');
    for (const p of ['trail comet', 'trail rainbow', 'trail sparkles', 'trail stars', 'ripple shockwave', 'slam', 'cross', 'lowbattery', 'charged', 'copy', 'cut', 'combo']) {
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
    ext._onPreview('lowbattery');
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
    check(mock.unredirect.held === 0, 'disable: unredirect hold released');
    check(battery.proxy.handlerCount() === 0, 'disable: battery signal disconnected');
    check(!fs.has('/run/user/1000/lumora/desktop-fx@local.running'), 'disable: running marker removed');
    check(mock.dirMonitorCount() === 0, 'disable: settings watcher removed');
    check(mock.selection.handlerCount() === 0, 'disable: clipboard watch removed');
    noErrors('disable');
    // And enable again works.
    ext.enable();
    advance(1500);
    ext.disable();
    advance(100);
    noErrors('re-enable');
}

// ======================================================================
if (which === 'edge') {
    console.log('Edge Portal');
    const {Ext, meta} = await loadExtension('edge-portal@local');
    const ext = new Ext(meta);
    ext.enable();
    advance(100);
    pointer.x = 1800; pointer.y = 500;
    advance(200);
    check(stage().length === 0 && mock.barriers.size === 0, 'switch off: no barriers, nothing drawn');
    fs.set('/run/user/1000/edge-portal-on', '');
    advance(1100);
    check(mock.barriers.size > 0, `switch on: ${mock.barriers.size} edge barriers`);
    pointer.x = 1910; advance(32);
    pointer.x = 1950; advance(32);                 // onto the right-hand monitor
    check(findAll(a => a._canvas).length === 2, 'crossing: exit + entry halves drawn');
    check(mock.unredirect.held === 1, 'crossing: shown over a maximised app on the other screen');
    shot('edge-cross', 1500, 200, 900, 600, 0.6);
    advance(3000);
    check(stage().length === 0 && mock.unredirect.held === 0, 'crossing: cleaned up, hold released');
    for (const b of mock.barriers)
        b.emit('hit', {x: 0, y: 600, dx: -20, dy: 0});
    advance(50);
    check(stage().length > 0 && mock.unredirect.held === 1, 'barrier glow: shown and held');
    advance(2000);
    check(stage().length === 0 && mock.unredirect.held === 0, 'barrier glow: cleaned up, hold released');
    pointer.x = 1900; advance(32); pointer.x = 1940; advance(32);
    ext.disable();
    check(stage().length === 0, 'disable: every actor removed');
    check(mock.unredirect.held === 0, 'disable: unredirect hold released');
    check(mock.barriers.size === 0, 'disable: barriers removed');
    check(mock.dirMonitorCount() === 0, 'disable: settings watcher removed');
    noErrors('edge portal');
}

if (which === 'system') {
    console.log('System FX');
    const {Ext, meta} = await loadExtension('system-fx@local');
    const settle = async () => {
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setImmediate(r));
            advance(20);
        }
    };
    const NMS = mock.NM.ActiveConnectionState;
    const dev = new mock.Device('aa:aa');
    const home = new mock.ActiveConnection('802-11-wireless', 'HomeNet', NMS.ACTIVATED, dev);
    mock.nmClient.acs = [home];
    const phones = new mock.BtDevice('/org/bluez/hci0/dev_1', 'Headphones', true);
    mock.btDevices.push(phones);
    const ext = new Ext(meta);
    check(JSON.stringify(meta['session-modes']) === '["user","unlock-dialog"]', 'keeps running on the lock screen (session-modes)');
    ext.enable();
    await settle();
    advance(1000);
    check(mock.nmClient.handlerCount() === 0 && mock.mixer.handlerCount() === 0 &&
        mock.Main.screenShield.handlerCount() === 0, 'switches off: watches nothing');

    for (const k of ['connections', 'sound', 'lock'])
        fs.set(`/run/user/1000/system-fx-${k}-on`, '');
    advance(1100);
    await settle();
    check(mock.nmClient.handlerCount() > 0 && mock.btClients.length === 1, 'connections on: NetworkManager + Bluetooth watched');
    check(stage().length === 0, 'nothing plays for what was already connected');
    advance(4500);                                   // past the settle time
    const playing = () => findAll(a => a._canvas);
    const label = () => findAll(a => a.text)[0]?.text;

    // Wi-Fi off, nothing else connecting: wifi-off after the short wait.
    home.setState(NMS.DEACTIVATED);
    advance(500);
    check(playing().length === 0, 'Wi-Fi off: waits a moment in case it is switching');
    advance(2500);
    check(playing().length === 1 && label() === 'HomeNet', `Wi-Fi off: animation with the name (${label()})`);
    const a0 = playing()[0];
    const [ax, ay] = a0.absPos();
    check(Math.abs(ax + a0.width / 2 - 960) < 3 && ay >= 32 && ay < 80, `status animations sit at the top middle, under the top bar (${ax}, ${ay})`);
    shot('sys-wifi-off', 700, 0, 520, 420, 1);
    advance(2500);
    mock.nmClient.removeAc(home);

    // Wi-Fi on.
    const office = new mock.ActiveConnection('802-11-wireless', 'Office', NMS.ACTIVATING, dev);
    mock.nmClient.add(office);
    advance(300);
    office.setState(NMS.ACTIVATED);
    advance(300);
    check(playing().length === 1 && label() === 'Office', 'Wi-Fi on: animation with the name');
    advance(2500);

    // Switch: Office goes down while Cafe is connecting, then Cafe comes up.
    const cafe = new mock.ActiveConnection('802-11-wireless', 'Cafe', NMS.ACTIVATING, dev);
    mock.nmClient.add(cafe);
    office.setState(NMS.DEACTIVATED);
    mock.nmClient.removeAc(office);
    advance(4000);
    check(playing().length === 0, 'switching: no "disconnected" while the next network connects');
    cafe.setState(NMS.ACTIVATED);
    advance(300);
    check(playing().length === 1 && label() === 'Cafe', 'switching networks: the switch animation (to Cafe)');
    shot('sys-wifi-switch', 650, 0, 620, 420, 1);
    advance(3000);

    // Same network, different access point.
    dev.roam('bb:bb');
    advance(300);
    check(playing().length === 1, 'moved to another access point of the same network: switch animation');
    advance(3000);
    dev.roam('cc:cc');
    advance(300);
    check(playing().length === 0, 'roaming again right away: not repeated');
    advance(3000);

    // VPN.
    const vpn = new mock.ActiveConnection('wireguard', 'Work VPN', NMS.ACTIVATING);
    mock.nmClient.add(vpn);
    vpn.setState(NMS.ACTIVATED);
    advance(300);
    check(playing().length === 1 && label() === 'Work VPN', 'VPN (WireGuard) on');
    advance(3000);
    vpn.setState(NMS.DEACTIVATED);
    advance(300);
    check(playing().length === 1, 'VPN off');
    advance(3000);
    const eth = new mock.ActiveConnection('802-3-ethernet', 'Wired', NMS.ACTIVATING);
    mock.nmClient.add(eth);
    eth.setState(NMS.ACTIVATED);
    advance(300);
    check(playing().length === 0, 'wired ethernet: ignored');

    // Bluetooth.
    phones.setConnected(false);
    advance(300);
    check(playing().length === 1 && label() === 'Headphones', 'Bluetooth device disconnects');
    advance(3000);
    const mouse = new mock.BtDevice('/org/bluez/hci0/dev_2', 'Mouse', false);
    mock.btDevices.push(mouse);
    mock.btClients[0].emit('device-added', mouse);
    mouse.setConnected(true);
    advance(300);
    check(playing().length === 1 && label() === 'Mouse', 'Bluetooth device connects');
    advance(3000);
    noErrors('connections');

    // Sound.
    const {sink, source} = mock.mixer;
    const vol = (v, name) => {
        sink.set({volume: v});
        advance(60);
        const n = playing().length;
        advance(1700);
        return n;
    };
    check(vol(40000) === 1, 'volume up');
    check(vol(35000) === 1, 'volume down');
    sink.set({volume: 65536});
    advance(100);
    shot('sys-vol-max', 750, 0, 420, 420, 1);
    check(playing().length === 1, 'volume to 100%');
    advance(1700);
    check(vol(0) === 1, 'volume to 0%');
    sink.set({is_muted: true}); advance(100);
    check(playing().length === 1, 'mute');
    advance(1500);
    sink.set({is_muted: false}); advance(100);
    check(playing().length === 1, 'unmute');
    advance(1500);
    source.set({is_muted: true}); advance(100);
    check(playing().length === 1, 'mic mute');
    advance(1500);
    source.set({is_muted: false}); advance(100);
    check(playing().length === 1, 'mic unmute');
    advance(1500);
    // Holding the volume key: lots of changes, no pile-up.
    for (let i = 1; i <= 10; i++) {
        sink.set({volume: 1000 * i}); advance(30);
    }
    check(playing().length === 1, 'holding the volume key: one animation at a time');
    advance(2000);
    // New output device: its volume is the new baseline.
    mock.mixer.sink = new mock.Stream(20000);
    mock.mixer.emit('default-sink-changed');
    mock.mixer.sink.set({volume: 25000});
    advance(100);
    check(playing().length === 0, 'headphones plugged in: no animation for the volume jump');
    advance(1000);
    mock.mixer.sink.set({volume: 30000}); advance(100);
    check(playing().length === 1, 'then volume up on the new device animates');
    advance(2000);
    config({system: {sound: ['vol-max']}});
    advance(300);
    check(vol(31000) === 0, 'volume up switched off in settings: nothing');
    config({});
    advance(300);
    noErrors('sound');

    // Lock screen.
    const shield = mock.Main.screenShield;
    shield.locked = true; mock.Main.sessionMode.isLocked = true; shield.emit('locked-changed');
    advance(300);
    const lockAnim = playing()[0];
    check(lockAnim && Math.abs(lockAnim.absPos()[0] + lockAnim.width / 2 - 960) < 5, 'lock: padlock in the middle of the screen');
    shot('sys-lock', 660, 240, 600, 600, 0.7);
    // On the lock screen: no names under connection animations.
    phones.setConnected(true);
    advance(300);
    check(findAll(a => a.text).length === 0, 'locked: device names are not shown');
    advance(2500);
    shield.locked = false; mock.Main.sessionMode.isLocked = false; shield.emit('locked-changed');
    advance(300);
    check(playing().length === 1, 'unlock');
    advance(2500);
    noErrors('lock');

    // Each switch only its own group.
    fs.delete('/run/user/1000/system-fx-sound-on');
    advance(1100);
    check(mock.mixer.handlerCount() === 0 && mock.nmClient.handlerCount() > 0, 'Sound off alone: stops sound only');
    sink.set({volume: 50000}); advance(100);
    check(playing().length === 0, 'Sound off: volume changes ignored');
    fs.set('/run/user/1000/system-fx-sound-on', '');
    advance(1100);

    // Previews ignore the switches.
    for (const k of ['connections', 'sound', 'lock'])
        fs.delete(`/run/user/1000/system-fx-${k}-on`);
    advance(1100);
    for (const name of ['wifi-on', 'wifi-off', 'wifi-switch', 'bt-on', 'bt-off', 'vpn-on', 'vpn-off',
        'vol-up', 'vol-down', 'vol-max', 'vol-zero', 'mute', 'unmute', 'mic-mute', 'mic-unmute', 'lock', 'unlock']) {
        ext._onPreview(`preview ${name}`);
        advance(100);
        check(playing().length === 1, `preview ${name}`);
        advance(2600);
    }
    check(stage().length === 0 && mock.unredirect.held === 0, 'previews: all cleaned up, hold released');
    noErrors('previews');

    // Disable in the middle of things.
    for (const k of ['connections', 'sound', 'lock'])
        fs.set(`/run/user/1000/system-fx-${k}-on`, '');
    advance(1100);
    await settle();
    ext._onPreview('preview unlock');
    advance(200);
    home.setState(NMS.DEACTIVATED);
    ext.disable();
    check(stage().length === 0, 'disable: every actor removed');
    check(mock.pendingSources() === 0, `disable: no timers left (${mock.pendingSources()})`);
    check(mock.runningTimelines() === 0, 'disable: no animations left running');
    check(mock.unredirect.held === 0, 'disable: unredirect hold released');
    check(mock.nmClient.handlerCount() === 0 && mock.btClients.every(c => c.handlerCount() === 0) &&
        mock.mixer.handlerCount() === 0 && mock.Main.screenShield.handlerCount() === 0 &&
        [sink, source, mock.mixer.sink, phones, mouse, dev, vpn, cafe].every(o => o.handlerCount() === 0),
    'disable: every signal disconnected');
    check(mock.dirMonitorCount() === 0, 'disable: settings watcher removed');
    noErrors('disable');
}

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
        check(mock.unredirect.held === 1, `${name}: shown over full-screen apps`);
        check(!findAll(a => a.text === 'Command failed').length, `${name}: no plain warning banner on top of it`);
        shot(`term-${name}`, 0, 0, 1920, 1080, 0.3);
        advance(4000);
        check(stage().length === 0, `${name}: cleaned up`);
        check(mock.unredirect.held === 0, `${name}: hold released`);
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
