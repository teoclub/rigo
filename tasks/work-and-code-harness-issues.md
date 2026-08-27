# Rigo Work & Code Harness — Local Issues

> Status: approved for local creation
> Created: 2026-08-26
> Source SPEC: [`tasks/spec-work-and-code-harness.md`](spec-work-and-code-harness.md)
> Source PRD: [`tasks/prd-work-and-code-harness.md`](prd-work-and-code-harness.md)
> Creation mode: Local, consolidated single-file format
> Total issues: 38

Issue numbers in this document are stable local planning identifiers. `Dependencies` refers to these identifiers, not GitHub issue numbers.

## Issue 001: 固定 DeepSeek Harness 上游基线并生成迁移清单

### Description

固定 Rigo Core 使用的 DeepSeek Harness 官方 Release Tag 与完整 Commit SHA，并生成可审计、可复现的上游迁移清单和依赖闭包，作为后续所有移植工作的唯一来源基线。

### Acceptance Criteria

- [x] 清单记录上游仓库 URL、官方 Release Tag 和完整 Commit SHA。
- [x] 每个候选迁移包记录上游路径、本地目标路径及 `KEEP`、`ADAPT`、`DROP` 或 `REPLACE` 分类。
- [x] 自动生成 Rigo Core 候选包的实际依赖闭包，覆盖 Protocol、Scope、Session、Prompt、Tools、LLM、Agent 和 App Boot。
- [x] 清单明确禁止自动跟随上游 `master`，后续升级必须显式选择新的官方 Tag。
- [x] 固定基线能够在全新工作目录中被重新获取并校验到相同 SHA。
- [x] 缺少 Tag、完整 SHA 或来源路径时验证命令返回非零状态。

### Dependencies

None

### Type

infra

### Priority

high

### Traceability

- PRD: US-001, FR-1, FR-2
- SPEC: §1.3, §2.3, §10 Phase 0

## Issue 002: 建立来源审计、许可证及迁移清单完整性门禁

### Description

围绕固定的上游基线建立来源审计和许可证门禁，使每个迁移包、每项本地修改及其法律来源都能被持续验证。

### Acceptance Criteria

- [x] 仓库包含适用的 DeepSeek Harness MIT License、第三方声明及原始版权信息。
- [x] 每个迁移包记录本地修改内容及修改理由。
- [x] 审计脚本可以发现本地存在但迁移清单未登记的迁移包。
- [x] 审计脚本可以发现缺少来源路径、目标路径、分类或固定 SHA 的条目。
- [x] 打包验证能够确认许可证与来源文件进入适用发布产物。
- [x] 来源审计和许可证校验接入 CI，失败时阻止合入。

### Dependencies

Issue 001

### Type

infra

### Priority

high

### Traceability

- PRD: US-001, FR-2, FR-3, NFR-9
- SPEC: §2.3, §9.2, §10 Phase 0

## Issue 003: 初始化 Rigo Monorepo 与包依赖边界

### Description

按 SPEC 的文件结构初始化 Rigo 工作区、包命名和构建测试基础，形成 Cordis、Rigo Core、Shared Plugins、Rigo Work 与 Rigo Code 之间可机械验证的依赖边界。

### Acceptance Criteria

- [x] 创建 `packages/harness`、`packages/shared`、`packages/work`、`packages/code`、`packages/api`、`packages/bundle`、`apps`、`examples` 和 `tests` 工作区入口。
- [x] Rigo Core 包使用 `@teoclub/harness-*`，Rigo Work 包使用 `@teoclub/work-*`。
- [x] 工作区提供统一的 build、typecheck、lint、Node test 和 Bun test 命令。
- [x] 自动边界检查阻止 `packages/harness` 导入 React、HTTP、SQLite、`packages/work` 或 `packages/code`。
- [x] Domain 包只能依赖 Rigo Core 与 Shared Service Definition，不能依赖其他领域 Provider。
- [x] 最小空包工作区在 Node 24 和 Bun 中完成安装、构建和类型检查。

### Dependencies

Issue 001

### Type

infra

### Priority

high

### Traceability

- PRD: US-002, FR-4, FR-5, NFR-8
- SPEC: §2.2, §2.5, §2.6

## Issue 004: 实现领域无关的最小 Rigo Core 启动与释放

### Description

实现不挂载 Rigo Work 或 Rigo Code 插件的最小 Rigo Core 启动路径，用于验证 Cordis Context、插件等待、失败回滚和公共运行边界。

### Acceptance Criteria

- [x] Rigo Core 可以创建 Cordis `Context` 并加载最小插件树。
- [x] 启动过程等待所有必要插件进入可用状态后才返回成功。
- [x] 正常关闭按反向注册顺序释放插件和副作用。
- [x] 部分启动失败时，已经加载的插件按反向顺序完整释放。
- [x] 最小 Core 的运行时依赖中不存在 Rigo Work 或 Rigo Code 包。
- [x] 自动化测试覆盖正常启动、正常释放、依赖缺失和部分启动失败。
- [x] 相关包的 typecheck 和 lint 通过。

### Dependencies

Issue 003

### Type

backend

### Priority

high

### Traceability

- PRD: US-002, FR-4, FR-5, FR-35
- SPEC: §2.2, §2.5, §9.3

## Issue 005: 实现 Profile、Bundle、Patch 组合及失败回滚

### Description

实现声明式产品组合，使 Profile 能按顺序挂载 Bundle，并通过稳定条目 ID 应用 Profile、Home 和 CLI Patch，而无需修改 Rigo Core。

### Acceptance Criteria

- [x] Profile 可以声明有序 Bundle 列表并保持确定性装载顺序。
- [x] Bundle 可以声明 Cordis 配置或 Patch 文件。
- [x] Profile Patch、Home Patch、CLI Patch 按从低到高的固定优先级合并。
- [x] Patch 可以按稳定条目 ID 替换配置；不存在的目标产生可观察错误或警告。
- [x] 系统可以输出最终生效的规范化插件树。
- [x] 新配置校验或加载失败时继续保留最后一次有效插件树。
- [x] 测试覆盖层级覆盖、目标缺失、顺序稳定和失败回滚。

### Dependencies

Issue 004

### Type

backend

### Priority

high

### Traceability

- PRD: US-003, FR-6, FR-7, FR-8
- SPEC: §2.2, §2.6, §10 Phase 2

## Issue 006: 实现 Session Event 协议与模型历史派生

### Description

定义仅追加的 Session Event 协议，并使用户消息、模型输出和 Tool 交互成为模型历史、回放与审计的统一事实源。

### Acceptance Criteria

- [x] Session Event 定义稳定的 Session ID、单调递增序号、事件类型、Schema Version、Turn ID 和 Step ID。
- [x] Session 只允许在尾部追加事件，禁止覆盖或删除既有事实。
- [x] 用户消息、Assistant Chunk、Assistant Message、Tool Call 和 Tool Result 都写入事件流。
- [x] 同一事件序列可以确定性派生完全相同的模型消息历史。
- [x] 非法事件顺序被结构化 Invariant 检查拒绝。
- [x] 自动化测试覆盖 Session 创建、事件追加、历史派生、非法顺序和释放。
- [x] 相关包的 typecheck 和 lint 通过。

### Dependencies

Issue 003

### Type

backend

### Priority

high

### Traceability

- PRD: US-004, FR-11, FR-12
- SPEC: §3.1, §3.2, §5.1, §9.1

## Issue 007: 实现 SQLite 存储插件与 Migration 框架

### Description

实现 Node 24 `node:sqlite` 存储 Provider 和顺序 Migration 框架，为 Session、Approval、Action、Documents、Knowledge 与 Audit Projection 提供共享事务基础。

### Acceptance Criteria

- [x] SQLite Provider 独立于运行时无关的存储 Service Definition。
- [x] 数据库启动时启用 WAL、Foreign Keys 和 Busy Timeout。
- [x] `schema_migrations` 记录版本、应用时间和 Migration Checksum。
- [x] Migration 在 Agent Runtime 启动前执行，失败时 Runtime 不得启动。
- [x] 已应用 Migration 内容发生变化时启动失败并报告校验错误。
- [x] Schema 变更前创建一致性备份；MVP 不实现降级 Migration。
- [x] 自动化测试覆盖全新数据库、连续升级、Checksum 冲突和失败回滚。

### Dependencies

Issue 003

### Type

backend

### Priority

high

### Traceability

- PRD: US-004, FR-32, NFR-3, NFR-4
- SPEC: §3.8, §8.3, §9.3

## Issue 008: 实现 Session Event 持久化、恢复与异常恢复

### Description

将 Session 与仅追加事件流持久化到 SQLite，并保证重启后可以恢复相同历史、序号和 Agent 所需状态。

### Acceptance Criteria

- [x] 实现 SPEC §3.2 的 `sessions`、`session_events` 表、约束和索引。
- [x] 每个 Session 内的序号分配与事件写入在同一事务中完成。
- [x] 重启后恢复的 Session Projection 与模型消息历史和退出前一致。
- [x] 重复的客户端消息 ID 返回原 Turn，不产生重复用户事件。
- [x] Event Payload 使用 `schema_version` 支持向前迁移。
- [x] SQLite 锁超时返回可重试 `STORAGE_BUSY`，不破坏已提交事件。
- [x] 集成测试覆盖创建、追加、关闭、恢复、异常退出和 100,000 事件参考场景。

### Dependencies

Issue 006, Issue 007

### Type

backend

### Priority

high

### Traceability

- PRD: US-004, FR-11, FR-12, FR-32, NFR-4
- SPEC: §3.2, §3.8, §6.1, §8.1

## Issue 009: 实现 LLM Provider 注册表与统一流式协议

### Description

实现与模型厂商无关的 LLM Registry、消息协议和流式 Chunk 协议，使 Agent Loop 只依赖 Provider 与 Model 标识。

### Acceptance Criteria

- [x] `ctx.llm` 可以注册和卸载具名 Provider。
- [x] Agent 可以通过 Provider ID 与 Model ID 解析模型。
- [x] 定义统一的 `Message`、`ContentBlock` 与 `StreamChunk` 类型。
- [x] Stream 支持文本、工具调用、用量统计和终止原因。
- [x] `AbortSignal` 可以终止正在运行的模型请求并返回 `OPERATION_ABORTED`。
- [x] 未知 Provider 或 Model 返回结构化 `PROVIDER_NOT_FOUND`。
- [x] Provider 插件卸载后不能被新请求选中，且不卸载其他 Provider。

### Dependencies

Issue 003

### Type

backend

### Priority

high

### Traceability

- PRD: US-005, FR-13, FR-14, FR-15
- SPEC: §2.4, §5.1, §6.1, §6.3

## Issue 010: 实现 OpenAI-compatible 与确定性 Mock LLM Provider

### Description

实现首个生产可用的 OpenAI-compatible Provider 和 CI 使用的确定性 Mock Provider，验证统一流式协议、重试、取消与凭据边界。

### Acceptance Criteria

- [x] OpenAI-compatible Provider 通过 Credential Reference 获取密钥，配置快照不保存 Credential Value。
- [x] Provider 将厂商响应转换为统一文本、Tool Call、Usage 和 Finish Chunk。
- [x] 对允许重试的限流、连接重置和部分 `5xx` 最多执行两次指数退避重试。
- [x] 用户 Abort 后停止请求且不再重试。
- [x] Mock Provider 可按固定脚本产生确定性的无工具和多工具流式响应。
- [x] Mock Provider 支持错误、断流、未知工具和 Abort 测试场景。
- [x] Node 与 Bun 中的协议测试通过，日志和错误中不包含 Credential Value。

### Dependencies

Issue 009

### Type

backend

### Priority

high

### Traceability

- PRD: US-005, FR-13, FR-14, FR-15, FR-33, FR-34
- SPEC: §2.6, §6.2, §7.4, §9.1

## Issue 011: 实现 Context Contributor 注册与上下文组装

### Description

实现可扩展的 Context Assembly Service，使 Rigo Work 与 Rigo Code 插件能够按稳定顺序向每次模型请求贡献带来源的上下文。

### Acceptance Criteria

- [x] `ctx.context` 支持注册和卸载 `ContextContributor`。
- [x] Contributor ID 在 Agent Scope 内唯一，先按 `order`、再按 ID 确定性排序。
- [x] 组装顺序覆盖 Harness Identity、Product Persona、Domain Context、Session History、Knowledge、Runtime Injection 和 Tool Schemas。
- [x] 每份 Contribution 包含可追踪来源，并在进入模型前写入 Session Event。
- [x] Contributor 卸载后立即停止参与新的模型请求。
- [x] Contributor 失败产生结构化错误并终止当前 Step，不静默遗漏上下文。
- [x] 测试覆盖排序、重复 ID、卸载、来源追踪和失败传播。

### Dependencies

Issue 006, Issue 009

### Type

backend

### Priority

high

### Traceability

- PRD: US-006, FR-16
- SPEC: §2.4, §5.2, §6.3

## Issue 012: 迁移 System Prompt 与 Tool Registry 生命周期

### Description

迁移并适配 DeepSeek Harness 的 System Prompt 与 Tool Registry，使 Prompt Section、Tool Schema 和 Tool 生命周期可由 Cordis 插件安全组合。

### Acceptance Criteria

- [x] System Prompt Service 可以按稳定顺序组装 Prompt Section。
- [x] Tool Registry 可以注册带名称、描述和输入 Schema 的模型可见 Tool。
- [x] Tool Schema 进入模型请求前完成规范化并由 Context Assembly 引用。
- [x] Tool 调用使用统一成功或失败结果，不泄露 Provider 原始异常对象。
- [x] Tool 插件卸载后不再接受新调用，监听器和注册项被撤销。
- [x] 为后续 Tool → Action 委托保留稳定扩展接口，但本 Issue 不执行外部副作用。
- [x] 上游 Prompt 组装和 Tool 生命周期测试迁移后通过。

### Dependencies

Issue 003, Issue 011

### Type

backend

### Priority

high

### Traceability

- PRD: US-006, US-010, FR-16, FR-17, FR-35
- SPEC: §2.4, §5.1, §9.2

## Issue 013: 实现 Agent Registry 与稳定公共 API

### Description

实现与默认 Agent Loop 解耦的 Agent Registry 和公共接口，为 Web UI、HTTP Host 与进程内 SDK 提供统一控制面。

### Acceptance Criteria

- [x] `ctx.agents` 支持创建、获取、恢复和释放 Agent。
- [x] Agent 暴露 `send`、`steer`、`inject` 和 `abort`。
- [x] 公共状态只暴露 `idle` 与 `running`，详细阶段通过事件表示。
- [x] Agent 使用稳定 Session ID 关联 Session Event Log。
- [x] 重复释放 Agent 不产生资源泄漏或重复副作用。
- [x] UI、HTTP 和 SDK 可以只依赖公共 Agent API，不导入默认 Loop 实现。
- [x] Agent 扩展可以替换 Loop Factory 而不改变公共接口。

### Dependencies

Issue 006, Issue 009, Issue 012

### Type

backend

### Priority

high

### Traceability

- PRD: US-007, FR-9
- SPEC: §2.4, §2.5, §5.6

## Issue 014: 实现默认 Agent Turn/Step 多步循环

### Description

实现保持上游行为的默认 Agent Loop，支持无工具 Turn、包含多个 Tool Step 的 Turn，以及从 Session Event Log 派生模型历史。

### Acceptance Criteria

- [x] 无 Tool Call 的输入可以完成 `turn/start`、单个 Step 和 `turn/end`。
- [x] 包含 Tool Call 的 Turn 可以连续运行多个 Step，直到没有后续工具结果或 Inbox 输入。
- [x] 每个 Turn、Step、LLM 请求、Tool Call 和 Tool Result 写入规范事件。
- [x] Assistant 流式 Chunk 被组装成最终 Assistant Message。
- [x] 未知 Tool 产生失败 Tool Result，并允许后续 Step 修正。
- [x] LLM 在 Tool 参数未完成时断流不会创建 Tool 或 Action。
- [x] Agent Loop 状态机、事件顺序及多 Step 测试通过。

### Dependencies

Issue 010, Issue 011, Issue 012, Issue 013

### Type

backend

### Priority

high

### Traceability

- PRD: US-007, FR-10, FR-11, FR-12
- SPEC: §5.1, §5.6, §5.8

## Issue 015: 实现 Agent Inbox、并发控制与 Abort 语义

### Description

完善 Agent 的运行期控制，保证同一 Agent 不执行冲突 Turn，新输入能够进入 Inbox，并且 Abort 可以跨 LLM、Tool 与后续 Action 链路传播。

### Acceptance Criteria

- [x] 同一 Agent 同时最多运行一个活动 Turn。
- [x] 活动 Turn 期间的用户输入进入 Agent Inbox，不直接创建冲突 Turn。
- [x] `steer` 与 `inject` 按公共协议进入当前或下一 Step，并记录来源事件。
- [x] Abort 终止活动 LLM 请求并阻止后续 Step 启动。
- [x] Session 删除时先 Abort 活动 Turn，再等待 Agent 和插件资源释放。
- [x] Abort 产生 `OPERATION_ABORTED`，用户取消后不得自动重试。
- [x] 测试覆盖并发发送、Inbox 顺序、Steer、Inject、Abort 和释放竞态。

### Dependencies

Issue 014

### Type

backend

### Priority

high

### Traceability

- PRD: US-007, FR-9, FR-10, FR-15
- SPEC: §5.6, §5.8, §6.1, §6.2

## Issue 016: 实现 Documents Service 与文档 Projection 模型

### Description

定义领域无关的 Documents Service Contract，并建立 Markdown/纯文本文件的文档 ID、版本、Hash、媒体类型和索引版本 Projection。

### Acceptance Criteria

- [x] `ctx.documents` 提供稳定的读取、版本查询和 Provider 注册接口。
- [x] 实现 SPEC §3.5 的 `documents` 表、唯一相对路径约束和版本字段。
- [x] 文档记录包含 ID、相对路径、版本、Content Hash、Media Type、Size 和 Indexed Version。
- [x] MVP 仅接受 `text/markdown` 与 `text/plain`。
- [x] 单文档超过 5 MiB 时返回结构化校验错误。
- [x] 文件 Hash 或内容变化时文档版本单调递增。
- [x] Service Definition 不依赖本地文件系统实现，可由其他 Provider 实现。

### Dependencies

Issue 007

### Type

backend

### Priority

high

### Traceability

- PRD: US-009, FR-25, D-008
- SPEC: §2.4, §3.5, §8.1

## Issue 017: 实现本地 Markdown/文本读取及 Workspace 安全边界

### Description

实现 Local Documents Provider，在每个 Session 固定的 Workspace Root 内安全读取 Markdown 和纯文本，并拒绝路径穿越、逃逸 Symlink 和非法编码。

### Acceptance Criteria

- [x] Session 创建时要求存在的绝对 Workspace Root，并将其持久化。
- [x] 文档 API 只接受相对路径；绝对路径和 `..` 穿越返回 `PATH_OUTSIDE_WORKSPACE`。
- [x] 读取目标的 `realpath` 必须位于 Workspace Root，逃逸 Symlink 被拒绝。
- [x] 成功读取返回文档 ID、版本、内容、媒体类型和来源位置。
- [x] 文件不存在返回 `DOCUMENT_NOT_FOUND`，非法文本编码返回 `DOCUMENT_ENCODING_INVALID`。
- [x] 空文档可以读取，不生成虚假内容。
- [x] 读取操作写入带 Session、文档和来源标识的事件。
- [x] 测试覆盖成功读取、不存在、越界、Symlink、空文件和非法编码。

### Dependencies

Issue 008, Issue 016

### Type

backend

### Priority

high

### Traceability

- PRD: US-009, FR-25, D-005, D-008
- SPEC: §4.3, §5.8, §6.1, §7.2

## Issue 018: 定义 Knowledge Provider 与检索结果契约

### Description

实现可替换的 Knowledge Service Definition，规范 Query、Top-K、过滤条件、结果来源和 Provider 生命周期。

### Acceptance Criteria

- [x] `ctx.knowledge` 支持注册和卸载具名 Knowledge Provider。
- [x] 检索请求定义 Query、Top-K 和可选过滤条件。
- [x] Query 最大 8 KiB，默认 Top-K 为 8，非法输入返回结构化错误。
- [x] 每个结果包含来源 ID、标题、正文片段、文档版本和定位信息。
- [x] Provider 返回结果使用稳定排序契约，空结果使用空集合而非虚假来源。
- [x] Provider 卸载后不能被新检索调用。
- [x] Service Definition 不依赖 SQLite 或特定向量数据库。

### Dependencies

Issue 003

### Type

backend

### Priority

high

### Traceability

- PRD: US-008, FR-23, FR-24
- SPEC: §2.4, §5.3

## Issue 019: 实现文档分块、SQLite FTS5 索引与确定性排序

### Description

实现本地 Knowledge Provider，将文档按固定规则分块并写入 SQLite FTS5，通过 BM25 和稳定 Tie-break 提供可重复的全文检索。

### Acceptance Criteria

- [x] 实现 `knowledge_chunks` 与 `knowledge_fts` Schema、关系和唯一约束。
- [x] 文档按 1,000–2,000 Unicode Code Points 目标大小分块，重叠 200 Code Points。
- [x] 每个 Chunk 保存 Document ID、Document Version、Ordinal、Title、Body 和 Location。
- [x] 查询使用 FTS5 BM25，并依次用 Document ID 与 Chunk Ordinal 打破同分排序。
- [x] 相同索引和查询产生完全相同的结果顺序。
- [x] 索引版本落后时结果明确标记版本；索引失败不阻止文档读取。
- [x] 10,000 文档参考集的查询 p95 小于 200 ms。
- [x] 固定知识数据集测试覆盖索引、更新、删除、空文档和确定性排名。

### Dependencies

Issue 007, Issue 016, Issue 018

### Type

backend

### Priority

high

### Traceability

- PRD: US-008, FR-23, FR-24, D-004
- SPEC: §3.6, §5.3, §8.2, §9.1

## Issue 020: 实现检索 Context Contributor、来源引用与空结果

### Description

把 Knowledge Retrieval 接入 Context Assembly 和 Session Event Log，为模型与后续 UI 提供可追踪来源，同时明确处理无结果场景。

### Acceptance Criteria

- [x] Rigo Work Context Contributor 可以根据用户 Query 调用 Knowledge Provider。
- [x] 检索结果按 Context Assembly 的稳定顺序进入模型请求。
- [x] 进入模型的每个片段可以追踪到 Provider、Document、Version、Chunk 和 Location。
- [x] 检索 Query 摘要与 Source IDs 写入 `knowledge/retrieved` Session Event。
- [x] 最终响应 Projection 提供可点击或可定位的 Source Reference 数据。
- [x] 无匹配结果时不构造虚假来源，并返回明确的无结果状态。
- [x] 集成测试使用固定知识数据集验证检索、上下文、事件与来源 Projection。

### Dependencies

Issue 011, Issue 019

### Type

backend

### Priority

high

### Traceability

- PRD: US-008, FR-23, FR-24
- SPEC: §3.7, §5.2, §5.3, §9.3

## Issue 021: 实现 Action Registry、Schema 校验与 Policy 流水线

### Description

实现统一 Action Service，使所有领域动作通过 Definition 解析、输入校验、副作用分类和 Policy Hook，再决定是否进入审批与执行阶段。

### Acceptance Criteria

- [x] Action Definition 包含名称、描述、输入 Schema 和执行函数。
- [x] `ctx.actions` 支持注册、查找和卸载 Action Definition。
- [x] 输入在任何 Policy、Approval 或副作用执行前完成 Schema 校验。
- [x] Action 明确标记 `none`、`local-read`、`local-write` 或 `external-write` 副作用类型。
- [x] 每次请求分配唯一 Action Execution ID。
- [x] `actions/pre-policy` 可以拒绝、允许或要求审批，并返回结构化结果。
- [x] Action 插件卸载后不能接受新调用，未完成执行进入取消流程。
- [x] 测试覆盖未知 Action、Schema 失败、Policy 拒绝、注册覆盖和卸载。

### Dependencies

Issue 012

### Type

backend

### Priority

high

### Traceability

- PRD: US-010, FR-17, FR-18, FR-35
- SPEC: §2.4, §5.4, §6.1

## Issue 022: 实现 Action 持久化、幂等、取消及生命周期清理

### Description

为 Action Pipeline 增加持久状态、幂等保护、Abort 传播和恢复状态，确保重试或重启不会重复外部副作用。

### Acceptance Criteria

- [x] 实现 SPEC §3.4 的 `action_executions` 表、状态约束和唯一幂等索引。
- [x] 同一 `action_name + idempotency_key` 已成功时返回原结果，不再次执行。
- [x] 同键正在运行时返回当前状态；同键不同请求返回 `IDEMPOTENCY_CONFLICT`。
- [x] 已失败 Action 不自动重试副作用，调用方必须生成新幂等键。
- [x] `AbortSignal` 可以取消尚未提交的执行并持久化 `cancelled` 状态。
- [x] 插件执行中卸载时取消未完成 Action；已提交副作用不会伪造回滚结果。
- [x] Action 状态转换使用短事务，事务内不等待模型或用户审批。
- [x] 测试覆盖成功、失败、重复提交、并发同键、不同请求冲突、Abort 和卸载。

### Dependencies

Issue 007, Issue 021

### Type

backend

### Priority

high

### Traceability

- PRD: US-010, FR-21, FR-35, NFR-6
- SPEC: §3.4, §5.4, §6.2, §8.3

## Issue 023: 实现 Approval Service、状态机与持久化

### Description

实现写操作审批服务，使需要批准的 Action 在执行前持久化 Approval Request，并只允许 Pending 状态发生一次终态转换。

### Acceptance Criteria

- [x] 实现 SPEC §3.3 的 `approvals` 表、唯一 Action Execution 关联和乐观版本字段。
- [x] 读取操作默认无需审批，写操作在执行前创建 Approval Request。
- [x] Request 包含动作名称、目标、参数摘要、预期影响和过期时间。
- [x] `pending` 只能转换为 `approved`、`denied`、`expired` 或 `cancelled`。
- [x] Approval 决定使用 `expectedVersion` 条件更新；重复决定返回 `APPROVAL_ALREADY_DECIDED`。
- [x] 过期请求返回 `APPROVAL_EXPIRED`，拒绝结果不执行对应 Action。
- [x] 批准后重新校验 Action 和目标版本，再恢复原 Tool Call。
- [x] 重启后可以重新加载 Pending Approval 并保持 Agent `approval/waiting` 进度。

### Dependencies

Issue 007, Issue 022

### Type

backend

### Priority

high

### Traceability

- PRD: US-012, FR-19, FR-20
- SPEC: §3.3, §4.6, §5.4, §5.6, §5.7

## Issue 024: 实现统一 Audit 事件、脱敏与 Projection

### Description

实现基于 Session Event Log 的统一审计服务，记录检索、模型、审批、Action 和文档变化，并在写入前执行凭据与敏感字段脱敏。

### Acceptance Criteria

- [x] Audit 不创建第二份事实日志，所有审计事实写入 `session_events`。
- [x] 每个 Turn、Step、Retrieval、Approval、Action 和 Document Version 事件包含可关联标识。
- [x] Action 记录输入摘要、状态、结果摘要和执行时间。
- [x] Approval 记录 Request、Decision、决定时间和处理者信息。
- [x] Credential Value、敏感字段和任意 Provider 原始响应不会进入 Session、Audit、SSE 或日志。
- [x] Audit 写入失败时，外部写 Action 不得开始。
- [x] 提供按 Session 和序号排序的 Audit Projection。
- [x] 自动化测试验证字段级脱敏、错误对象规范化和 Projection 顺序。

### Dependencies

Issue 006, Issue 007, Issue 022

### Type

backend

### Priority

high

### Traceability

- PRD: US-013, FR-22, FR-33, FR-34
- SPEC: §3.7, §6.3, §7.4, §9.1

## Issue 025: 实现文档原子写入、版本保护及崩溃恢复

### Description

实现经过审批的本地文档写入，以 Expected Version、临时文件、原子替换、Hash 校验和 Action Journal 保证无部分写入与可恢复性。

### Acceptance Criteria

- [x] 写入请求包含目标相对路径、Expected Version、新内容和幂等键。
- [x] 写入前重新验证 Workspace 边界、当前 Version 和 Content Hash。
- [x] Version 不匹配返回 `DOCUMENT_VERSION_CONFLICT`，目标文件保持不变。
- [x] 写入使用同目录临时文件、完整刷新和原子重命名，失败不留下部分目标内容。
- [x] 成功后重新读取目标、计算 Hash、递增 Version 并返回新版本。
- [x] 未批准、已拒绝或已过期的请求不会修改文件。
- [x] 进程在原子替换后、事件提交前崩溃时，恢复器通过目标 Hash 补记成功或标记 `recovery-required`。
- [x] 同一幂等键重复提交只产生一次文件副作用。
- [x] 测试覆盖成功、版本冲突、拒绝、重复提交、磁盘失败和崩溃恢复。

### Dependencies

Issue 016, Issue 022, Issue 023, Issue 024

### Type

backend

### Priority

high

### Traceability

- PRD: US-011, FR-19, FR-21, FR-26, FR-27, NFR-5, NFR-6
- SPEC: §3.4, §3.5, §5.5, §6.3

## Issue 026: 实现文档读写 Tool/Action 与修改 Diff

### Description

向模型暴露安全的文档读取 Tool 和文档写入 Tool/Action Bridge，使写入先形成可审阅提案与 Diff，再进入 Policy、Approval 和原子写入流程。

### Acceptance Criteria

- [x] Document Read Tool 使用 Documents Service，返回内容、版本和可追踪来源。
- [x] Document Write Tool 只创建包含目标、Expected Version、新内容和幂等键的 Action Request。
- [x] 写入执行前生成确定性的修改摘要或纯文本 Diff。
- [x] Tool Result 使用统一成功或失败结构，并引用 Action Execution ID。
- [x] Read 默认无需审批；Write 必须通过 Action Policy 与 Approval。
- [x] Approval 期间目标变化时，执行返回版本冲突而不是覆盖文件。
- [x] Tool 或 Action 插件卸载后撤销注册，新的模型请求不再看到对应 Schema。
- [x] 集成测试覆盖读取、提案、批准、拒绝、版本冲突和重复提交。

### Dependencies

Issue 017, Issue 020, Issue 021, Issue 025

### Type

backend

### Priority

high

### Traceability

- PRD: US-009, US-010, US-011, FR-17–FR-21, FR-25–FR-27
- SPEC: §2.6, §5.4, §5.5, §9.3

## Issue 027: 实现 Runtime Facade 与进程内 SDK

### Description

实现 Web Host 与嵌入式调用共同依赖的 Runtime Facade，并提供不经过网络的进程内 SDK，统一 Session、Agent、Approval 和 Audit 语义。

### Acceptance Criteria

- [x] Runtime Facade 提供创建、读取、关闭 Session 和获取 Projection 的接口。
- [x] Facade 支持发送消息、Abort、订阅 Session/Agent Event。
- [x] Facade 支持查询 Pending Approval、提交 Approve/Deny 和读取 Audit Projection。
- [x] 进程内 SDK 只封装 Facade，不导入具体 Agent Loop、SQLite 或领域 Provider。
- [x] SDK 返回统一错误码和结构化错误详情。
- [x] SDK 订阅支持取消，释放后不保留事件监听器。
- [x] 集成测试覆盖发送、流式事件、审批、Abort、关闭和恢复 Session。

### Dependencies

Issue 008, Issue 015, Issue 023, Issue 024

### Type

backend

### Priority

high

### Traceability

- PRD: US-015, FR-9, FR-31, FR-32
- SPEC: §2.4, §4.1, §9.3

## Issue 028: 实现 Health、Session、Message、Abort HTTP API

### Description

在 Node 24 Host 中实现 `/api/v1` 的健康、Session、消息和 Abort 接口，所有行为委托给 Runtime Facade。

### Acceptance Criteria

- [x] 实现 `GET /api/v1/health`，返回 Runtime 与数据库健康状态。
- [x] 实现 Session 创建、读取和删除接口，校验 Provider、Model、Title 与 Workspace Root。
- [x] 实现消息发送接口，接受唯一 `clientMessageId` 并返回 `202` 与 Turn ID。
- [x] 重复 `clientMessageId` 返回原 Turn ID，不创建重复输入。
- [x] 实现 Session Abort，并在删除活动 Session 时先取消再释放。
- [x] JSON 字段校验失败返回统一 `INVALID_REQUEST` 错误信封。
- [x] 服务默认只监听 `127.0.0.1`，UI 与 API 同源。
- [x] API 集成测试覆盖成功、Provider 不存在、Session Busy、重复消息、Abort 和删除。

### Dependencies

Issue 027

### Type

backend

### Priority

high

### Traceability

- PRD: US-015, FR-28, FR-31
- SPEC: §4.1, §4.2, §4.3, §4.4, §6.1

## Issue 029: 实现 SSE 事件流、持久化重放与断线恢复

### Description

实现 Session SSE 事件端点，以 Session 序号作为事件 ID，并支持从 `Last-Event-ID` 对持久化事件进行确定性重放。

### Acceptance Criteria

- [x] 实现 `GET /api/v1/sessions/:id/events` 并返回 `text/event-stream`。
- [x] 每个 Frame 使用 Session Event Seq 作为 SSE ID，并输出规范事件类型。
- [x] 客户端携带 `Last-Event-ID` 时从下一序号开始重放。
- [x] ID 很旧但 Session 存在时从 SQLite 持久事件重放；Session 不存在返回 `404`。
- [x] SSE 断开不终止 Agent，重连后不丢失或重复投影事件。
- [x] 1,000 个事件的重放耗时小于 1 秒，持久事件到客户端 p95 小于 250 ms。
- [x] 客户端重连策略使用 1s、2s、5s、10s 上限退避。
- [x] 集成测试覆盖实时发送、断线、重放、空 Session 和删除 Session。

### Dependencies

Issue 008, Issue 028

### Type

backend

### Priority

high

### Traceability

- PRD: US-014, US-015, FR-28, FR-31, FR-32
- SPEC: §4.5, §6.2, §8.2

## Issue 030: 实现 Approval/Audit API 与统一错误信封

### Description

实现 Pending Approval、Approval Decision 和 Audit Projection HTTP API，并把领域错误稳定映射到 SPEC 定义的 HTTP 状态与错误信封。

### Acceptance Criteria

- [x] 实现按 Session 查询 Pending Approval 的接口。
- [x] 实现 `POST /api/v1/approvals/:id/decision`，接受 Decision、Expected Version 和 Comment。
- [x] Approve 返回更新后的 Approval 与 Action 状态；Action 完成结果通过 SSE 到达。
- [x] Deny、Expired、重复处理和乐观锁冲突映射到规定错误码与 HTTP 状态。
- [x] 实现按 Session 查询有序 Audit Projection 的接口。
- [x] 所有错误返回 Code、Message、Retryable、Details 和 Request ID，且不泄露敏感 Provider Response。
- [x] 修改状态请求实施同源、Host、Origin 和 CSRF 校验。
- [x] 集成测试覆盖批准、拒绝、重复决定、过期、Audit 查询和错误脱敏。

### Dependencies

Issue 023, Issue 024, Issue 028

### Type

backend

### Priority

high

### Traceability

- PRD: US-012, US-013, US-015, FR-19, FR-20, FR-22, FR-30, FR-31
- SPEC: §4.2, §4.6, §4.7, §6.1, §7.1

## Issue 031: 组装 Rigo Work Base Bundle、Patch 与启动冒烟测试

### Description

组装官方 Rigo Work Base Bundle 和参考 Profile，把 Core、Shared Plugins、Work Providers、API 与产品启动配置组合为可覆盖的本地优先应用。

### Acceptance Criteria

- [x] Bundle 挂载 Session、Context、LLM、Agent、Agent Loop 和 App Boot。
- [x] Bundle 挂载 SQLite、Knowledge、Documents、Actions、Approval 和 Audit 插件。
- [x] Bundle 挂载 Runtime Facade、HTTP/SSE 与 Rigo Work UI API 支撑插件。
- [x] Bundle 不挂载 Shell、Git、LSP、Sandbox 或 Rigo Code 专用 Prompt。
- [x] 用户可以通过 Patch 替换 LLM Provider 和 Knowledge Provider。
- [x] 用户可以通过 Patch 禁用 Document Write Tool/Action，同时保留读取能力。
- [x] 系统可以输出 Rigo Work Bundle 的最终插件树。
- [x] 冒烟测试在全新 Harness Home、临时 Workspace 和 Mock LLM 下启动、健康检查并正常释放。
- [x] Reference Host 在 Node 24 中通过 typecheck、lint 和启动测试。

### Dependencies

Issue 005, Issue 010, Issue 020, Issue 026, Issue 027, Issue 030

### Type

infra

### Priority

high

### Traceability

- PRD: US-016, FR-6, FR-7, FR-31
- SPEC: §2.2, §2.6, §9.3, §10 Phase 6

## Issue 032: 实现最小 Rigo Code Bundle 与领域隔离测试

### Description

实现经确认的最小 Rigo Code Bundle，以 Repository Context 和 Workspace File Read/Write 验证 Rigo Core 可以服务编程领域且不依赖 Rigo Work 实现。

### Acceptance Criteria

- [x] Bundle 注册 Repository Context Contributor，并向模型提供受控仓库摘要。
- [x] Bundle 提供 Workspace File Read Action 和需要审批的 Workspace File Write Action。
- [x] 文件路径复用 Workspace 边界与 Symlink 逃逸防护。
- [x] Bundle 不包含 Shell、Git、LSP、终端或 Sandbox。
- [x] `packages/code` 不导入 `packages/work` 或任何 Rigo Work Provider。
- [x] Rigo Core 无需修改即可在 Profile 中切换为 Minimal Rigo Code Bundle。
- [x] 插件树输出可以证明 Work 与 Code Provider 没有交叉挂载。
- [x] 集成测试覆盖仓库上下文、文件读取、审批写入、卸载与领域隔离。

### Dependencies

Issue 005, Issue 013, Issue 017, Issue 021, Issue 022

### Type

backend

### Priority

medium

### Traceability

- PRD: FR-5, FR-38, D-002
- SPEC: §2.2, §2.5, §9.3, §10 Phase 6

## Issue 033: 实现 Rigo Work Session、对话、流式状态和来源 UI

### Description

新建精简 React/Vite Rigo Work UI，交付 Session、对话、Agent 进度、SSE 流式输出和知识来源浏览能力。

### Acceptance Criteria

- [x] 用户可以创建 Session，并选择 Provider、Model、Workspace Root 与可选标题。
- [x] 用户可以打开已有 Session 并发送自然语言消息。
- [x] UI 通过 SSE 增量展示 Assistant 输出，不直接消费原始 LLM Provider Stream。
- [x] UI 显示 Agent `idle`/`running` 状态和 Context、Retrieval、LLM、Approval、Action 等详细阶段。
- [x] 回答显示可点击或可定位的来源引用；空检索明确显示未找到相关资料。
- [x] SSE 断开后使用最后事件 ID 重连，重新打开 Session 可以恢复既有事件。
- [x] 流式区域和来源引用支持键盘导航，失败状态不只通过颜色表达。
- [x] Markdown 渲染禁用原始 HTML，外部链接与 Source URI 使用安全策略。
- [x] 浏览器测试验证创建、打开、发送、流式更新、来源和断线恢复。

### Dependencies

Issue 020, Issue 028, Issue 029, Issue 031

### Type

frontend

### Priority

high

### Traceability

- PRD: US-008, US-014, FR-28, FR-29, D-006
- SPEC: §4, §5.6, §7.5, §9.4

## Issue 034: 实现审批、Diff、Action 结果与 Audit Timeline UI

### Description

补齐 Rigo Work 的可控写操作界面，使用户可以查看 Action 影响和 Diff、批准或拒绝，并在同一 Session 中查看 Action 结果和审计时间线。

### Acceptance Criteria

- [x] UI 显示 Pending Approval 的动作名称、目标、参数摘要、预期影响和过期状态。
- [x] 文档修改以纯文本安全渲染的摘要或 Diff 展示。
- [x] 用户可以批准或拒绝，并提交当前 Expected Version，按钮具有明确文本和键盘可达性。
- [x] Agent 等待审批时显示明确状态；重复或过期决定显示对应冲突信息。
- [x] UI 通过 SSE 展示 Action `awaiting-approval`、`running`、`succeeded`、`failed` 和 `recovery-required` 状态。
- [x] 写入完成后显示新文档版本、结果摘要和错误详情。
- [x] Audit Timeline 按 Session Seq 展示 Retrieval、Approval、Action、Document 与 Agent Error 事件。
- [x] 页面、事件和错误中不显示 Credential Value 或未脱敏 Provider Response。
- [x] 浏览器视觉与交互测试覆盖批准、拒绝、版本冲突、重复决定和审计展示。

### Dependencies

Issue 025, Issue 030, Issue 033

### Type

frontend

### Priority

high

### Traceability

- PRD: US-011, US-012, US-013, US-014, FR-26, FR-27, FR-30
- SPEC: §3.7, §4.6, §5.6, §7.5, §9.4

## Issue 035: 建立上游兼容矩阵与测试来源映射

### Description

建立 Rigo Core 迁移范围的兼容矩阵，把每个本地包和关键测试追踪到固定上游来源，并记录适配或有意省略的理由。

### Acceptance Criteria

- [x] 兼容矩阵覆盖每个迁移至 Rigo Core 的上游包。
- [x] 每项测试记录 Upstream File、Upstream Test Name、Local Test File 和状态。
- [x] 状态只使用 `unchanged`、`adapted` 或 `intentionally omitted`。
- [x] `adapted` 与 `intentionally omitted` 必须记录具体理由和行为差异。
- [x] 矩阵覆盖 Scope、Session、System Prompt、Tools、Agent、Agent Loop、LLM、Context 和 Invariant。
- [x] 自动检查发现本地兼容测试缺少来源映射时失败。
- [x] 文档明确列出所有有意偏离上游的行为。

### Dependencies

Issue 001, Issue 002, Issue 003

### Type

infra

### Priority

medium

### Traceability

- PRD: US-017, FR-1, FR-2, FR-36
- SPEC: §2.3, §9.2

## Issue 036: 迁移 Core 兼容测试并配置 CI 阻断门禁

### Description

迁移和适配固定上游的 Core 行为测试，在 Node 与 Bun 中验证关键状态机、生命周期与流式协议，并将失败设置为 CI 合入阻断条件。

### Acceptance Criteria

- [x] 测试覆盖 Scope 隔离、Cordis 插件卸载和依赖消失后的 Fiber 刷新。
- [x] 测试覆盖 Session Event 顺序、历史派生和非法 Invariant。
- [x] 测试覆盖 System Prompt、Tool 生命周期和 Context Contributor 排序/卸载。
- [x] 测试覆盖 Agent 创建释放、Turn/Step 多步状态机、并发与 Abort 传播。
- [x] 测试覆盖 LLM Stream 组装、未知 Tool、断流和 Provider 失败。
- [x] 测试覆盖 Action Schema、幂等、取消和插件卸载。
- [x] 同一适用测试代码在 Node 和 Bun 中执行。
- [x] 每个测试与 Issue 035 的来源矩阵一致，缺失映射或失败时 CI 阻止合入。
- [x] 兼容测试通过率达到 100%。

### Dependencies

Issue 014, Issue 020, Issue 022, Issue 035

### Type

infra

### Priority

high

### Traceability

- PRD: US-017, FR-35, FR-36
- SPEC: §9.2, §9.5, §10 Phase 1

## Issue 037: 实现 Rigo Work 完整 Happy Path E2E

### Description

使用 Playwright、Mock LLM、固定知识数据集和临时 Workspace 实现完整 Rigo Work Happy Path，验证从 UI 输入到审批写入和审计展示的全栈链路。

### Acceptance Criteria

- [x] 测试创建独立临时 Harness Home、SQLite 数据库、知识文件和目标文档。
- [x] 测试通过官方 Rigo Work Bundle 启动隔离 Server 并打开 Web UI。
- [x] 用户创建 Session、发送问题，Agent 从固定知识集检索内容。
- [x] UI 流式显示带可定位来源引用的回答。
- [x] Mock LLM 提出文档写入，UI 显示修改 Diff 和 Approval Request。
- [x] 用户批准后文档发生一次且仅一次修改，并返回新版本。
- [x] UI 显示 Action 成功结果与完整 Audit Timeline。
- [x] 测试验证 Web UI 与 Headless SDK/API 对同一事件日志产生一致 Projection。
- [x] 测试独立、可重复，在结束后清理全部数据并在 CI 中通过。

### Dependencies

Issue 032, Issue 034, Issue 036

### Type

fullstack

### Priority

high

### Traceability

- PRD: US-018, FR-28–FR-32, FR-37
- SPEC: §9.3, §9.4, §9.5

## Issue 038: 实现拒绝、冲突、幂等、重连和安全 E2E

### Description

扩展最终 E2E 门禁，覆盖最关键的失败与安全路径，证明拒绝、版本冲突、重复操作、断线和越界访问不会造成数据损坏或敏感信息泄漏。

### Acceptance Criteria

- [x] 用户拒绝 Approval 后目标文档保持不变，UI 与 Audit 显示结构化拒绝结果。
- [x] Approval 等待期间外部修改文档后，批准返回版本冲突且不覆盖新内容。
- [x] 重复 Approval 或重复 Action 提交不会产生第二次文件副作用。
- [x] SSE 断开重连后事件不丢失，UI Projection 与持久化 Session 一致。
- [x] 绝对路径、`..` 穿越和逃逸 Symlink 均被拒绝，工作区外文件不变化。
- [x] Credential Value 不出现在页面、Session Event、Audit、SSE 或日志中。
- [x] Action 在原子写入与事件补记之间模拟崩溃后，恢复为成功或 `recovery-required`，不会自动重复写入。
- [x] 测试覆盖 Session 删除时的活动 Turn Abort 与资源释放。
- [x] 所有场景自建并清理测试数据，可重复运行并在 CI 中通过。

### Dependencies

Issue 037

### Type

fullstack

### Priority

high

### Traceability

- PRD: US-018, FR-20, FR-21, FR-27, FR-33, FR-34, FR-37
- SPEC: §5.5, §5.8, §6, §7, §9.4
