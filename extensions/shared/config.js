// Shared live settings for the Lumora extensions.
// SINGLE SOURCE: install.sh copies this file into each extension when building.
// Settings live in ~/.config/lumora/config.json (written by the Lumora
// app). The file is watched, so changes apply instantly with no logout.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'lumora']);
export const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);

export class LiveConfig {
    constructor(section, defaults, onChange = null) {
        this._section = section;
        this._defaults = defaults;
        this._onChange = onChange;
        this._reloadId = 0;
        this.values = {...defaults};
        try {
            GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        } catch (e) {}
        this._load();
        try {
            this._monitor = Gio.File.new_for_path(CONFIG_DIR)
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', () => this._queueReload());
        } catch (e) {
            console.warn(`Lumora: cannot watch settings: ${e}`);
            this._monitor = null;
        }
    }

    _queueReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._reloadId = 0;
            this._load();
            try {
                this._onChange?.(this.values);
            } catch (e) {
                console.error(`Lumora: settings change failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _load() {
        const v = {...this._defaults};
        try {
            const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
            if (ok) {
                const sec = JSON.parse(new TextDecoder().decode(bytes))?.[this._section];
                if (sec && typeof sec === 'object') {
                    for (const k of Object.keys(this._defaults)) {
                        const d = this._defaults[k];
                        if (k in sec && typeof sec[k] === typeof d &&
                            Array.isArray(sec[k]) === Array.isArray(d))
                            v[k] = sec[k];
                    }
                }
            }
        } catch (e) {
            // Missing or half-written file: keep defaults.
        }
        this.values = v;
    }

    destroy() {
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }
        this._monitor?.cancel();
        this._monitor = null;
    }
}

// Tiny localhost-only listener: calls onLine(text) for each message.
export function listen(port, onLine) {
    const service = new Gio.SocketService();
    const addr = Gio.InetSocketAddress.new_from_string('127.0.0.1', port);
    service.add_address(addr, Gio.SocketType.STREAM, Gio.SocketProtocol.TCP, null);
    service.connect('incoming', (_s, conn) => {
        const input = new Gio.DataInputStream({base_stream: conn.get_input_stream()});
        input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line)
                    onLine(line.slice(0, 500));
            } catch (e) {
                console.warn(`Lumora: bad message: ${e}`);
            }
            try {
                conn.close(null);
            } catch (e) {}
        });
        return true;
    });
    service.start();
    return service;
}
