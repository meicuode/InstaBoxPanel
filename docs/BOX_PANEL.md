# box panel

把 [box by Simular](https://box.simular.ai) 的云电脑接入 InstaBox Panel：查看状态、打开实时画面，并按时间窗口定时唤醒。

## 连接

1. 在 [box.simular.ai/keys](https://box.simular.ai/keys) 创建个人密钥。密钥只显示一次，形如 `cb_...`。
2. 登录面板，打开侧栏 **box panel**，点击“连接 box”，填写显示名称和密钥。
3. 保存前面板会调用 `box_list` 验证密钥；失败不会覆盖已有的密钥。
4. 密钥会以管理员主密钥（AES-256-GCM）加密后写入 D1 的 `insb_box_account`，页面只显示末四位。

OAuth 连接不需要这个页面；它面向只能发送固定请求头的客户端或自动化场景。

## 保活

每台 box 可以独立选择：

- **不保活**：默认，按 box 自己的空闲策略休眠。
- **全天保活**：每分钟检查一次。
- **指定时间范围**：每天 1–5 个窗口，支持跨午夜和 IANA 时区。

定时任务复用现有的每分钟 Cron（`insb_scheduler` 租约），调用 MCP 工具 `box_ensure`，参数为 `box: <box_id>, wait: false`。运行中的 box 会直接返回当前状态，休眠时由服务端唤醒；不会重启、不会改动文件。

- 最多同时保活 3 台 box，避免占用 Cron 的请求与时间预算。
- 窗口由 `inKeepaliveWindow` 计算，与 InstaBox 机器保活使用同一套校验。
- 每次检查结果写入 `insb_box_keepalive`：最近检查时间、状态、结果和错误。页面每分钟刷新一次。
- 密钥被撤销、网络失败或服务端拒绝时只记录失败，不会影响 InstaBox 机器保活和 Telegram 通知。

## 行为与限制

- box 空闲休眠后，AI 通过 MCP 连接时本来就会在约 1 秒内唤醒。保活主要适合需要让 box 内常驻服务（开发服务器、下载任务等）不中断的场景。
- 保活会增加 box 的实际运行时间；box 本身免费，但机器时间和模型调用仍受 Simular 账号额度约束。
- 官方没有公开空闲休眠的具体超时时间；当前按每分钟检查一次实现，实际效果需在部署后观察。
- 保活不会备份或恢复 box 内的数据。需要保留现场时，请使用 Simular 自己的快照能力。
- 面板只调用固定 MCP 地址 `https://mcp.box.simular.ai/mcp`，不会把浏览器 Cookie、管理员会话或上游返回的完整凭据写入日志。

## 数据表

| 表 | 用途 |
| --- | --- |
| `insb_box_account` | 单行配置：名称、加密密钥、末四位、启用状态 |
| `insb_box_keepalive` | 按 box 保存模式、时区、时间窗口、版本和最近检查结果 |

迁移 `0009_box_panel.sql` 随应用启动自动执行，不需要手动设置数据库 ID。
