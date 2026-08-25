# PRD：Work & Code Harness

## 1. Introduction / Overview

Work & Code Harness 是一个基于 `@teoclub/cordis` 的插件化 Agent 运行时与参考产品。

产品不从零实现 Agent Runtime，而是固定 DeepSeek Harness 上游提交，复用其经过验证的 Harness Core 工程代码、运行语义和测试体系，再迁移到自有命名空间。Coding 和 Work 不分别建设两套 Harness，而是共享领域无关的 Core，通过不同的插件、Provider 和 Bundle 提供领域能力。

产品包含两个层面：

- 面向开发者的 Harness 框架：提供 Agent、Session、LLM、Context、Tool/Action、事件、插件组合与生命周期能力。
- 面向用户的 Work Agent 参考产品：提供知识检索、文档读写、写操作审批、审计和 Web UI。

MVP 采用单用户、本地优先部署，官方参考产品聚焦 Work 场景。完整 Coding 工具集不属于 MVP，但 Core 不得包含 Work 专用依赖，并应允许后续挂载 Coding Bundle。

## 2. Product Principles

- Core 只包含 Coding 和 Work 共用且每次 Agent 执行不可缺少的能力。
- RAG、审批、持久化和 Workflow 属于可选 Shared Plugins。
- 文件系统、Shell、LSP、邮件、文档、日历等属于领域能力插件。
- Agent 公共接口与默认 Agent Loop 实现分离。
- 模型可见信息必须能够从 Session Event Log 重建。
- 外部写操作必须经过 Policy、Approval 和 Audit 流水线。
- 扩展插件依赖 Service Definition，不依赖具体 Provider。
- 第一阶段保持上游行为，再进行领域适配。
- 所有上游代码必须记录固定提交、来源路径和本地修改。

## 3. Goals

- 固定一个 DeepSeek Harness 上游提交并生成可审计的迁移清单。
- 复用并迁移领域无关的 Harness Core，而非重新实现。
- 建立基于 `@teoclub/cordis` 的可组合插件运行时。
- 提供稳定的 Agent、Session、Context、LLM 和 Action 公共接口。
- 通过 Work Bundle 提供知识检索、文档读取和文档写入能力。
- 所有写操作在执行前获得用户审批。
- Web UI 和 Headless SDK/API 使用同一 Agent Runtime。
- 使用自动化测试验证迁移后 Core 与上游的关键行为一致。
- 通过完整 E2E 测试验证检索、审批、执行、审计和 UI 展示链路。
- 为后续 Coding Bundle 保留明确且不依赖 Work 实现的扩展边界。

## 4. Target Users

### Framework Developer

希望通过插件扩展模型、知识源、工具、策略、存储或交互界面的开发者。

### Work User

希望通过自然语言检索本地知识、生成内容并在审批后修改文档的用户。

### Maintainer

负责同步 DeepSeek Harness 上游、审计迁移代码、维护兼容性测试的工程人员。

## 5. User Stories

### US-001：固定并审计上游源码

**Description:** 作为维护者，我希望固定 DeepSeek Harness 上游提交并记录迁移来源，以便代码复用可追踪、可复现、可更新。

**Acceptance Criteria:**

- [ ] 上游清单记录仓库地址、完整 Commit SHA、原始路径和本地目标路径。
- [ ] 每个迁移包标记为 `KEEP`、`ADAPT`、`DROP` 或 `REPLACE`。
- [ ] 清单记录所有本地修改及修改理由。
- [ ] 仓库包含 DeepSeek Harness MIT 许可证和第三方声明。
- [ ] 自动检查可以发现清单中不存在的迁移包。
- [ ] 自动检查可以发现缺少固定 Commit SHA 的条目。
- [ ] Typecheck 和 lint 通过。

### US-002：启动领域无关的 Harness Core

**Description:** 作为框架开发者，我希望启动一个不依赖 Coding 或 Work 插件的最小 Core，以便验证公共运行时边界。

**Acceptance Criteria:**

- [ ] Core 可以创建 Cordis `Context` 并加载最小插件树。
- [ ] Core 可以等待所有必要插件进入可用状态。
- [ ] 启动失败时已加载插件按照相反顺序释放。
- [ ] Core 源码不导入 Coding 或 Work 领域包。
- [ ] 自动化测试验证启动、正常释放和部分启动失败。
- [ ] Typecheck 和 lint 通过。

### US-003：声明式插件组合

**Description:** 作为框架开发者，我希望通过 Profile、Bundle 和 Patch 组合插件，以便不修改 Core 就能创建不同产品形态。

**Acceptance Criteria:**

- [ ] Profile 能声明有序 Bundle 列表。
- [ ] Bundle 能声明其 Cordis 配置或 Patch 文件。
- [ ] Profile Patch 可以按稳定条目 ID 替换配置。
- [ ] Home Patch 可以覆盖 Profile Patch。
- [ ] CLI Patch 可以覆盖其他配置层。
- [ ] 系统可以输出最终生效的插件树。
- [ ] 不存在的 Patch 目标产生可观察的错误或警告。
- [ ] 配置加载失败时保留最后一次有效插件树。
- [ ] Typecheck 和 lint 通过。

### US-004：Session Event Log

**Description:** 作为 Agent 用户，我希望所有模型可见事实和动作结果都记录在 Session 中，以便恢复、回放和审计。

**Acceptance Criteria:**

- [ ] Session 支持仅追加的有序事件。
- [ ] 每个事件包含稳定 Session ID 和单调递增序号。
- [ ] Session 能从事件日志派生模型消息历史。
- [ ] 用户消息、模型输出、Tool Call 和 Tool Result 均写入日志。
- [ ] Session 能从持久化事件恢复相同的模型消息历史。
- [ ] 非法事件顺序被 Invariant 测试识别。
- [ ] 自动化测试覆盖创建、追加、恢复和释放。
- [ ] Typecheck 和 lint 通过。

### US-005：LLM Provider 注册与流式协议

**Description:** 作为插件开发者，我希望注册不同的模型 Provider，以便 Agent Loop 不依赖具体模型厂商。

**Acceptance Criteria:**

- [ ] `ctx.llm` 可以注册具名模型 Provider。
- [ ] Agent 可以通过 Provider ID 和 Model ID 选择模型。
- [ ] Provider 使用统一 `Message`、`ContentBlock` 和 `StreamChunk` 协议。
- [ ] 流式输出支持文本、工具调用、用量和终止原因。
- [ ] `AbortSignal` 能终止正在运行的模型请求。
- [ ] 未知 Provider 返回结构化错误。
- [ ] CI 使用确定性的 Mock LLM Provider。
- [ ] Typecheck 和 lint 通过。

### US-006：可扩展 Context Assembly

**Description:** 作为插件开发者，我希望注册上下文贡献器，以便 Coding 和 Work 插件能够向模型请求添加不同的信息。

**Acceptance Criteria:**

- [ ] `ctx.context` 支持注册和卸载上下文贡献器。
- [ ] 贡献器拥有稳定 ID 和确定性排序。
- [ ] Context Assembly 支持系统提示词、Session History、检索结果和运行时上下文。
- [ ] 插件卸载后，其上下文贡献不再出现在请求中。
- [ ] 进入模型请求的内容可以追溯到 Session Event 或具名贡献器。
- [ ] 单个贡献器失败时产生结构化错误。
- [ ] 自动化测试覆盖顺序、卸载和失败行为。
- [ ] Typecheck 和 lint 通过。

### US-007：Agent 公共接口与默认 Agent Loop

**Description:** 作为 UI 或 SDK 开发者，我希望通过稳定的 Agent 接口驱动会话，而不依赖具体 Loop 实现。

**Acceptance Criteria:**

- [ ] `ctx.agents` 支持创建、获取和释放 Agent。
- [ ] Agent 暴露 `send`、`steer`、`inject` 和 `abort`。
- [ ] Agent 暴露 `idle` 和 `running` 状态。
- [ ] 默认 Agent Loop 可以执行一个没有 Tool Call 的完整 Turn。
- [ ] 默认 Agent Loop 可以连续执行包含 Tool Call 的多个 Step。
- [ ] 同一 Agent 不会并发执行两个冲突的 Turn。
- [ ] `abort` 可以终止模型调用和正在运行的 Action。
- [ ] UI 和 SDK 只依赖 Agent 公共接口。
- [ ] Typecheck 和 lint 通过。

### US-008：Knowledge Retrieval 插件

**Description:** 作为 Work 用户，我希望检索本地知识并看到来源，以便基于可验证资料完成问答。

**Acceptance Criteria:**

- [ ] `ctx.knowledge` 或等价 Retrieval Service 支持注册 Provider。
- [ ] MVP 提供本地知识 Provider。
- [ ] 检索请求支持 Query、Top-K 和可选过滤条件。
- [ ] 检索结果包含来源 ID、标题、正文片段和定位信息。
- [ ] Context Contributor 可以将检索结果加入模型请求。
- [ ] 最终回答展示至少一个可点击或可定位的来源引用。
- [ ] 无匹配结果时 UI 明确显示未找到相关资料。
- [ ] 自动化测试使用固定知识数据集并产生确定性结果。
- [ ] Typecheck 和 lint 通过。

### US-009：文档读取能力

**Description:** 作为 Work 用户，我希望 Agent 能读取本地文档，以便分析和回答与文档内容有关的问题。

**Acceptance Criteria:**

- [ ] `ctx.documents` 提供稳定的读取接口。
- [ ] MVP Provider 支持本地 Markdown 和纯文本文件。
- [ ] 读取结果包含文档 ID、版本、内容和来源位置。
- [ ] 不存在的文档返回结构化 `NOT_FOUND` 错误。
- [ ] 超出允许工作区的路径被拒绝。
- [ ] 读取操作写入审计记录。
- [ ] 自动化测试覆盖成功读取、文件不存在和越界路径。
- [ ] Typecheck 和 lint 通过。

### US-010：通用 Action 执行流水线

**Description:** 作为插件开发者，我希望所有外部动作经过统一流水线，以便复用参数校验、Policy、Approval、执行和审计能力。

**Acceptance Criteria:**

- [ ] Action Definition 包含名称、描述、输入 Schema 和执行函数。
- [ ] Action 输入在执行前完成 Schema 校验。
- [ ] Action 执行产生统一的成功或失败结果。
- [ ] 写操作 Action 必须标记副作用类型。
- [ ] 每次 Action 执行拥有唯一执行 ID。
- [ ] 相同幂等键不会造成重复副作用。
- [ ] Action 支持 `AbortSignal`。
- [ ] Action 插件卸载后不能再被新请求调用。
- [ ] 自动化测试覆盖校验失败、执行失败、取消和幂等重试。
- [ ] Typecheck 和 lint 通过。

### US-011：文档写入与版本保护

**Description:** 作为 Work 用户，我希望 Agent 在获得批准后修改文档，以便安全地完成内容更新。

**Acceptance Criteria:**

- [ ] 文档写入 Action 提交目标文档、预期版本和新内容。
- [ ] 执行前展示文档修改摘要或 Diff。
- [ ] 当前版本与预期版本不一致时拒绝写入。
- [ ] 写入成功后返回新版本。
- [ ] 写入失败不会留下部分更新。
- [ ] 每次写入使用幂等键。
- [ ] 未获批准的写入不会修改文件。
- [ ] 自动化测试覆盖成功、版本冲突、拒绝和重复提交。
- [ ] Typecheck 和 lint 通过。

### US-012：写操作审批

**Description:** 作为 Work 用户，我希望在外部写操作执行前查看并批准或拒绝，以便保持对工作结果的控制。

**Acceptance Criteria:**

- [ ] 读取操作默认无需审批。
- [ ] 写操作执行前创建 Approval Request。
- [ ] Approval Request 显示动作名称、目标、参数摘要和预期影响。
- [ ] 用户批准后只执行对应的 Action Request。
- [ ] 用户拒绝后返回结构化拒绝结果。
- [ ] Approval Request 过期后不能执行。
- [ ] 已处理的 Approval Request 不能重复处理。
- [ ] Agent 等待审批时显示明确状态。
- [ ] 审批 UI 在浏览器中完成视觉和交互验证。
- [ ] Typecheck 和 lint 通过。

### US-013：统一审计与运行记录

**Description:** 作为用户或维护者，我希望查看 Agent 的检索、模型调用、审批和 Action 记录，以便理解任务如何完成。

**Acceptance Criteria:**

- [ ] 每个 Turn 和 Step 都有可关联的审计标识。
- [ ] 检索请求和来源记录在审计流中。
- [ ] Approval Request、决定和处理者记录在审计流中。
- [ ] Action 的输入摘要、结果和执行时间记录在审计流中。
- [ ] 凭据和敏感值不会写入审计记录。
- [ ] Web UI 可以按 Session 查看按时间排序的执行记录。
- [ ] 审计 UI 在浏览器中完成视觉验证。
- [ ] 自动化测试验证敏感字段被移除。
- [ ] Typecheck 和 lint 通过。

### US-014：Web Work Agent 界面

**Description:** 作为 Work 用户，我希望在浏览器中提问、查看来源、审批动作并接收结果，以便完成完整工作流程。

**Acceptance Criteria:**

- [ ] 用户可以创建或打开一个 Session。
- [ ] 用户可以向 Agent 发送自然语言问题。
- [ ] UI 流式显示模型输出。
- [ ] UI 显示当前 Agent 状态和执行进度。
- [ ] UI 显示知识来源引用。
- [ ] UI 显示待审批 Action。
- [ ] 用户可以批准或拒绝待处理 Action。
- [ ] UI 显示文档修改结果和审计记录。
- [ ] 断开连接后重新打开 Session 可以恢复已有事件。
- [ ] 使用浏览器验证完整交互流程。
- [ ] Typecheck 和 lint 通过。

### US-015：Headless SDK/API

**Description:** 作为集成开发者，我希望通过 Headless SDK/API 驱动同一个 Agent Runtime，以便嵌入其他应用。

**Acceptance Criteria:**

- [ ] API 可以创建、读取和释放 Session。
- [ ] API 可以向 Agent 发送输入。
- [ ] API 可以订阅流式 Session 和 Agent 事件。
- [ ] API 可以查询待处理 Approval Request。
- [ ] API 可以批准或拒绝 Action。
- [ ] API 返回结构化错误码。
- [ ] Web UI 使用的运行语义与 Headless API 一致。
- [ ] API 集成测试覆盖发送、流式输出、审批和取消。
- [ ] Typecheck 和 lint 通过。

### US-016：Work Base Bundle

**Description:** 作为用户，我希望通过一个官方 Work Bundle 启动参考产品，以便无需手工编写完整插件配置。

**Acceptance Criteria:**

- [ ] Work Bundle 挂载 Session、Context、LLM、Agent 和 Agent Loop。
- [ ] Work Bundle 挂载 Knowledge、Documents、Action、Approval 和 Audit 插件。
- [ ] Work Bundle 不挂载 Shell、LSP 或 Coding 专用 Prompt。
- [ ] 用户可以通过 Patch 替换 LLM Provider。
- [ ] 用户可以通过 Patch 替换 Knowledge Provider。
- [ ] 用户可以通过 Patch 禁用文档写入。
- [ ] 系统可以输出 Work Bundle 的最终插件树。
- [ ] Bundle 冒烟测试可以在全新本地目录启动。
- [ ] Typecheck 和 lint 通过。

### US-017：上游行为兼容测试

**Description:** 作为维护者，我希望迁移后的 Core 通过明确的上游行为测试，以便确认复刻没有破坏关键语义。

**Acceptance Criteria:**

- [ ] 兼容矩阵列出每个迁移 Core 包的上游测试来源。
- [ ] Session 事件顺序测试通过。
- [ ] Agent Turn/Step 状态机测试通过。
- [ ] Tool/Action 执行和取消测试通过。
- [ ] Context Contributor 生命周期测试通过。
- [ ] LLM Stream 组装测试通过。
- [ ] Cordis 插件卸载和依赖消失测试通过。
- [ ] 有意偏离上游的行为记录在兼容性文档中。
- [ ] CI 阻止兼容测试失败的变更合入。

### US-018：Work Harness 完整 E2E 测试

**Description:** 作为 QA 工程师，我希望自动化测试覆盖完整 Work Harness 流程，以便发现 UI、API、Agent、知识、审批和文档层之间的回归。

**Acceptance Criteria:**

- [ ] E2E 测试创建独立的临时 Harness Home 和文档工作区。
- [ ] 测试通过 Web UI 创建 Session 并发送问题。
- [ ] Agent 从固定知识数据集中检索相关内容。
- [ ] UI 流式显示带来源引用的回答。
- [ ] Agent 提出一个文档写入 Action。
- [ ] UI 显示修改摘要和 Approval Request。
- [ ] 用户批准后文档内容发生一次且仅一次修改。
- [ ] UI 显示 Action 结果和完整审计记录。
- [ ] 测试覆盖拒绝审批路径并断言文档未变化。
- [ ] 测试覆盖重复提交并断言幂等保护生效。
- [ ] 测试独立、可重复，并在结束后清理全部测试数据。
- [ ] E2E 测试在 CI 中运行并通过。
- [ ] 使用浏览器验证最终页面状态。

## 6. Functional Requirements

- FR-1：系统必须从固定的 DeepSeek Harness Commit 迁移 Core 源码。
- FR-2：系统必须记录每个迁移文件或包的上游来源。
- FR-3：系统必须保留适用的上游许可证和版权声明。
- FR-4：系统必须使用 `@teoclub/cordis` 作为插件运行时。
- FR-5：Harness Core 必须与 Coding 和 Work 领域实现解耦。
- FR-6：系统必须通过声明式配置加载插件树。
- FR-7：系统必须支持 Profile 和 Bundle 分层组合。
- FR-8：系统必须支持按稳定条目 ID 应用 Patch。
- FR-9：系统必须提供稳定的 Agent 公共接口。
- FR-10：默认 Agent Loop 必须支持包含多个 Step 的 Turn。
- FR-11：系统必须使用仅追加 Session Event Log 记录模型可见事实。
- FR-12：系统必须能够从 Session Event Log 重建模型消息历史。
- FR-13：系统必须支持注册多个 LLM Provider。
- FR-14：LLM 调用必须支持流式输出。
- FR-15：LLM 调用必须支持取消。
- FR-16：系统必须支持注册有序 Context Contributor。
- FR-17：系统必须提供统一 Action 注册表。
- FR-18：Action 输入必须在执行前通过 Schema 校验。
- FR-19：外部写操作必须在执行前获得批准。
- FR-20：用户拒绝写操作后系统不得产生对应副作用。
- FR-21：写操作必须支持幂等键。
- FR-22：系统必须记录所有 Action 的审计事件。
- FR-23：系统必须提供 Knowledge Retrieval Provider 接口。
- FR-24：检索结果必须包含可追踪来源。
- FR-25：MVP 必须支持读取本地 Markdown 和纯文本文件。
- FR-26：MVP 必须支持审批后写入本地文档。
- FR-27：文档写入必须检查预期版本。
- FR-28：Web UI 必须展示流式 Agent 输出。
- FR-29：Web UI 必须展示来源引用。
- FR-30：Web UI 必须允许用户处理 Approval Request。
- FR-31：Headless API 必须使用与 Web UI 相同的 Agent Runtime。
- FR-32：系统必须支持恢复本地持久化 Session。
- FR-33：凭据不得进入模型上下文。
- FR-34：凭据不得写入 Session 或审计日志。
- FR-35：插件卸载必须撤销其服务、监听器和注册项。
- FR-36：CI 必须运行 Core 行为兼容测试。
- FR-37：CI 必须运行完整 Work Harness E2E 测试。
- FR-38：系统必须允许后续 Coding Bundle 在不修改 Core 的情况下接入。

## 7. Non-Goals

MVP 不包含：

- 完整复刻 DeepSeek Harness 的全部产品包。
- 保持 `@deepseek-ai/dsh-*` 包名兼容。
- 保持 DeepSeek Profile 或 Bundle 配置兼容。
- 完整 Coding Agent 产品。
- Shell、Git、LSP、终端和代码沙箱。
- 邮件、日历、任务系统和 CRM 集成。
- SaaS 多租户和组织级权限模型。
- Agent 默认自主执行外部写操作。
- 插件市场和在线安装服务。
- 多 Agent、Subagent 和 Agent Teams。
- 长时间分布式 Workflow 调度。
- 移动端和桌面客户端。
- 对所有第三方向量数据库提供官方 Provider。
- 与 DeepSeek 品牌或官方产品建立关联。

## 8. Design Considerations

### Web UI

MVP Web UI 应围绕工作过程呈现，而不仅是聊天窗口：

- 对话和流式输出
- 来源引用
- 当前执行阶段
- Action 参数摘要
- 文档修改 Diff
- Approval Request
- Action 结果
- 审计时间线

### Shared Core

Core UI/API 不得出现：

- Coding 专用消息类型
- Work 专用消息类型
- 特定 Provider 类型
- 特定知识库字段
- 特定文档平台字段

领域信息通过插件定义的扩展类型、Context Contributor 和 Action Schema 表达。

### Accessibility

- 审批按钮必须有明确文本。
- 拒绝和失败状态不能只通过颜色表达。
- 流式输出区域必须支持键盘导航。
- 来源引用必须能够通过键盘打开。

## 9. Technical Considerations

- `[Assumption]` 自有 npm 命名空间暂定为 `@teoclub/harness-*`。
- `[Assumption]` MVP 官方领域包暂定为 `@teoclub/work-*`。
- 上游迁移采用“先 Fork 验证、再选择性迁移”的两阶段策略。
- 第一阶段不得同时重写 Agent Loop 状态机。
- `agent-loop` 的迁移必须包含其实际依赖闭包，而非只复制 Core 目录。
- Core 迁移候选包括 `scope`、`session`、`system-prompt`、`tools`、`agent`、`agent-default-model`、`agent-loop`、`llm` 和 `app-boot`。
- DeepSeek 专用环境变量、包名和品牌必须替换。
- 有意偏离上游的行为必须记录在兼容性文档中。
- CI 应使用 Mock LLM、固定检索数据集和临时文档目录。
- 本地持久化实现的最终选型在技术 SPEC 中确定。
- Web UI 是否复用上游 Client 架构在技术 SPEC 中评估。
- Headless API 的传输协议在技术 SPEC 中确定。
- 生产 Provider 的凭据必须通过引用解析，不得直接进入插件配置快照。
- Cordis 的作用域隔离不是安全沙箱；MVP 只允许受控本地文档目录。

## 10. Non-Functional Requirements

- NFR-1：完整 E2E 测试必须可在无外部模型 API 的 CI 环境中运行。
- NFR-2：相同测试数据和 Mock Provider 必须产生确定性事件序列。
- NFR-3：所有本地数据默认存储在明确的 Harness Home 下。
- NFR-4：异常退出后，已提交 Session Event 必须能够恢复。
- NFR-5：写入失败不得留下部分文档内容。
- NFR-6：重复审批或重试不得重复执行相同副作用。
- NFR-7：所有插件必须支持可预测的生命周期释放。
- NFR-8：Core 包不得依赖任何 Work 或 Coding Provider。
- NFR-9：发布产物必须包含适用的第三方许可证和来源清单。
- NFR-10：Typecheck、lint、单元测试、兼容测试和 E2E 测试必须在 CI 中通过。

## 11. Success Metrics

- 迁移范围内的 Core 行为兼容测试通过率为 100%。
- Work Harness 完整 E2E 测试连续运行无非确定性失败。
- 所有写操作均存在 Approval Request 和 Audit Record。
- 拒绝审批路径产生的外部写入次数为 0。
- 幂等重试产生的重复副作用次数为 0。
- 所有 RAG 回答均包含至少一个可追踪来源，无法检索时明确声明无来源。
- Web UI 与 Headless API 对同一事件日志派生出一致结果。
- 替换 LLM Provider 不需要修改 Core。
- 替换 Knowledge Provider 不需要修改 Agent Loop。
- 后续 Coding Bundle 可以仅通过插件和配置接入公共 Core。

## 12. Open Questions

1. 正式产品名称和 npm 命名空间是否使用 `@teoclub/harness-*`？
2. MVP 是否需要提供一个最小 Coding Bundle 作为领域无关性验证，还是只保留兼容测试？
3. Session 持久化默认采用 JSONL、SQLite，还是两者都提供？
4. 本地 Knowledge Provider 默认采用何种索引实现？
5. 文档工作区是否限定为单个目录？
6. Web UI 是复用 DeepSeek Harness Client 架构，还是实现更小的 Work UI？
7. Headless API 使用进程内 SDK、JSON-RPC、HTTP/SSE，还是同时提供两种？
8. MVP 是否需要支持图片、PDF 和 Office 文档，还是仅支持 Markdown/纯文本？
9. 上游同步周期采用按版本、按 Commit，还是按需更新？
