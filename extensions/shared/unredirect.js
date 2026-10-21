// Keeps Lumora's overlays visible on top of apps.
// SINGLE SOURCE: install.sh copies this file into each extension when building.
//
// When one app covers a whole monitor (e.g. a maximised window on a screen
// with no top bar), GNOME shows it directly ("unredirect" / direct scanout)
// and skips drawing the shell on that screen, so anything we draw is hidden.
// GNOME's own pop-ups turn that off while they are showing; so do we, but
// only while something of ours is actually on screen.

import Meta from 'gi://Meta';

export class Unredirect {
    constructor() {
        this._held = false;
    }

    // busy = true while we have something on screen.
    set(busy) {
        if (busy === this._held)
            return;
        try {
            if (busy) {
                if (global.compositor?.disable_unredirect)      // GNOME 48+
                    global.compositor.disable_unredirect();
                else
                    Meta.disable_unredirect_for_display(global.display);
            } else if (global.compositor?.enable_unredirect) {
                global.compositor.enable_unredirect();
            } else {
                Meta.enable_unredirect_for_display(global.display);
            }
            this._held = busy;
        } catch (e) {
            console.warn(`Lumora: cannot change unredirect: ${e}`);
        }
    }

    // Always call from disable(): GNOME counts these, so never leave one held.
    release() {
        this.set(false);
    }
}
