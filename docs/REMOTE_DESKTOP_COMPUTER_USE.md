# 远程桌面、快照与 AI 操作

更新：2026-10-27。桌面与快照已实现并通过本地验证；本文替代此前的可行性方案。

## 已交付与待验收

| 部分 | 状态 |
| --- | --- |
| 面板远程桌面 | 已实现 noVNC、浮动窗口、键鼠接管／交还、操作记录、最大化、最小化和重连 |
| 快照管理 | 已实现机器／账号列表、新增、删除、保存进度和持久化重试 |
| 本地验证 | 75 项后端测试、20 组浏览器检查通过，生产构建与 Worker 打包检查通过 |
| 目标 VPS 的 MCP | 已注册 instabox_computer，实测截图、输入、保存、人工控制时拒绝 AI 输入、交还后恢复 |
| 模型看图并驱动桌面 | 尚未验收；图片请求超时，现有网关纯文本请求也超时，模型目录仍声明 text |
| 生产面板链路 | 尚未部署本次改动，Cloudflare → InstaBox 真实桌面／快照需上线验收 |

MCP 工具能够操作桌面，不等于模型已经能够识别截图并自主完成任务。工具验证使用专门的临时测试窗口，没有把用户桌面截图发送给模型；视觉探测只使用程序生成的四位数字图片。

## 使用方式

机器行的显示器图标和详情页的“桌面”打开同一台 VPS 的图形会话。初始只读；桌面运行且平台允许暂停 AI 时可点击“人工接管”。接管后可以双向复制纯文本：点击“发送剪贴板”把本机剪贴板送到虚拟机；在虚拟机里复制后，等提示收到内容，再点击“复制到本机”。浏览器出于剪贴板权限要求，虚拟机内容只在点击“复制到本机”时写入本机剪贴板，不会后台自动覆盖。需在 HTTPS 页面并允许浏览器访问剪贴板。交还 AI、最小化或关闭时清除暂存文本并交还控制。

剪贴板受 VNC 服务端支持的格式影响：noVNC 的扩展剪贴板可传输 UTF-8；旧版 RFB 剪贴板仅支持 ISO-8859-1，超出此范围的字符无法可靠双向传输，发送到虚拟机时可能显示为 `?`。

窗口支持拖动、四角缩放、页面内最大化和重连。状态读取失败或超时会禁用输入；VNC 断开需手动重连。安装／启动桌面通过平台接口执行；暂停或停止的机器需先恢复／启动。终端与桌面共用最多 8 个窗口额度；平台实际限制还包含同账号在其他页面打开的连接。

快照入口位于机器行、机器详情及账号“快照库”。机器入口默认按源机器过滤，可切换显示账号全部快照，包括其他或已移除机器的快照。创建可选完整快照或仅系统文件；完整快照包含 `/data` 及其中的凭据，不保存内存和运行进程。运行中或完全停止且没有进行中操作时可创建；暂停中的机器需先恢复。

新增需要 `images:write`，查看需要 `images:read`，删除需要 `images:delete`。删除前输入完整名称。保存中的快照轮询更新进度；未确认请求保留在 D1，账号暂不能移除。网络异常时重试同一个请求；明确失败时可修改后重新提交。超过 6 天的未确认请求需到官方控制台核实，避免超出平台幂等保留时间后重复操作。

## 实现与认证

```text
浏览器 noVNC
  → 同源 /api/accounts/:id/machines/:machineId/desktop/vnc
  → Worker 验证登录、Origin 及绑定会话的加密连接信息
  → InstaBox VNC WebSocket
  → VPS 的 XFCE / Xvnc :1

远端 Codex → instabox-computer-use mcp → 平台控制权代理 → 同一桌面
```

`DesktopPane.tsx` 负责窗口；`desktop.ts` 代理状态、命令、接入票据、VNC 和 SSE。平台 API Key 与短期票据不以明文发送给浏览器。客户端只收到绑定账号、机器和登录会话的加密连接信息，VNC 新连接有 60 秒准入期限；状态流续接时刷新平台票据。

平台 SSE 每 3 秒推送状态，并为打开的桌面会话维护控制权心跳。流不可用时前端回退到状态轮询；本地状态过期后禁用输入。平台控制权在最后续约后约 30 秒失效。平台按调用者共享控制状态，同账号多标签页可能互相影响；状态变更以平台返回值为准。

`SnapshotPane.tsx` 和 `snapshots.ts` 负责快照。新增／删除先写入 `insb_snapshot_requests`，上游使用 `panel-snapshot-<requestId>` 幂等标识。删除还验证快照名称并向平台发送 `X-Confirm-Delete`。迁移 `0008_snapshot_requests.sql` 纳入自动建表，不接触其他应用的表。

## 目标 VPS 的 MCP 配置

2026-10-26 核查时，目标主机已有 Debian 13、XFCE、Xvnc `:1` 和监听于本机 `5901` 的 VNC，以及平台 computer-use 程序。无需另装桌面或公开 VNC 端口。

已配置的服务器为：

```toml
[mcp_servers.instabox_computer]
command = "/usr/local/bin/instabox-computer-use"
args = ["mcp"]
startup_timeout_sec = 45
tool_timeout_sec = 120
```

可在另一台已有平台包装器的 Linux 主机上使用本仓库脚本：

```sh
python3 tools/configure-computer-use.py --check
python3 tools/configure-computer-use.py
```

脚本保留原配置、以权限 `0600` 创建带时间戳的备份，拒绝覆盖不同的同名服务器，随后使用远端 Codex 严格配置检查；失败会恢复旧内容。未安装 code-server 扩展时可通过 `--codex-binary` 指定 CLI。配置后重新加载 code-server 窗口或新开 Codex 会话，读取新工具。

AI 输入应通过此包装器，平台控制锁由它遵守；直接调用其他键鼠程序可能绕过控制锁。视觉能力声明归独立的 `D:\Projects\gpt\RelayManager` 项目维护。本面板未修改中转源码，也未把未经验证的模型标成支持图片。

## 验证记录与后续

本地桌面协议检查使用原生浏览器 WebSocket 连接本地 `ws` 服务，完成 RFB 握手、像素格式协商、画面像素核对、接管后键鼠输入、两个方向的剪贴板文本、交还／状态失联后的输入禁止以及关闭连接。不能用 Playwright 的 `routeWebSocket` 直接替代该连接：其模拟对象的原型结构不兼容 noVNC 1.7.0 的通道检查，会报 `Raw channel missing property: send`。

快照浏览器验证还覆盖名称校验、确认名称后删除、明确失败允许修改、刷新不会抹掉提交错误、网络失败后复用请求标识。HTML `pattern` 使用转义连字符以兼容浏览器的 Unicode sets 正则规则。

远端历史结果位于本机忽略目录 `.local/`：`computer-mcp-setup.json`、`computer-mcp-smoke.txt`、`computer-vision-low-probe.json`、`computer-vision-alternative-probe.json`。网关诊断见 `computer-gateway-health.jsonl`：`/health` 与 `/v1/models` 返回 200，但纯文本生成 30 秒超时。图片探测此前在 150 秒超时，不能据此断定上游不支持图片。应先恢复可用的生成链路，再验证视觉输入与模型工具调用闭环。

2026-10-27 用临时无头浏览器打开 code-server 后重测，页面约 3 秒加载完成；文本请求 30 秒、合成图片请求 100 秒仍超时。临时浏览器已关闭，结果在 `.local/computer-gateway-browser-probe.jsonl`。因此仅重新打开编辑器未恢复生成；网关密钥读取、上游请求与流处理仍需进一步定位。

部署后使用一台测试机器检查真实画面、接管／交还及重连；再创建快照、确认保存完成并删除刚创建的测试快照。生产快照列表与写入尚未在此验证中调用。

接口依据：[InstaBox OpenAPI](https://api.instabox.sh/v1/openapi.json)。此前方案参考：[Codex MCP](https://developers.openai.com/codex/mcp)、[Computer use 集成](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)。本次尝试重新读取 OpenAI 文档被站点访问限制阻止，因此未据此新增模型兼容性结论。
