#!/usr/bin/env bash
# Lumora installer: builds the extensions from source, installs them, the
# settings app, and the fx command. Safe to run again after every change.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$DIR/build"
APPDIR="$HOME/.local/share/lumora"
CONF="$HOME/.config/lumora"
EXTENSIONS=(edge-portal@local term-fx@local desktop-fx@local system-fx@local)

echo "== Lumora installer =="

if ! python3 -c "import gi; gi.require_version('Gtk','4.0'); gi.require_version('Adw','1')" 2>/dev/null; then
    echo
    echo "The Lumora app needs GTK 4 and libadwaita for Python. Install them with:"
    echo "    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1"
    echo "then run ./install.sh again."
    exit 1
fi
command -v zip >/dev/null || { echo "Please install zip first:  sudo apt install zip"; exit 1; }

echo "- Building extensions"
rm -rf "$BUILD"
mkdir -p "$BUILD"
for uuid in "${EXTENSIONS[@]}"; do
    stage="$BUILD/$uuid"
    cp -r "$DIR/extensions/$uuid" "$stage"
    cp "$DIR"/extensions/shared/*.js "$stage/"   # shared modules (config.js, draw.js)
    (cd "$stage" && zip -qr "$BUILD/$uuid.zip" .)
done

echo "- Installing extensions"
for uuid in "${EXTENSIONS[@]}"; do
    gnome-extensions install --force "$BUILD/$uuid.zip"
    gnome-extensions enable "$uuid" 2>/dev/null || python3 - "$uuid" << 'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
                     capture_output=True, text=True).stdout.strip()
lst = ast.literal_eval(cur.replace("@as ", "")) if cur else []
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)])
PY
done

echo "- Installing the Lumora app"
mkdir -p "$APPDIR" "$CONF" "$HOME/.local/share/applications"
cp "$DIR/app/lumora.py" "$DIR/app/lumora.svg" "$APPDIR/"
chmod +x "$APPDIR/lumora.py"
cat > "$HOME/.local/share/applications/local.lumora.Settings.desktop" << DESKTOP
[Desktop Entry]
Type=Application
Name=Lumora
Comment=Screen animations for your desktop, terminal and system events
Exec=python3 $APPDIR/lumora.py
Icon=$APPDIR/lumora.svg
Categories=Settings;Utility;
StartupNotify=true
StartupWMClass=local.lumora.Settings
DESKTOP

echo "- Installing the fx command"
cp "$DIR/shell/fx.sh" "$CONF/fx.sh"
if grep -q 'term-fx/fx.sh' "$HOME/.bashrc" 2>/dev/null; then
    sed -i 's#~/.config/term-fx/fx.sh#~/.config/lumora/fx.sh#' "$HOME/.bashrc"
elif ! grep -q 'lumora/fx.sh' "$HOME/.bashrc" 2>/dev/null; then
    echo 'source ~/.config/lumora/fx.sh' >> "$HOME/.bashrc"
fi

# ---- Clean up the older "Screen FX" install, keeping your settings ----
if [ -f "$HOME/.config/screen-fx/config.json" ] && [ ! -f "$CONF/config.json" ]; then
    cp "$HOME/.config/screen-fx/config.json" "$CONF/config.json"
fi
rm -rf "$HOME/.config/screen-fx" "$HOME/.local/share/screen-fx" "$HOME/.config/term-fx"
rm -f "$HOME/.local/share/applications/local.screenfx.Settings.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo
echo "Done! Opening Lumora — it will tell you if you need to log out."
nohup python3 "$APPDIR/lumora.py" >/dev/null 2>&1 &
