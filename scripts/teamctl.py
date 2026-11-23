#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""teamctl — broker 在册团队启停器（检修腾算力用）

用途：模型/代码检修时，把 broker 在册的其他团队优雅停掉，腾出模型算力；检修完再原样拉起。

授权与使用边界（用户 2026-11-24 令）：
  * 本工具**仅总务（元枢）使用**，不向其他团队开放。
  * 检修窗一经总务排定，**直接执行**：不再向各团队发通告、不征求许可与回执。
    ——这是 11-17《检修通告规》的明确例外，仅限本工具的团队停/起；该规其余情形照旧。
  * 无紧急情况时，检修窗排在 **20:00–04:00**；紧急时由总务裁决破例
    （`stop-all` 在非窗口时段需显式 `--emergency`）。
  * 停/起都是优雅停机 + 原样拉起，各团队在中断位置**断点续跑**，用户数据零改动。

安全边界（为什么数据不丢）：
  * 只调 controller 官方团队控制 API（ds-headbot POST /teams/<id>/{start|stop|restart}），
    由 manager.stopTeam() 执行：SIGTERM 进程树 → 等关闭 → 清 runtime pid → phase=stopped。
    它不碰 teams.json、不碰 teams/<id>/{home,workspace}、不删任何文件。
  * 显式停止会置 runtime.explicitStop=true，controller 的 autoStart 自动重启腿因此不再拉起
    （这正是本工具比“直接 kill 进程”安全的理由：直接 kill 会被 respawn）。
  * 每次停/起前后各做一次 teams/<id> 目录指纹（文件数+字节数），不一致立即报“数据面变化”，
    避免静默丢件。

用法：
  teamctl status                        # 只读：列全部团队状态
  teamctl stop <id> [<id>...]           # 停团队（默认排除 default）
  teamctl start <id> [<id>...]          # 起团队
  teamctl restart <id> [<id>...]
  teamctl stop-all [--keep <id>...] [--yes]   # 停全部业务团队（检修模式，controller 永不停）
  teamctl start-all                     # 全部拉起
  teamctl logs <id> [n]                 # 看某团队日志尾（默认 40 行）

退出码：0 成功 / 1 失败（stderr 给原因）。
留痕：workspace/logs/teamctl/teamctl.jsonl（每次调用一行 JSON）。
"""

import http.client
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
# 路径全部可用环境变量覆盖，便于在别的 headbot 实例（不同 home / 端口 / 日志位）上复用。
CONTROLLER_LOG = Path(os.environ.get("DSH_SERVER_LOG") or HOME / "Library/Logs/DeepSeekHarness/server.log")
HEADBOT_ROOT = Path(
    os.environ.get("HEADBOT_ROOT")
    or HOME / "Library/Application Support/DeepSeekHarness/headbot"
)
TEAMS_DIR = HEADBOT_ROOT / "teams"
TEAM_LOGS = HEADBOT_ROOT / "logs"
# 留痕与持久停止状态：不写包内（node_modules 可能只读），也不写 ~/Library/Logs
# （沙箱/权限可能拒绝），默认落 DSH_HOME 下的 bot workspace。
DSH_HOME = Path(os.environ.get("DSH_HOME") or HOME / "Library/Application Support/DeepSeekHarness")
TRACE_DIR = Path(os.environ.get("TEAMCTL_TRACE_DIR") or DSH_HOME / "bot" / "workspace" / "logs" / "teamctl")

INNER_HOST = os.environ.get("DSH_HOST") or "127.0.0.1"
INNER_PORT = int(os.environ.get("DSH_INGRESS_PORT") or 3180)
PUBLIC_HOST = os.environ.get("DSH_PUBLIC_HOST") or "192.168.1.5"
API_PREFIX = "/dsh/api/ds-headbot/v1"
DEFAULT_TEAM = "default"


def die(msg, code=1):
    print(f"teamctl: {msg}", file=sys.stderr)
    sys.exit(code)


def log_trace(cmd, args, rc, note, before=None, after=None):
    try:
        TRACE_DIR.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            "cmd": cmd,
            "args": args,
            "rc": rc,
            "note": note,
        }
        if before is not None:
            rec["data_before"] = before
        if after is not None:
            rec["data_after"] = after
        with (TRACE_DIR / "teamctl.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass  # 留痕失败不阻断操作


def latest_token():
    """controller 每次启动在 server.log 打印带 token 的 launch URL；取最新一条。"""
    try:
        text = CONTROLLER_LOG.read_text(errors="ignore")
    except OSError as exc:
        die(f"读不到 controller 日志 {CONTROLLER_LOG}: {exc}")
    found = re.findall(r"token=([A-Za-z0-9_\-]{16,})", text)
    if not found:
        die(f"{CONTROLLER_LOG} 里没有可用的 launch token")
    return found[-1]


def request(method, path, cookie=None, body=None, timeout=30):
    conn = http.client.HTTPConnection(INNER_HOST, INNER_PORT, timeout=timeout)
    headers = {"Host": PUBLIC_HOST, "Origin": f"http://{PUBLIC_HOST}"}
    if cookie:
        headers["Cookie"] = cookie
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    try:
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, data, resp.getheader("Set-Cookie")
    finally:
        conn.close()


def login():
    token = latest_token()
    status, _data, set_cookie = request("GET", f"/dsh/?token={token}")
    if not set_cookie or status not in (200, 302, 303):
        die(f"controller 登录失败（HTTP {status}，token 可能已随重启轮转）")
    return set_cookie.split(";")[0]


def api(method, route, cookie, body=None):
    status, data, _ = request(method, API_PREFIX + route, cookie, body)
    try:
        payload = json.loads(data) if data else {}
    except json.JSONDecodeError:
        payload = {"raw": data.decode("utf-8", "replace")[:300]}
    return status, payload


def list_teams(cookie):
    status, payload = api("GET", "/teams", cookie)
    if status != 200:
        die(f"取团队列表失败（HTTP {status}）：{payload}")
    return payload.get("teams", [])


def find_team(teams, team_id):
    for item in teams:
        if item.get("id") == team_id:
            return item
    return None


# 只盯“用户数据面”：会话历史、记忆、用户工作区。运行时状态件（state.json / logs /
# storages 缓存 / *.lock）在停机时本就会变，算进去只会制造假警报。
CORE_SUBDIRS = ("workspace", "home/bot/sessions", "home/bot/memory")


def data_guard(team_id):
    """用户数据面指纹：文件数 + 总字节（不含 *.lock 与运行时缓存）。"""
    root = TEAMS_DIR / team_id
    if not root.exists():
        return None
    files = []
    for sub in CORE_SUBDIRS:
        subdir = root / sub
        if subdir.exists():
            files.extend(p for p in subdir.rglob("*") if p.is_file() and p.suffix != ".lock")
    memory_md = root / "home/bot/MEMORY.md"
    if memory_md.is_file():
        files.append(memory_md)
    return {
        "root": str(root),
        "files": len(files),
        "bytes": sum(p.stat().st_size for p in files),
    }


def wait_status(cookie, team_id, want, timeout=180):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        team = find_team(list_teams(cookie), team_id)
        if team:
            last = team
            state = team.get("status")
            if state == want:
                return team
            if state == "failed":
                die(f"{team_id} 进入 failed：{team.get('message', '')}")
        time.sleep(1.0)
    shown = last.get("status") if last else "missing"
    die(f"{team_id} 未在 {timeout}s 内到 {want}（末态 {shown}）")


def cmd_status(_args):
    teams = list_teams(login())
    print(f"{'ID':<14} {'状态':<10} {'PID':<8} {'端口':<6} {'自启':<5} 名称")
    print("-" * 78)
    for team in teams:
        print(
            f"{team.get('id',''):<14} {str(team.get('status','')):<10} "
            f"{str(team.get('pid') or '-'):<8} {str(team.get('port') or '-'):<6} "
            f"{('是' if team.get('autoStart') else '否'):<5} {team.get('name','')}"
        )
    return 0


def act(action, ids, keep, persist=False):
    cookie = login()
    teams = list_teams(cookie)
    targets = []
    for team_id in ids:
        if team_id == DEFAULT_TEAM:
            die("default（controller）不可停/起")
        if not find_team(teams, team_id):
            die(f"团队不存在：{team_id}")
        targets.append(team_id)

    saved = load_persist() if persist else {}
    rc = 0
    for team_id in targets:
        before = data_guard(team_id)
        note = ""
        if persist and action == "stop":
            current = find_team(list_teams(cookie), team_id)
            saved[team_id] = bool((current or {}).get("autoStart"))
            save_persist(saved)
            set_auto_start(cookie, team_id, False)
            note = "（autoStart→false，防重启复活）"
        elif persist and action == "start":
            note = "（autoStart 还原）"

        status, payload = api("POST", f"/teams/{team_id}/{action}", cookie, body={})
        if status not in (200, 202):
            print(f"{team_id}: 下发 {action} 失败（HTTP {status}）{payload}", file=sys.stderr)
            rc = 1
            log_trace(action, [team_id], 1, f"http={status}", before=before)
            continue

        if persist and action == "start" and team_id in saved:
            restore = saved.pop(team_id)
            set_auto_start(cookie, team_id, restore)
            save_persist(saved)
            note = f"（autoStart 还原为 {str(restore).lower()}）"

        want = "running" if action == "start" else ("stopped" if action == "stop" else None)
        if want:
            team = wait_status(cookie, team_id, want)
            state = team.get("status")
        else:
            time.sleep(1.0)
            state = (find_team(list_teams(cookie), team_id) or {}).get("status", "?")
        after = data_guard(team_id)
        intact = "数据面一致" if before == after else "⚠ 数据面变化"
        if before != after:
            rc = 1
        print(f"{team_id}: {action} → {state}（{intact}，{before or 0}→{after or 0}）{note}")
        log_trace(action, [team_id], 0 if before == after else 1, f"{state}{note}", before=before, after=after)
    return rc


def in_service_window(when=None):
    """标准检修窗：20:00–04:00（用户 11-24 令）。"""
    when = when or datetime.now()
    return when.hour >= 20 or when.hour < 4


# ---------------------------------------------------------------------------
# 持久停止（--persist）
#
# explicitStop 只是 controller 的**内存态**：controller 一旦重启（升级就会重启），
# startEnabledTeams() 会对所有 autoStart=true 的队重新 startTeam，被停的队会自己
# 复活抢算力。--persist 因此把 autoStart 一并关掉（走官方 PATCH /teams/<id>），
# 并把原值记在 persist.json，start 时精确还原——重启多少次都保持停止。
# ---------------------------------------------------------------------------
PERSIST_FILE = TRACE_DIR / "persist.json"


def load_persist():
    try:
        return json.loads(PERSIST_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_persist(data):
    """写持久停止状态；写不进去只警告，不阻断停机本身。"""
    try:
        TRACE_DIR.mkdir(parents=True, exist_ok=True)
        PERSIST_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        print(f"⚠ 持久停止状态写不进 {PERSIST_FILE}（{exc}）；autoStart 已改，但重启后可能复活", file=sys.stderr)


def set_auto_start(cookie, team_id, value):
    status, payload = api("PATCH", f"/teams/{team_id}", cookie, body={"autoStart": value})
    return status == 200


def cmd_stop_all(args):
    keep = set(args.get("--keep") or [])
    persist = bool(args.get("--persist"))
    if not args.get("--yes"):
        die("stop-all 会中断全部业务团队，确认请加 --yes")
    if not in_service_window() and not args.get("--emergency"):
        die("当前不在标准检修窗（20:00–04:00）。确需现在执行请加 --emergency（总务裁决破例）")
    cookie = login()
    teams = list_teams(cookie)
    ids = [t["id"] for t in teams if t.get("id") != DEFAULT_TEAM and t["id"] not in keep]
    if not ids:
        print("没有可停的业务团队")
        return 0
    print(f"检修模式：停 {len(ids)} 队（{', '.join(ids)}）{'，持久停止（autoStart→false）' if persist else ''}")
    return act("stop", ids, keep, persist=persist)


def cmd_logs(args):
    if not args:
        die("用法：teamctl logs <id> [n]")
    team_id = args[0]
    tail = int(args[1]) if len(args) > 1 else 40
    path = TEAM_LOGS / f"{team_id}-*.log"
    matches = sorted(TEAM_LOGS.glob(f"{team_id}-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not matches:
        die(f"找不到 {team_id} 的日志（{path}）")
    target = matches[0]
    print(f"# {target.name}")
    out = subprocess.run(["tail", "-n", str(tail), str(target)], capture_output=True, text=True)
    print(out.stdout, end="")
    return 0


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]

    if cmd == "status":
        return cmd_status(args)
    if cmd in ("stop", "start", "restart"):
        persist = "--persist" in args
        ids = [a for a in args if a != "--persist"]
        if not ids:
            die(f"用法：teamctl {cmd} <id> [<id>...] [--persist]")
        return act(cmd, ids, set(), persist=persist)
    if cmd == "stop-all":
        keep, yes, emergency, persist = [], False, False, False
        rest = []
        i = 0
        while i < len(args):
            if args[i] == "--keep" and i + 1 < len(args):
                keep.append(args[i + 1])
                i += 2
            elif args[i] == "--yes":
                yes = True
                i += 1
            elif args[i] == "--emergency":
                emergency = True
                i += 1
            elif args[i] == "--persist":
                persist = True
                i += 1
            else:
                rest.append(args[i])
                i += 1
        if rest:
            die(f"stop-all 不认识参数：{rest}")
        return cmd_stop_all({"--keep": keep, "--yes": yes, "--emergency": emergency, "--persist": persist})
    if cmd == "start-all":
        persist = "--persist" in args
        cookie = login()
        ids = [t["id"] for t in list_teams(cookie) if t.get("id") != DEFAULT_TEAM]
        return act("start", ids, set(), persist=persist)
    if cmd == "logs":
        return cmd_logs(args)

    die(f"未知命令：{cmd}（用 teamctl help 看用法）")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)