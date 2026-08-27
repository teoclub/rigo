# SPEC: Cordis P0 —— 双运行时接管与发行（@teoclub）

> 技术规格文档，由 PRD 派生
> 来源 PRD：`tasks/prd_cordis_v1.0.md`（v1.0，开发基线，2026-08-24）
> 生成日期：2026-08-24 | 目标分支：`main` | 基线 commit：`2197d45`（Initial commit）
> 覆盖范围：**P0（Phase 0–4）**。P1（CLI v2、类型化配置、Bun HMR 局部重载）与 P2（Bun Provider 插件族）另行出 SPEC。

---

## 1. Summary

### 1.1 What This SPEC Covers

本规格规定 TEO Club 对 DeepSeek Harness `vendor` 中九个 Cordis 框架包的完整技术接管方案：来源审计、Bun workspace monorepo 建立、全量 rescope（`@deepseek-ai/*` → `@teoclub/*`、`cosmokit` → `kit`）、构建链路（Bun workspace + tsdown）、跨运行时 Conformance 测试（Vitest，Node 与 Bun 双执行）、已知缺口修复、Bun 运行时适配与 P0 正式发行。**不改变 Cordis 核心语义**——所有行为保持兼容基线，任何有意变更进入 Breaking Changes 清单。

### 1.2 PRD Reference

- Source: `tasks/prd_cordis_v1.0.md`
- 覆盖目标：G1–G6（§3.1 全部 P0 目标）
- 功能需求覆盖：FR-DIST-001…005、FR-KIT-001…004、FR-SCHEMA-001…004、FR-CORE（§8.4 全部）、FR-LOADER-001…005、FR-INCLUDE-001…005、FR-GROUP-001…002、FR-TIMER-001…003、FR-HMR-001…004（P0 部分）、FR-LOG-001…003
- 验收标准覆盖：AC-001…AC-008
- 非功能需求覆盖：NFR-PERF-001/002、§14.2 可靠性、§14.3 安全、§14.4 可维护性、§14.5 包体积
- 非目标（§3.4）与 P1/P2 目标（§3.2/§3.3）：不纳入本 SPEC，仅在 §11 登记衔接点。

### 1.3 Design Decisions Summary

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | 迁移来源 | 克隆 `deepseek-ai/deepseek-harness` 公开仓库，提取 `vendor/*` 九目录 | 保留完整 `src/`、构建配置、类型配置与测试 fixture（FR-DIST-001）；npm tarball 丢失构建配置与历史 |
| D2 | 构建 | Bun workspaces + **tsdown** | PRD §23 默认决策"优先保留兼容"；tsdown 是已验证基线（SPEC.md §2），产物路径 `lib/`、ESM/ES2024 不变；Bun Build 留待 P1 再评估 |
| D3 | 包管理 | Bun（`bun install`，`bun.lock` + `bunfig.toml`） | PRD §16.1 Bun-first 工具链；不影响包在 Node 中运行 |
| D4 | 测试 | Vitest 4，同一套 Conformance Suite 在 Node 与 Bun 各执行一次 | PRD G5 要求"同一套测试在两个运行时执行"；与上游基线一致；`bun test` 会使套件分裂 |
| D5 | 首发版本 | `@teoclub/cordis@5.0.0`，其余八包按各自 API 变化独立 SemVer | PRD §16.4；scope 变化 + `engines`/`exports` 变化构成 major |
| D6 | 运行时基线 | Node `^22.19.0 \|\| >=24.0.0`；Bun Stable 与前一 Stable（发布时 CI 钉版） | PRD §9.4；`engines` 必须写入每个包（修复基线"无 engines"缺口） |
| D7 | 源码导出 `./src/*` | P0 保留，标记不稳定入口 | PRD §9.6；降低迁移破坏 |
| D8 | Schemastery CJS | P0 保留 CJS 双格式（`exports` 分 `import`/`require`） | PRD §23.3 默认保留兼容；是否收敛留 P1 |
| D9 | 覆盖率 | V8 coverage，门禁见 §9.5；Conformance 结果优先于覆盖率数字 | PRD §15.5 |
| D10 | HMR Bun Engine P0 形态 | 配置热刷新 + 失败时可控完整进程重启；不做模块图局部重载 | PRD FR-HMR-003 P0 最低要求；局部重载属 P1 |

---

## 2. Architecture

### 2.1 System Context

```text
┌─────────────────────────────────────────────────────────────┐
│  teoclub/cordis monorepo（本 SPEC 交付物）                   │
│                                                             │
│  packages/kit ──> packages/schemastery ──> packages/cordis  │
│        └───────────────────────┬──────────────┘             │
│                                v                            │
│                    packages/plugins/{loader,include,        │
│                     group,timer,hmr,logger-console}         │
│                                                             │
│  tests/{conformance,node,bun,integration,package}           │
│  scripts/{audit-source,rescope,verify-packages,             │
│           verify-old-scopes,sync-upstream}                  │
└──────────────────────┬──────────────────────────────────────┘
                       │ 一次性源码输入
                       v
        github.com/deepseek-ai/deepseek-harness @ vendor/*（九目录）
```

- 迁移是**单向流**：上游 commit 固定后复制进入 monorepo，之后所有修改以 TEO Club patch 形式记录于 `docs/upstream.md`。
- 上游同步脚本（`sync-upstream.ts`）仅用于后续 re-sync，P0 只跑一次审计。

### 2.2 Component Design

| 组件 | 职责 | 边界 |
|---|---|---|
| `packages/kit` | 运行时无关 TS 工具（原 cosmokit 有效公共能力） | 禁 `node:*`、`Bun.*`、I/O、Cordis 依赖（FR-KIT-002） |
| `packages/schemastery` | Schema 构建/校验/序列化 | 可依赖 kit；禁依赖 cordis |
| `packages/cordis` | Context/Fiber/Registry/Reflect/Events/Logger/Service/Utils | 源码禁 `Bun.*`/`bun:*`/`node:fs` 等（PRD §9.2）；CLI 宿主逻辑隔离在 `bin.js` |
| `packages/plugins/loader` | EntryTree、动态导入、依赖等待、更新/回滚 | Node ModuleLoader 内部能力不得成为公开依赖（FR-LOADER-004） |
| `packages/plugins/include` | YAML/JSON → EntryTree、Patch、原子写回 | — |
| `packages/plugins/group` | 稳定命名 + 默认导出薄层 | 不复制 Loader Group 实现 |
| `packages/plugins/timer` | 生命周期绑定计时器/节流/防抖 | 公共类型禁 `NodeJS.Timeout` |
| `packages/plugins/hmr` | Node Engine（模块图重载）+ Bun Engine（配置刷新/安全重启） | 双 Engine 共享同一 Config 类型与事件名（FR-HMR-001） |
| `packages/plugins/logger-console` | 控制台日志 exporter | 格式化差异封装在 runtime 入口，输出契约一致 |
| `tests/conformance` | 跨运行时契约套件（单一代码库） | 不 import 任何 runtime 专属 API；运行时差异用注入的 adapter fixture |
| `scripts/*` | 审计、rescope、发布验证门禁 | 见 §2.4 与 §5.1 |

### 2.3 Module Interactions

发布链路（每包发布前必须全绿，PRD §16.3）：

```text
build (tsdown) -> typecheck (tsc -b) -> lint (oxlint)
  -> test:node (vitest run) -> test:bun (vitest run --browser=no, bun 执行)
  -> npm pack -> tarball 解包检查（exports/types/旧 Scope 扫描）
  -> 空项目安装 smoke（Node + Bun）
```

运行时模块交互保持基线不变（见 `docs/architecture.md` 的 Module graph）；本 SPEC 不新增 Core 内部模块，只做 rescope 与缺口修复。

### 2.4 File Structure

```text
cordis/
├── packages/
│   ├── kit/                    [NEW] 源自 vendor/cosmokit
│   │   ├── src/  package.json  tsconfig.json  README.md  LICENSE
│   ├── schemastery/            [NEW] 源自 vendor/schemastery
│   ├── cordis/                 [NEW] 源自 vendor/cordis（含 bin.js）
│   └── plugins/
│       ├── loader/             [NEW] 源自 vendor/loader
│       ├── include/            [NEW] 源自 vendor/include
│       ├── group/              [NEW] 源自 vendor/group
│       ├── timer/              [NEW] 源自 vendor/timer
│       ├── hmr/                [NEW] 源自 vendor/hmr
│       └── logger-console/     [NEW] 源自 vendor/logger-console
├── tests/
│   ├── conformance/            [NEW] context/ fiber/ effect/ events/ registry/ logger/ 套件
│   ├── node/                   [NEW] Node 专属（HMR Node Engine、CJS 加载）
│   ├── bun/                    [NEW] Bun 专属（Bun Engine、Bun 模块解析）
│   ├── integration/            [NEW] 九包组合（cordis.yml 启动全链路）
│   └── package/                [NEW] pack 后空项目安装 smoke
├── examples/{basic,config-tree,hmr,node,bun}/   [NEW]
├── scripts/
│   ├── audit-source.ts         [NEW] Phase 0：来源清单生成（见 §5.1.1）
│   ├── rescope.ts              [NEW] Phase 1：AST + 文本双通道替换（见 §5.1.2）
│   ├── verify-packages.ts      [NEW] 发布门禁：exports/types/tarball 结构
│   ├── verify-old-scopes.ts    [NEW] 零残留门禁（AC-002）
│   └── sync-upstream.ts        [NEW] 后续上游同步
├── docs/                       [NEW] architecture/compatibility/migration/plugin-authoring/upstream
├── package.json  bun.lock  bunfig.toml  tsconfig.json
├── LICENSE  THIRD_PARTY_NOTICES.md  CHANGELOG.md
└── .github/workflows/ci.yml    [NEW] 矩阵：{node22.19, node24, bun-stable, bun-prev}
```

根 `package.json` workspaces：`["packages/*", "packages/plugins/*"]`。所有包 `name` 见 PRD §6.1 映射表（唯一重命名：`@deepseek-ai/cosmokit` → `@teoclub/kit`）。

---

## 3. Data Model

本项目无数据库。数据模型 = 包清单元数据 + Core 内存实体契约 + 来源追踪记录。

### 3.1 Package Manifest Schema（每包必须满足）

```jsonc
// packages/<pkg>/package.json
{
  "name": "@teoclub/cordis",            // 见 PRD §6.1 映射
  "version": "5.0.0",                    // cordis 首发固定 5.0.0；其余独立 SemVer
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0" },   // D6：修复基线无 engines 缺口
  "exports": { /* 见 §4.2 */ },
  "sideEffects": false,                  // 仅 kit 强制（FR-KIT-003）；其余按实际评估
  "peerDependencies": { "@teoclub/cordis": "^5.0.0" },  // 插件包
  "teoclub": {                           // FR-DIST-004 来源元数据（机器可读）
    "source": {
      "repository": "deepseek-ai/deepseek-harness",
      "path": "vendor/cordis",
      "upstreamPackage": "@deepseek-ai/cordis",
      "upstreamVersion": "4.0.1",
      "commit": "<Phase 0 审计确定的 40 位 commit>"
    }
  }
}
```

### 3.2 Core 内存实体契约（保持基线，仅登记）

以下实体字段与关系**冻结为兼容基线**（参见 `docs/architecture.md` 与 `docs/api.md`），P0 不得变更：`Context`（root/fiber/baseUrl/隔离映射/拦截映射）、`Fiber`（uid/state/config/inject/store/inertia）、`Plugin.Runtime`、`Impl`、`Property`、`Hook`、`EffectMeta`、`Message`。字段级变更须走 §5.6 Breaking Changes 流程。

### 3.3 来源追踪记录（FR-DIST-005）

- `docs/upstream.md`：每包一节 —— 上游 commit、upstreamVersion、TEO Club patch 列表（patch = 文件 + 理由 + 引用 Issue）。
- `CHANGELOG.md`（Changesets 管理）：Breaking / Fix / Runtime-diff 三类条目。

### 3.4 Migration Plan（源码迁移，非 DB）

1. Phase 0 固定上游 commit，`scripts/audit-source.ts` 生成 `docs/upstream.md` 初版清单（含 README 漂移标记，AC 前置）。
2. Phase 1 复制 + rescope（§5.1.2），此阶段**禁改行为**——diff 审查要求：除 import/包名/engines/来源元数据外，任何源码 diff 必须 reject。
3. 回滚策略：rescope 在独立分支进行，`git revert` 即回滚；包发布前一切可逆，npm 发布不可逆（靠 `npm dist-tag` 控制，先 `rc` 后 `latest`）。

---

## 4. API Design

### 4.1 公共 API 表面（保持 = 基线，P0 目标是零减损）

**Context API（15 项，全部保留，FR §8.4.1）**：`new Context()`、`Context.is()`、`ctx.extend()`、`ctx.isolate()`、`ctx.intercept()`、`ctx.get()`、`ctx.set()`、`ctx.provide()`、`ctx.accessor()`、`ctx.mixin()`、`ctx.plugin()`、`ctx.inject()`、`ctx.effect()`、`ctx.on()/once()`、`ctx.logger()`。

**Fiber API**：`dispose()`、`await()`、`restart()`、`update()`、`getEffects()`、`assertActive()`、`state`、`config`、`_config`。

**插件契约**：三种入口 + `name/Config/inject/provide/intercept/apply` + `@Inject` 类/方法装饰器。

**Event API**：`emit/parallel/serial/bail/waterfall` + `prepend/global/once` + Context 隔离过滤。

**API 兼容验证方式**：`tests/package/` 中新增 **API surface 快照测试**——对根入口导出的每个符号名做快照，与 `docs/api.md` 逐一比对；根导出补全 `ReflectService` 缺口修复见 §5.6-G5。

### 4.2 Package Exports（每包）

```jsonc
// 通用包默认形态（kit/cordis/group/timer/loader/include/hmr/logger-console）
{
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "import": "./lib/index.js"
    },
    "./src/*": "./src/*",       // D7：P0 保留，README 标记 unstable
    "./package.json": "./package.json"
  }
}

// schemastery 双格式（D8）
{
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "import": "./lib/index.mjs",
      "require": "./lib/index.cjs"
    }
  }
}
```

仅当某包存在**已验证**的 runtime 实现差异时才增加 `"bun"`/`"node"` 条件（P0 预期仅 `hmr` 与 `logger-console` 需要，见 §5.4/§5.5）；禁止无条件双实现（PRD §9.5）。

### 4.3 CLI（P0 范围）

```bash
cordis          # 无参数：CWD 加载 ./cordis.yml（基线行为，AC-005）
```

`bin.js` 内部依赖从 `@deepseek-ai/cordis-plugin-loader/include` 改为 `@teoclub/*`；行为序列（创建 root Context → 设 baseUrl → 加载 loader → 创建 include 条目 → 读 `./cordis.yml`）不变。`run/dev/inspect/doctor/version` 属 P1，本 SPEC 不设计。

### 4.4 Error Responses（Core 异常契约）

| 异常 | 触发条件 | 兼容要求 |
|---|---|---|
| `Error` | 无效插件形态 | 保持 |
| `ValidationError` | 配置校验失败（聚合 issue + 字段路径） | 保持；错误信息中的字段路径格式不变 |
| `TypeError` | 非法 effect 返回值 | 保持 |
| `CordisError('INACTIVE_EFFECT')` | UNLOADING/DISPOSED 下创建 effect | 保持 |
| `AggregateError` | `parallel()` 监听器拒绝聚合 | 保持 |

未文档化的**错误字符串内容**不承诺逐字兼容（PRD §13.2），但异常**类型**与**抛出位置**兼容。

### 4.5 Breaking Changes（相对 @deepseek-ai/*）

| # | 变更 | 迁移路径 |
|---|---|---|
| BC-1 | 包名 scope 全面变更 | `docs/migration.md` 的 import 映射表（PRD §13.1）；codemod 属 P1，P0 提供手工映射 |
| BC-2 | 新增 `engines` 约束 | Node < 22.19 用户升级 Node |
| BC-3 | `cosmokit` → `kit` | import 替换 + 导出名不变（`@teoclub/kit` re-export 原 cosmokit 全部公共导出） |
| BC-4 | `@teoclub/cordis` 5.0.0 | major 版本声明，语义无 BC-1/2/3 之外的变更 |

---

## 5. Business Logic

### 5.1 Core Algorithms

#### 5.1.1 来源审计（Phase 0，`scripts/audit-source.ts`）

```
输入: deepseek-harness clone 路径 + pinned commit
对九个 vendor/<dir>:
  1. 读 package.json -> {name, version, dependencies, peerDependencies, exports}
  2. 与 vendor/README.md 清单比对 -> 标记版本漂移（已知: cordis 记 4.0.0-rc.7 实为 4.0.1）
  3. 扫描 src/ 中 node:* / Bun.* / require('node:...') 引用 -> Node 专属 API 清单
  4. grep @deepseek-ai / @cordisjs / cosmokit -> rescope 工作量清单
  5. License 文件确认（应为 MIT，逐一核对）
输出: docs/upstream.md（机器生成初版 + 人工补审计结论）
```

#### 5.1.2 Rescope 算法（Phase 1，`scripts/rescope.ts`）—— AST + 文本双通道

```
通道 A（AST，准确替换）:
  对每个 .ts/.mts/.cts 文件:
    - import/export 声明中的说明符（含 type-only）
    - require() / import() 的字符串字面量
    - declare module '@deepseek-ai/*' 的模块名
  映射: §13.1 映射表（含 cosmokit -> kit 特例）

通道 B（文本，兜底扫描）:
  - package.json 全字段（dependencies/peerDependencies/optionalDependencies/bin/exports）
  - 构建脚本、发布脚本、测试快照、文档、示例
  - 通道 A 完成后运行文本扫描必须命中 0 次生产引用（豁免清单除外）

豁免清单（允许出现旧 Scope 的位置）:
  docs/upstream.md、docs/migration.md、THIRD_PARTY_NOTICES.md、CHANGELOG.md 中的历史记录
```

验证：`scripts/verify-old-scopes.ts` 在 **pack 后的 tarball 解包目录**上执行（而非仅 src），模式 = `@deepseek-ai/`、`@cordisjs/`、`cosmokit`，命中即 CI fail（AC-002）。豁免通过白名单文件路径实现。

#### 5.1.3 Effect 清理（保持基线语义 + 显式测试锁定）

八条清理保证（PRD §8.4.4）全部转化为确定性测试用例（§9.4 映射表）；实现层面唯一允许的变更是修复 §5.6 缺口，不重写清理算法。

#### 5.1.4 Loader 条目更新与回滚（FR-LOADER-003）

```
update(entryId, options):
  1. 快照 { oldOptions, oldFiber?, oldPlugin? }
  2. 按差异类型分支:
     - 仅 config 变化 -> fiber.update(newConfig)（走 internal/update waterfall，可被否决）
     - name/group/inject 变化 -> 销毁旧 Fiber -> 按新 options 重建
     - disabled 变化 -> 对应销毁/重建
  3. 失败路径:
     a. fiber.update 抛出 -> 恢复旧 options；若 Fiber 已毁，重建旧 Fiber
     b. 新插件导入/装载失败 -> 恢复旧 options + 旧 Fiber；错误记录阶段字段
        （stage ∈ {import, config, apply, activate}）
  4. 不变量（回滚后断言）: 无重复 Service 注册、无残留 Listener、无残留 Effect
```

#### 5.1.5 Include Patch 语义（FR-INCLUDE-003）与原子写回（FR-INCLUDE-004）

- Patch 按序应用；后项可命中前项插入的条目（测试锁定）；name 不匹配 → skip + WARN 日志（不抛错）；输入对象深拷贝防污染；删 Patch 可恢复原值（原值保留在不可变原始输入中）。
- 写回：`tmp 文件写入 → fsync → 原子 rename`；Windows 上对 `EACCES/EBUSY/EPERM` 以指数退避重试（上限 3 次，间隔 50/150/450ms）；失败时原文件不动且抛出含阶段信息的错误。

### 5.2 Validation Rules

- 插件 `Config` 必须是**同步** Standard Schema（异步 → 启动即抛，FR-SCHEMA-004）。
- 配置解析顺序（六步，PRD §12.2）不得重排：存原始 → 等 inject → `internal/config` waterfall → 同步 Schema 校验 → 调用插件 → 更新时 `internal/update` waterfall。
- `process.env.CORDIS_SHARED`（FR-LOADER-005）：定义显式 Schema；解析失败输出可定位错误（含原始值与期望格式）；仅存在于 loader 包，不进 Core。

### 5.3 State Machine（Fiber，冻结为兼容基线）

```text
PENDING ──依赖齐全──> LOADING ──成功──> ACTIVE
                           └─失败──> UNLOADING ──> FAILED
ACTIVE ──依赖丢失/重启──> UNLOADING
                              ├─依赖缺失──> PENDING
                              └─依赖恢复──> LOADING
任意存活状态 ──dispose──> UNLOADING ──> DISPOSED
根 Fiber 特例: uid=0，dispose() = restart/清理，永不进入永久 DISPOSED
```

Conformance 必须覆盖**每条边**（含非法转换拒绝：如 DISPOSED → 任何状态）。状态枚举值字符串不变。

### 5.4 HMR 双 Engine（P0 形态，D10）

**共享层（两 runtime 同一 Config 类型与事件）**：`hmr/change`、`hmr/reload`、`hmr/config-update-failed`、配置路径注册/注销、Fiber-aware reload。

**Node Engine**：保留基线（模块依赖图、ESM/CJS cache 清理、Runtime 重建、失败回滚、框架级变化→完整重启）；Node 内部 API 封装在 `src/engine/node.ts`，README 记录支持的 Node 版本区间。

**Bun Engine（P0 = 配置刷新 + 安全重启）**：
```
检测到配置文件变化 -> include 重读/校验（FR-INCLUDE-005 错误分级）
  ├─ 成功 -> Loader 更新语义（含回滚）
  └─ 模块代码变化 / 无法安全局部重载
       -> 可控完整重启:
          1. 停止接受新 Fiber 工作
          2. root Fiber 卸载（执行全部 disposer，等待完成）
          3. 信号处理与 exporter flush
          4. process.exit + 外层 supervisor 重新拉起（bin 层实现）
```
禁止裸 `bun --hot` 替代 Fiber 清理（FR-HMR-004）。重启不变量测试：无重复 Listener/路由/Timer/Service。

### 5.5 Logger Console 双运行时（FR-LOG-001..003）

- Node：保留 `util.inspect` 实现于 Node 入口。
- Bun：优先 `node:util` 兼容层；若格式差异影响契约字段（等级/名称/错误栈/单行截断），实现 `BunFormatter` 于 Bun 入口。
- 出口契约（两 runtime 一致）：level、name、时间、Fiber 名、错误栈、单行长度上限；非 TTY / CI / 重定向环境颜色强制关闭。

### 5.6 已知缺口修复（P0 必须逐一结论，FR §8.4.8）

| # | 缺口 | 处置 | 回归测试 |
|---|---|---|---|
| G1 | `parallel()` 向 `internal/dispatch` 报告模式为 `emit` | Phase 0 审计运行时依赖方；若无依赖方区分两模式 → **修复为报告 `parallel`** 并记 Breaking-fix | 监听 `internal/dispatch` 断言 mode |
| G2 | `internal/listener` 类型声明 boolean vs 运行时 EventOptions | **修复类型声明**为 `EventOptions`（纯类型修复，无运行时变更） | typecheck 门禁 |
| G3 | Logger exporter disposer 删除错误 exporter | **修复**：disposer 捕获注册时返回的具柄（序号或对象引用）而非读取当前全局序号 | 注册多个 exporter 后乱序 dispose |
| G4 | `RegistryService.delete()` 不等待全部 Fiber 销毁 | **明确语义**：返回销毁发起不返回等待（文档化 + 类型标注）；新增 `deleteSync()`/等待语义留 P1 | 文档 + API surface 快照 |
| G5 | 核心类型与根导出不完整（`ReflectService` 不在根 barrel） | **修复**：根入口补导出 `ReflectService`（加法，非破坏） | API surface 快照更新 |

每项修复 = 独立 commit + 独立 Issue + Changelog 条目（Breaking-fix 归入 BC 清单）。

---

## 6. Error Handling

### 6.1 Error Taxonomy（运行时，保持基线 + 增强诊断）

Core 异常类型见 §4.4。P0 新增**错误上下文规范**（FR §11.4）：所有 Fiber 相关错误必须携带结构化字段 `{ pluginName, entryId, fiberUid, lifecycleStage, configPath, runtime, cause }`。实现方式：`CordisError` 与 Fiber 失败路径挂接现有 diagnostics 字段，不引入新异常类型。

### 6.2 Retry Strategy

仅两处内建重试：(a) Include 写回的 Windows 文件锁（§5.1.5）；(b) HMR 文件变化 debounce（快速连续保存合并为一次重载，见 §8.2）。其余操作不自动重试。

### 6.3 Failure Modes

| 依赖失败 | 行为 |
|---|---|
| 插件导入失败 | Fiber → FAILED；依赖它的 Fiber 保持 PENDING；`fiber.await()` 重抛 |
| 单个 disposer 失败 | 记录 + 隔离，不阻断其余清理（测试锁定） |
| 配置刷新失败 | 当前插件树继续运行（FR-INCLUDE-005） |
| HMR 局部重载失败 | 回滚旧模块；回滚也失败 → 完整重启 |
| Schema 校验失败 | Fiber 不启动，ValidationError 含全部 issue |

无未处理 Promise rejection（§14.2，lint 规则 + 运行时测试双重保障）。

---

## 7. Security

| 项 | 要求（FR §14.3） |
|---|---|
| 信任模型 | 插件 = 可信代码；README 明示无沙箱；Service 隔离是作用域机制非安全边界 |
| 动态加载 | `cordis.yml` 与插件包必须来自可信来源；文档显著位置声明 |
| 脱敏 | Logger 文档提示敏感信息脱敏；P0 不实现自动脱敏 |
| 发布完整性 | npm provenance 启用；组织 2FA；依赖审计（`bun pm audit` 或等价）进 CI |
| 供应链 | 无隐式远程代码下载；示例中 Bun auto-install 默认禁用（`bunfig.toml` 显式 `autoInstall = false`）；安装脚本最小化（无 postinstall） |
| 声明 | README 采用 PRD §17 身份声明措辞（"not affiliated with cordiverse"），发布前法务终审 |

---

## 8. Performance

### 8.1 Expected Load

库而非服务。测量对象 = 生命周期微基准（NFR-PERF-001）：Context 创建、Fiber 创建/销毁、Service resolve、Inject 触发、五类事件分发、Effect 注册+逆序清理、Loader 初始化与条目更新。

### 8.2 Optimization Strategy

- 基准以 `@deepseek-ai/cordis@4.0.1`（npm 安装）为对照基线，CI 中对比中位数退化 ≤ 10%（NFR-PERF-002）。
- 无新增 O(n²) 热路径（服务变更通知保持基线复杂度，不引入全量扫描的额外层）。
- HMR watcher debounce：合并 200ms 窗口内连续事件，任务队列有界（防无限堆积）。
- Logger buffer 上限 1,000 条不变。

### 8.3 Bundle / Dependency Considerations

- kit 零运行时依赖；cordis 运行时依赖仅 `@teoclub/kit` + `@standard-schema/spec`（类型为主）。
- chokidar 等重依赖只出现在 hmr 包；`@babel/code-frame` 只出现在 logger-console（随基线）。
- tsdown 产物 treeshaking：kit `sideEffects: false`（FR-KIT-003）。

---

## 9. Testing Strategy

### 9.1 Conformance Suite（单一代码库，双 runtime 执行）

`tests/conformance/` 结构与最低用例数：

| 套件 | 覆盖（PRD §15.2 全项） | 最少用例 |
|---|---|---|
| context | root/extend/isolate/intercept/get/set/provide/accessor/mixin | 9 组 |
| fiber | 全状态机边×每条、依赖丢失/恢复、restart、update、failed、dispose、根 Fiber 特例 | 12 组 |
| effect | sync/async disposer、Promise、iterable、async iterable、逆序、setup 回滚、重入 dispose、重复 dispose、INACTIVE_EFFECT | 10 组 |
| events | emit/parallel/serial/bail/waterfall、prepend、global、once、隔离过滤、AggregateError | 10 组 |
| registry | provide/replace/inject/epoch/Service.check/accessor 冲突/provider 自更新限制 | 8 组 |
| logger | level、buffer 上限、exporter、disposer（含 G3 回归）、Fiber metadata、错误隔离 | 6 组 |

执行方式：`vitest run` 分别在 Node 22.19/24 与 Bun Stable/Previous Stable 上跑同一目录；**结果必须全等**（允许跳过项需在 `tests/conformance/skips.ts` 显式登记原因，Bun 差异项进 `tests/bun/`）。runtime 专属行为（HMR Engine、CJS 加载差异、`node:util` inspect）在 `tests/node/` 与 `tests/bun/`。

### 9.2 Integration Tests（`tests/integration/`）

九包组合：`cordis` CLI 从 `cordis.yml` 冷启动 → 插件树装载 → 运行中条目增删改 → 更新失败回滚 → 原子写回 → dispose 全清理。双 runtime 各跑一遍。

### 9.3 Package Tests（`tests/package/`）

`npm pack` 九个 tarball → 解包断言 exports/types/engines/来源元数据/旧 Scope 零残留 → 空项目 `npm install` / `bun add` → 分别以 `node` 与 `bun` 运行最小 smoke（安装插件 → 日志输出 → dispose 无泄漏）。

### 9.4 Acceptance Criteria Mapping

| AC | 验证手段 | 类型 |
|---|---|---|
| AC-001 包完整性 | `verify-packages.ts`（九包存在/命名/README/LICENSE/types/runtime 产物） | package |
| AC-002 Scope 迁移 | `verify-old-scopes.ts` on tarballs；CJS require/declare module 定向扫描 | package |
| AC-003 Core 行为 | conformance {context,fiber,effect,events,registry,logger} | conformance |
| AC-004 Loader/Include | integration：ESM 加载、增删改、回滚、YAML/JSON、Patch、写回重试 | integration |
| AC-005 Node | CI matrix node22.19/node24：CLI 启动 + HMR Node Engine 核心用例（§15.4 子集：模块变化、回滚、CJS/ESM） | runtime |
| AC-006 Bun | CI matrix bun×2：conformance 全等 + Loader/Include/Timer/Logger + HMR 配置刷新/安全重启 | conformance+runtime |
| AC-007 发布 | tests/package 全流程 + provenance 字段存在性检查 | package |
| AC-008 声明 | 文档 lint 脚本检查关键词（不出现"沙箱"宣传/cordiverse 官方表述）+ 人工审查 Issue | docs |

### 9.5 Coverage Gates（V8）

`@teoclub/cordis` 行 ≥ 90% / 分支 ≥ 85%；kit/schemastery/loader/include/timer ≥ 85%；hmr ≥ 80%；logger-console/group ≥ 70%（薄层包）。Conformance 结果优先于覆盖率（PRD §15.5）。

---

## 10. Implementation Plan

### 10.1 Phases（对应 PRD §19，含退出条件）

**Phase 0 — 来源审计**：clone harness、pin commit、跑 `audit-source.ts`、人工复核漂移与 License。
退出：`docs/upstream.md` 初版完整，九包版本/commit/License 可验证。

**Phase 1 — Rescope 与 Monorepo**：建 workspace、复制九包、跑 `rescope.ts`、tsdown 构建通过、`verify-old-scopes.ts` 零命中、pack 验证。
退出：九包 RC 可发布且核心行为零变更（diff 审查豁免规则见 §3.4）。

**Phase 2 — Core Conformance**：写 conformance 六套件（Node 先行）、修 G1–G5、API surface 快照、API compatibility report。
退出：Node 基线全绿，行为变更全部有文档。

**Phase 3 — Bun Runtime**：Bun 跑 conformance、修公共类型（`NodeJS.Timeout` 等）、Loader/Include/Logger Bun 适配、HMR Bun Engine（D10 形态）、兼容矩阵生成。
退出：Bun conformance 与 Node 全等，未过项有降级文档。

**Phase 4 — 正式发行**：npm provenance、文档九件套、migration guide、示例、GitHub Release。
退出：AC-001…008 全勾。

### 10.2 Issue Mapping

| Issue | 内容 | SPEC 章节 | Priority | Depends On |
|---|---|---|---|---|
| #1 | Clone + pin + audit-source | §5.1.1, §3.4 | high | — |
| #2 | Monorepo 骨架 + workspace + CI 矩阵 | §2.4, §9.1 | high | #1 |
| #3 | 复制九包 + rescope 双通道 | §5.1.2 | high | #2 |
| #4 | tsdown 构建全包通过 + exports/engines | §4.2, §3.1 | high | #3 |
| #5 | verify-old-scopes / verify-packages 门禁 | §5.1.2, §9.4 | high | #4 |
| #6 | Conformance 六套件（Node） | §9.1 | high | #4 |
| #7 | 缺口修复 G1–G5（各自子 Issue） | §5.6 | high | #6 |
| #8 | Integration 套件（Loader/Include） | §9.2 | high | #6 |
| #9 | Bun conformance + 类型修复 | §9.1, §10.1-P3 | high | #6 |
| #10 | HMR Bun Engine（配置刷新+安全重启） | §5.4 | medium | #9 |
| #11 | Package tests（pack/安装/smoke） | §9.3 | high | #5 |
| #12 | 文档九件套 + 声明审查 | §7, PRD §17 | medium | #7,#9 |
| #13 | 性能基准 vs 4.0.1 | §8 | medium | #6 |
| #14 | 发布（provenance/rc→latest） | §10.1-P4 | high | #5,#7,#9,#11,#12 |

### 10.3 Incremental Delivery

- 每个 Phase 结束打 git tag（`phase-0`…`phase-4`），Phase 1 起每包可发 `rc` dist-tag。
- 发布顺序：kit → schemastery → cordis → 插件六包（依赖序，同 Release Train `cordis-v5` 标签）。
- 功能回退开关不需要（无新运行时行为）；HMR Bun 完整重启路径作为局部重载失败的固有 fallback，天然可用。

---

## 11. Open Questions & Risks

### 11.1 Unresolved Questions（Phase 0 后必须定稿，对应 PRD §23）

1. 九包各自实际 `package.json` 版本与上游 commit（Phase 0 产出后回填 §3.1）。
2. Bun Stable / Previous Stable 的具体版本号（发布时钉入 CI 与兼容矩阵）。
3. Bun Build 是否在 P1 替换 tsdown（本 SPEC D2 仅覆盖 P0）。
4. `./src/*` 导出 P1 是否收敛。
5. 独立发行身份的最终法律措辞（发布前法务终审）。
6. G1 修复（dispatch mode）是否影响 deepseek-harness 侧隐式依赖（Phase 0 审计确认）。

### 11.2 Technical Risks

| Risk | Impact | Mitigation |
|---|---|---|
| rescope 遗漏 CJS 延迟 require / 声明文件 | 运行时隐藏错误 | AST+文本双通道（§5.1.2）+ tarball 级扫描 + 真实安装测试 |
| Bun 与 Node 行为漂移 | 插件不可预测 | 单一 conformance 套件全等门禁；skips 显式登记 |
| HMR 造成 Effect 泄漏 | 重复注册 | Fiber-aware unload 不变量断言（§5.4）；回滚测试 |
| tsdown 在 Bun workspace 下的构建差异 | 产物不可用 | 构建产物与 4.0.1 结构 diff 比对作为 Phase 1 验证项 |
| 上游 vendor README 漂移导致错版迁移 | 错误基线 | 以 package.json + 源码为事实源（PRD §0.2）；审计脚本自动比对 |
| 覆盖率与 Conformance 冲突（为覆盖率改实现） | 语义回归 | Conformance 优先原则写入 CI 说明与 PR 模板 |

### 11.3 Assumptions

- `deepseek-ai/deepseek-harness` 公开仓库包含完整 `vendor/*` 九目录且与 SPEC.md 描述的 4.0.1 源码一致（Phase 0 验证；若不可克隆，回退 npm tarball 方案需重估构建配置重建成本）。
- 上游九包 License 均为 MIT 且允许重命名再发布（Phase 0 逐包核对）。
- Bun 的 `node:util`/`fs`/`path` 兼容层满足 Loader/Include/Logger-console P0 需求（Phase 3 验证）。
- Vitest 4 在 Bun Stable/Previous Stable 上可稳定运行套件（Phase 3 验证；失败回退：Bun 侧改用 `bun test --runner=vitest 兼容层` 或 Node 驱动子进程方案，届时修订 §9.1）。
- 仓库当前为空仓（仅 LICENSE/README/docs），无存量代码冲突。

---

## 附：与 PRD 的可追溯性总表

| PRD 需求 | SPEC 落点 |
|---|---|
| FR-DIST-001…005 | §2.4, §3.1, §3.3, §5.1.1, §5.1.2 |
| FR-KIT-001…004 | §2.2, §3.1, §8.3 |
| FR-SCHEMA-001…004 | §4.2（双格式 exports）, §5.2（同步校验） |
| §8.4 Context/Fiber/契约/Effect/Events/Logger/CLI/缺口 | §4.1, §5.3, §5.1.3, §5.6, §4.3 |
| FR-LOADER-001…005 | §5.1.4, §5.2（CORDIS_SHARED） |
| FR-INCLUDE-001…005 | §5.1.5, §6.3 |
| FR-GROUP/TIMER/LOG | §2.2（边界）, §4.1（API 冻结）, §5.5 |
| FR-HMR-001…004（P0 部分） | §5.4 |
| §9 双运行时 | §2.2（禁项）, §4.2, §9.1, D6 |
| §14 非功能 | §6, §7, §8 |
| §15 测试 | §9 |
| §16 构建发布 | §2.3, §10.3 |
| §20 AC-001…008 | §9.4 |
