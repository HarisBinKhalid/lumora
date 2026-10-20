# Lumora Terminal FX — prefix any command with `fx` to get confetti when it
# succeeds or a warning banner when it fails. git push/pull/commit/merge get
# their own animations, and commands that ran over a minute get fireworks.
#
#   fx make build
#   fx npm test
#   fx eval "npm run lint && npm test"   (for pipelines / && chains)
#
# Works locally (GNOME Terminal, VS Code terminal, ...) and over SSH when the
# port below is forwarded back to your laptop (see setup notes).

TERM_FX_PORT="${TERM_FX_PORT:-47321}"

_term_fx_send() {
    if [ -n "$BASH_VERSION" ]; then
        { printf '%s\n' "$1" >"/dev/tcp/127.0.0.1/$TERM_FX_PORT"; } 2>/dev/null && return 0
    fi
    if command -v nc >/dev/null 2>&1; then
        printf '%s\n' "$1" | nc -w 1 127.0.0.1 "$TERM_FX_PORT" >/dev/null 2>&1 && return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import socket,sys
s=socket.create_connection(("127.0.0.1",int(sys.argv[1])),timeout=1)
s.sendall((sys.argv[2]+"\n").encode()); s.close()' "$TERM_FX_PORT" "$1" >/dev/null 2>&1
    fi
    return 0
}

fx() {
    if [ $# -eq 0 ]; then
        echo "usage: fx <command> [args...]" >&2
        return 2
    fi
    local start=$SECONDS
    "$@"
    local rc=$?
    local took=$((SECONDS - start))   # seconds, for the long-command fireworks
    local cmd="$*"
    cmd="${cmd//$'\n'/ }"
    if [ "$rc" -eq 0 ]; then
        _term_fx_send "success 0 d=$took $cmd"
    elif [ "$rc" -ne 130 ]; then   # 130 = you pressed Ctrl+C: stay quiet
        _term_fx_send "fail $rc d=$took $cmd"
    fi
    return "$rc"
}

# The trailing space lets your aliases work after fx (e.g. `fx ll`).
alias fx='fx '
