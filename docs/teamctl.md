# 团队检修工具 teamctl

`scripts/teamctl.py` 给**总务（controller 侧运维者）**提供一个命令面：在模型/代码检修时，把 broker 在册的其他团队优雅停掉腾出算力，检修完原样拉起。它随 ds-headbot 包分发，任何 headbot 实例装完都能直接用。

## 授权边界（2026-11-24 用户令）

- **仅总务使用**，不向其他团队开放。
- 检修窗一经总务排定，**直接执行**：不再向各团队发通告、不征求许可与回执。这是《检修通告规》的明确例外，**仅限本工具的团队停/起**；该规其余情形照旧。
- 无紧急情况时检修窗排在 **20:00–04:00**；紧急时由总务裁决破例（`stop-all` 在非窗口时段需显式 `--emergency`）。
- 停机与恢复都是优雅停机 + 原样拉起，各团队在**原中断位置断点续跑**，用户数据零改动。

## 用法

```bash
teamctl status                        # 只读：列全部团队状态（状态/PID/端口/自启/名称）
teamctl stop <id> [<id>...]           # 停一个或多个团队
teamctl start <id> [<id>...]
teamctl restart <id> [...]
teamctl stop-all --yes                # 检修模式：停全部业务团队（controller 永不停）
teamctl stop-all --yes --keep subtrans    # 保留某队不停
teamctl stop-all --yes --emergency    # 非 20:00–04:00 时段，总务裁决破例
teamctl start-all                     # 检修完，全部拉起
teamctl logs <id> [n]                 # 看某队日志尾（默认 40 行）
```

典型检修流程：

```bash
teamctl status                 # 停前留底
teamctl stop-all --yes         # 腾算力（5.6 秒左右全停）
# …检修…
teamctl start-all              # 恢复（12 秒左右全起）
teamctl status                 # 起后核对
```

退出码 `0` 成功 / `1` 失败（stderr 给原因）。

## 为什么数据不丢（机制，不是口头保证）

- 只调 controller 官方团队控制 API：`POST /dsh/api/ds-headbot/v1/teams/<id>/{start|stop|restart}`，由 `manager.stopTeam()` 执行：SIGTERM 进程树 → 等关闭 → 清 runtime pid → `phase=stopped`。**它不碰 `teams.json`，不碰 `teams/<id>/{home,workspace}`，不删任何文件。**
- 显式停止会置 `runtime.explicitStop=true`，controller 的 autoStart 自动重启腿因此**不再把团队拉起来**——这正是它比"直接 kill 进程"安全的理由：直接 kill 会被 respawn，算力根本腾不出来。
- 每次停/起前后各算一次**用户数据面指纹**（`workspace/` + `home/bot/sessions/` + `home/bot/memory/` + `home/bot/MEMORY.md`，排除 `*.lock`），前后不一致立刻打印 `⚠ 数据面变化` 并以非零码退出，避免静默丢件。

## 认证

工具每次运行都从 controller 日志（默认 `~/Library/Logs/DeepSeekHarness/server.log`）取**最新一条** launch token 换会话 cookie，因此 controller 重启后 token 轮转无需改配置。日志里取不到 token 时会明确报错，而不是静默失败。

## 留痕

每次调用追加一行 JSON 到 `~/Library/Logs/DeepSeekHarness/teamctl/teamctl.jsonl`：时刻、命令、参数、退出码、前后数据面指纹。可直接回读对账。

## 环境变量（跨实例复用）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SERVER_LOG` | `~/Library/Logs/DeepSeekHarness/server.log` | controller 日志（取 launch token） |
| `HEADBOT_ROOT` | `~/Library/Application Support/DeepSeekHarness/headbot` | headbot 数据根 |
| `DSH_INGRESS_PORT` | `3180` | ingress 端口 |
| `DSH_PUBLIC_HOST` | `192.168.1.5` | 请求 Host 头（Origin 同源校验用） |
| `DSH_HOST` | `127.0.0.1` | 实际连接地址 |
| `TEAMCTL_TRACE_DIR` | `~/Library/Logs/DeepSeekHarness/teamctl` | 留痕目录（包内目录只读时改这里） |

## 排障

- **`controller 登录失败（HTTP 401/403）`**：token 已随重启轮转且日志被切走，确认 `DSH_SERVER_LOG` 指向当前 controller 日志。
- **`teamctl: 团队不存在`**：`teamctl status` 看准确 id（大小写敏感）。
- **`未在 180s 内到 stopped`**：多半是团队有长任务未退，看 `teamctl logs <id>`；必要时 `restart` 或等其收敛。
- **停机后仍被拉起**：不该发生（explicitStop 生效）；若出现，检查是否有第二个 controller 实例在管同一 `HEADBOT_ROOT`。