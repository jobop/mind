# 枝想 2.1 · Pi Agent 思维导图

GitHub 仓库：[jobop/mind](https://github.com/jobop/mind)。阿里云部署工作流与服务器初始化说明见 [deploy/README.md](deploy/README.md)。推送 main 自动运行 CI；手动执行 Actions 工作流才部署到 `https://mind.made-world.link`。

H5 思维导图 + 本地 Node.js 服务 + Pi 官方 Agent SDK。点击节点后，由 Pi 管理多轮模型请求、工具执行、观察结果和提交；生成入口不再采用一次 Chat Completions 请求直接写入节点的方式。

## 启动

需要 Node.js **22.19 或更新的 LTS 版本**。

- Windows：解压后双击「启动-Windows.bat」。
- macOS：双击「启动-Mac.command」，或在本目录运行 `npm start`。
- Linux：在本目录运行 `npm start`。
- 浏览器打开 `http://localhost:3000`，保持启动窗口开启。

完整运行包包含 JavaScript 依赖，可直接启动。源码包首次启动会按 package-lock.json 自动安装依赖；也可以先运行 `npm ci --ignore-scripts`。修改源码后执行 `npm run build`，再重启。

## 模型要求

在网页「模型设置」中配置 Base URL、模型 ID、API Key。必须支持 OpenAI 兼容的 **Chat Completions、Function Calling 和 SSE 流式响应**。连接检测通过 Pi 实际要求模型返回 connection_check 工具调用；只回复“连接成功”文本不会被视为工具能力验证通过。

从旧版升级后建议重新连接验证工具能力。Agent 每次任务可能进行多次收费模型请求；当前上限是 **8 次模型请求、20 次工具执行、5 个网页、180 秒**。这些是执行次数与时间上限，不是金额保证；没有已知单价时不显示虚构费用。

## Pi 框架与执行流程

锁定依赖：

- `@earendil-works/pi-agent-core` **1.5.2**：Agent 状态、工具循环、工具参数校验、事件订阅、取消。
- `@earendil-works/pi-ai` **1.5.2**：兼容模型适配、流式工具调用解析、消息转换。
- `ipaddr.js` **2.3.0**：公开网页读取的地址分类。

官方仓库：https://github.com/earendil-works/pi 。旧的 badlogic/pi-mono 文档入口已转向同一 Pi 项目；本项目采用安装时核实的当前 npm 包名与版本，并保留锁文件。

正常执行过程：

1. `plan_work`：记录简短行动步骤，不记录内部思维链。
2. `read_node_context`、`read_skill`：读取当前节点、项目背景、祖先备注、已有分支及领域方法。
3. Agent 自主选择已接入工具，按需读取 SkillHub 参考或公开网页；工具结果进入 Pi 的后续模型请求。
4. `validate_branches`：校验分支数量、重名、备注结构、引用是否来自本次实际读取。问题返回给模型修订。
5. `submit_branches`：只接受与校验通过内容相同的结果，结束运行，前端一次性追加节点。

没有读取上下文/Skill、没有通过校验、只输出文字或伪造来源编号，都不会写入脑图。不存在失败时的演示分支或普通生成降级。原图可撤销/重做，取消和失败不写入候选节点。

执行进度通过 NDJSON 实时传给网页，展示行动计划、模型轮次、工具开始/结束、校验与来源。SDK 的内部推理、API Key、原始服务商错误体不展示。成功任务最近 10 条记录保存在当前导图中；节点记录 Pi 框架、模型、Skill 和来源，可通过 JSON 备份。

## 已接入的工具边界

| 工具 | 能力 |
| --- | --- |
| plan_work | 记录行动纲要 |
| read_node_context | 当前节点、项目背景、祖先、补充指令和已有分支 |
| read_skill | 当前选择的内置或自定义方法论 |
| search_skillhub | 搜索腾讯公开 Skill 库 |
| inspect_skillhub | 查询 Skill 版本与文件列表 |
| read_skillhub_files | 读取固定版本 Markdown/文本并校验哈希 |
| read_public_page | 读取一个公网 HTTPS 的 HTML/Markdown/纯文本网页 |
| validate_branches | 检查结构、重名和来源编号 |
| submit_branches | 提交已通过检查的结果 |

此版本没有通用搜索引擎、登录态浏览器、任意文件读取、Shell、代码执行或外部写入工具。可在项目背景、节点备注或补充说明中提供需要核实的来源 URL；模型也可自行选择已知公开页面。不能把 SkillHub 搜索描述成全网检索。

**给一个 Skill 不代表能执行它的所有要求。** 方法论与已接入工具支持的步骤可以执行；依赖数据库、浏览器、Python、Shell 或专用 API 的 Skill 需要再接相应执行器。不会把未执行的步骤描述为已完成。

结构校验不等于事实核验、语义去重或独立专家评审；读取网页也不保证该网页内容正确。没有独立来源的分支会注明依据为用户背景与 Skill；读取的来源会显示链接。专业质量仍取决于模型、材料与 Skill。

## Skill 与腾讯 SkillHub

每张导图可选产品研究、软件架构、商业增长、项目执行或结构化分析方法论，或导入自定义 SKILL.md，并保存项目背景。正文最多 12000 字符，背景最多 4000 字符。

「Skill 设置 → 腾讯 SkillHub」支持搜索、预览主文档和参考文件、载入编辑器再应用。导入保留 slug、固定版本、路径与 SHA-256；改动正文会标记已修改。网页不执行 Skill 里的命令，不自动安装其依赖。

官方 API： https://github.com/Tencent/skillhub/tree/main/docs/api 。公共读取在此前已实测可用；未来权限、配额和可用性以腾讯为准。可选服务端环境变量 `SKILLHUB_API_KEY` 不会转发给网页或文件对象存储。Agent 也能按需使用这些接口读取更多方法资料。

## 本地数据与密钥

导图仍保存在当前浏览器 localStorage，兼容 1.x 导图的数据键和 JSON 格式。清除浏览器数据会删除本地图；设备间请导出/导入。

模型 Key 经本地服务 AES-GCM 加密后保存在 HttpOnly Cookie，7 天过期；不写入导图、源码或日志。**升级时保留原 `.branch-data` 文件夹**，其中是本地加密密钥。不要分享运行后产生的该目录。更换模型接口地址必须重新输入 Key，避免向新目的地发送原有凭证。

生成时仅发送当前任务相关的上下文给配置的模型。SkillHub 工具会发送搜索词和脱敏来源标识；网页工具发送指定 URL 的公开 GET 请求。模型 Key 不会提供给这些工具。

公开网页读取限制为 HTTPS、有限大小文本，DNS 解析后拒绝内网/保留地址并固定实际连接地址，重定向逐次检查；不携带浏览器 Cookie 或模型凭证。需要 JavaScript 渲染、登录或 PDF 的页面会提示无法读取。

本地 HTTP 服务只监听 127.0.0.1，校验 Host 和同源请求。仅本机 HTTP Cookie 使用单独名称；已有线上 HTTPS Cookie 策略保留。对外部署需要由部署方配置 HTTPS、身份与访问控制；GitHub 部署使用独立的生产域名和持久目录；原 Sites 托管不受影响。

## 代码结构

- `web/`：H5 导图、SkillHub 入口和 Agent 进度 UI。
- `runtime/`：真正导入 Pi SDK 的 Agent、模型适配与公开网页工具。
- `worker/`：HTTP 路由、加密连接、SkillHub 桥接；运行时由本地 Node 注入。
- `scripts/`：启动、构建和检查脚本。
- `dist/server/index.js`：已构建的网页和 HTTP 路由。单独运行这个路由文件没有 Pi 运行时，生成会明确拒绝；请用启动脚本或部署工作流。
- `examples/SKILL.md`：自定义方法论示例。

## 验证

`npm test` 通过 **35 项检查**，包含实际 Pi SDK 的多轮工具执行、工具结果进入下一轮请求、校验失败修订、无工具回答拒绝、伪造来源拒绝、取消、预算上限、公开地址限制、HTTP 流式进度、Cookie 加密、本地完整传输，以及旧导图、右键与 SkillHub 回归。

SDK 与模型协议测试使用受控 SSE 服务商响应；不是以手写循环替代 Pi。HTTP 集成测试使用真正的本地服务和真正的 Pi SDK。未使用付费真实模型账户验证最终生成质量；使用者在页面连接时会实际测试自己的模型。此前已实测腾讯 SkillHub 搜索、版本列表、主文档和参考文档读取与 SHA-256 校验。当前缺少浏览器 QA 入口，未完成真实浏览器交互验证。

Pi 及其他依赖按各包原有许可证分发；完整运行包在 node_modules 和 THIRD_PARTY 中保留对应许可证与补充声明。
