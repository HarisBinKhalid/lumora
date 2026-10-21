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

# ---- Every command (optional) ----
# When "Every command" is picked under Terminal FX in the Lumora app, commands
# typed WITHOUT fx get animations too. On a server over SSH (no Lumora app
# there) set TERM_FX_ALL=1 in that server's ~/.bashrc instead.
# Bash only. Uses a DEBUG trap + PROMPT_COMMAND, and only bash built-ins at
# each prompt (no extra processes), so the prompt stays fast.

_term_fx_all_on() {
    [ "${TERM_FX_ALL:-}" = 1 ] && return 0
    local f="${XDG_CONFIG_HOME:-$HOME/.config}/lumora/config.json" json=""
    [ -r "$f" ] || return 1
    IFS= read -r -d '' json < "$f"
    [[ $json =~ \"commandMode\"[[:space:]]*:[[:space:]]*\"all\" ]]
}

# Runs before every command bash executes; remembers the first one typed at
# the prompt. _term_fx_ready is 1 while bash waits at the prompt.
_term_fx_preexec() {
    case "$BASH_COMMAND" in
        _term_fx_precmd*|_term_fx_end*) return 0 ;;
    esac
    [ "$_term_fx_ready" = 1 ] || return 0
    [ -n "${COMP_LINE:-}" ] && return 0           # tab completion
    _term_fx_ready=0
    _term_fx_start=$SECONDS
    case "$BASH_COMMAND" in
        fx|fx\ *) _term_fx_cmd="" ;;               # fx reports it itself
        *) _term_fx_cmd="$BASH_COMMAND" ;;
    esac
}

# Runs first thing at every prompt: report the command that just finished.
_term_fx_precmd() {
    local rc=$?
    if [ "$_term_fx_ready" = 0 ] && [ -n "$_term_fx_cmd" ] &&
       [ "$rc" -ne 130 ] && [ "$rc" -ne 148 ] && _term_fx_all_on; then
        local took=$((SECONDS - _term_fx_start)) cmd="${_term_fx_cmd//$'\n'/ }" msg
        if [ "$rc" -eq 0 ]; then
            msg="success 0 d=$took $cmd"
        else
            msg="fail $rc d=$took $cmd"
        fi
        # Only bash's built-in /dev/tcp here: never start a process per prompt.
        { printf '%s\n' "$msg" >"/dev/tcp/127.0.0.1/$TERM_FX_PORT"; } 2>/dev/null
    fi
    _term_fx_ready=0          # ignore the other prompt commands...
    _term_fx_cmd=""
    return "$rc"
}

_term_fx_end() {              # ...until the prompt is back
    _term_fx_ready=1
}

# Install once, in interactive bash, unless something else already owns the
# DEBUG trap (then "every command" just doesn't apply in that shell).
if [ -n "$BASH_VERSION" ] && [[ $- == *i* ]] && [ -z "${_term_fx_hooked:-}" ] &&
   [ -z "$(trap -p DEBUG)" ]; then
    _term_fx_hooked=1
    _term_fx_ready=1
    trap '_term_fx_preexec' DEBUG
    if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
        PROMPT_COMMAND=(_term_fx_precmd "${PROMPT_COMMAND[@]}" _term_fx_end)   # bash 5.1+ array form
    else
        _term_fx_pc="${PROMPT_COMMAND:-}"
        while [[ "$_term_fx_pc" =~ [[:space:]\;]$ ]]; do _term_fx_pc="${_term_fx_pc%?}"; done
        PROMPT_COMMAND="_term_fx_precmd${_term_fx_pc:+; $_term_fx_pc}; _term_fx_end"
        unset _term_fx_pc
    fi
fi
