# Tests the "every command" hook in shell/fx.sh: drives a real interactive
# bash (in a pty) that sourced fx.sh, with a throwaway config, and records
# what it sends to a fake Terminal FX listener on a spare port.
# Usage:  python3 tools/test-fx-hook.py   (from the repo root)
import os, pty, re, socket, sys, threading, time, json, tempfile, select
FX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'shell', 'fx.sh')
got = []
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(50)
port = srv.getsockname()[1]
def serve():
    while True:
        c, _ = srv.accept()
        got.append(c.recv(1000).decode().strip()); c.close()
threading.Thread(target=serve, daemon=True).start()

def run(mode, lines, prompt_command=None, env_all=False):
    cfg = tempfile.mkdtemp()
    os.makedirs(f"{cfg}/lumora")
    json.dump({"terminal": {"commandMode": mode}}, open(f"{cfg}/lumora/config.json", "w"), indent=2)
    rc = tempfile.mktemp()
    with open(rc, "w") as f:
        if prompt_command:
            f.write(prompt_command + "\n")
        f.write(f"source {FX}\nPS1='$ '\n")
    env = dict(os.environ, XDG_CONFIG_HOME=cfg, TERM_FX_PORT=str(port), HOME=cfg, TERM="dumb")
    env.pop("PROMPT_COMMAND", None)
    if env_all: env["TERM_FX_ALL"] = "1"
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("bash", ["bash", "--rcfile", rc, "-i"], env)
    out = b""
    def drain(t=0.4):
        nonlocal out
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try: out += os.read(fd, 4096)
                except OSError: return
    drain(0.8)
    got.clear()
    for l in lines:
        os.write(fd, (l + "\n").encode()); drain(0.5 if "sleep" not in l else 2.6)
    os.write(fd, b"exit\n"); drain(0.3)
    os.waitpid(pid, 0)
    return list(got), out.decode(errors="replace")

ok = True
def expect(name, actual, wanted):
    global ok
    # $SECONDS is whole seconds: a quick command can show d=1 on a tick.
    actual = [re.sub(r" d=1 (?!sleep)", " d=0 ", m) for m in actual]
    good = actual == wanted
    ok &= good
    print(("  ok  " if good else "FAIL  ") + name + ("" if good else f"\n      got:  {actual}\n      want: {wanted}"))

got1, _ = run("all", ["true", "", "false", "fx true", "git --version", "sleep 2", "echo a | cat >/dev/null"])
expect("every command: each reported once, empty Enter ignored, fx not doubled", got1,
       ["success 0 d=0 true", "fail 1 d=0 false", "success 0 d=0 true",
        "success 0 d=0 git --version", "success 0 d=2 sleep 2", "success 0 d=0 echo a"])
got2, _ = run("fx", ["true", "false", "fx true", ""])
expect("fx-only mode: only the fx command reported", got2, ["success 0 d=0 true"])
got3, _ = run("all", ["true", "false"], prompt_command="PROMPT_COMMAND='echo -n; ' ")
expect("works with an existing PROMPT_COMMAND ending in ;", got3, ["success 0 d=0 true", "fail 1 d=0 false"])
got4, _ = run("all", ["true", ""], prompt_command="PROMPT_COMMAND=(':' 'true')")
expect("works with bash 5.1 array PROMPT_COMMAND", got4, ["success 0 d=0 true"])
got5, _ = run("fx", ["true"], env_all=True)
expect("TERM_FX_ALL=1 (for servers) turns it on without the app", got5, ["success 0 d=0 true"])
print("all hook checks passed" if ok else "HOOK CHECKS FAILED")
sys.exit(0 if ok else 1)
