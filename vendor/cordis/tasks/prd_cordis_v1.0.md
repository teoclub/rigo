# Cordis 产品需求文档（PRD）

> **产品名称：** Cordis  
> **产品形态：** Node.js / Bun 双运行时 TypeScript 插件框架与官方发行包族  
> **发布组织：** TEO Club  
> **npm Scope：** `@teoclub`  
> **文档版本：** v1.0  
> **文档状态：** 开发基线  
> **编制日期：** 2026-08-24  
> **兼容基线：** `@deepseek-ai/cordis` 4.0.1 与 `deepseek-harness/vendor` 完整包族  
> **核心原则：** One Core. Node.js and Bun. Everything is a plugin.

---

## 0. 文档说明

### 0.1 文档用途

本 PRD 用于指导 TEO Club 对 DeepSeek Harness `vendor` 中 Cordis 框架层进行独立接管、重命名、双运行时兼容改造、测试补全、构建发布和后续生态扩展。

本文既是产品范围说明，也是研发、测试、发布和验收的统一基线。未在本文明确纳入的能力，不作为首个正式版本的默认交付范围。

### 0.2 来源事实与产品决策的区分

本文包含两类内容：

1. **来源事实**：来自用户提供的 `SPEC.md`、DeepSeek Harness `vendor/README.md` 及相关源码；用于描述当前实现和兼容基线。
2. **产品决策**：由 TEO Club 针对新发行版作出的命名、包结构、运行时支持、测试门禁和路线规划；属于本项目的新要求。

若来源文档之间存在版本差异，以每个源码包自己的 `package.json` 与实际源码为迁移事实来源，`vendor/README.md` 仅作为上游快照和同步记录参考。

### 0.3 术语

| 术语 | 定义 |
|---|---|
| Cordis | 产品品牌，同时指插件框架整体 |
| Cordis Core | `@teoclub/cordis` 中的 Context、Fiber、Service、Effect、Events 等核心能力 |
| Distribution | 由基础库、核心包和官方插件构成的完整发布包族 |
| Runtime | JavaScript/TypeScript 执行环境，本项目首批支持 Node.js 与 Bun |
| Fiber | 一次插件装载实例及其完整生命周期 |
| Effect | 绑定到 Fiber、可逆且自动清理的资源注册 |
| Provider | 对某种通用能力的具体实现，例如 Bun SQL Provider |
| Conformance Suite | 在 Node.js 和 Bun 中重复执行、用于验证语义一致性的契约测试集 |

---

# 1. 产品摘要

## 1.1 一句话定义

> **Cordis 是一个同时支持 Node.js 与 Bun、以 Context、Fiber、Service 和 Effect 为核心的生命周期感知型 TypeScript 插件框架。**

## 1.2 产品主张

Cordis 不重复实现 HTTP、数据库、Redis、S3、哈希或进程能力；它负责管理这些能力的：

- 依赖关系；
- 作用域；
- 隔离；
- 生命周期；
- 动态替换；
- 配置更新；
- 自动清理；
- 事件组合；
- 诊断与日志。

在 Bun 环境中，可通过官方插件利用 Bun 内置服务器能力；在 Node.js 环境中，可由对应 Provider 提供同一服务契约。Cordis Core 不直接绑定 `Bun.*` 或某个 Node.js 第三方实现。

## 1.3 最终品牌结构

```text
TEO Club
└── Cordis
    ├── @teoclub/kit
    ├── @teoclub/schemastery
    ├── @teoclub/cordis
    ├── @teoclub/cordis-plugin-loader
    ├── @teoclub/cordis-plugin-include
    ├── @teoclub/cordis-plugin-group
    ├── @teoclub/cordis-plugin-timer
    ├── @teoclub/cordis-plugin-hmr
    └── @teoclub/cordis-plugin-logger-console
```

## 1.4 品牌文案

**英文定位：**

> A lifecycle-aware plugin framework for Node.js and Bun.

**中文定位：**

> 一个同时支持 Node.js 与 Bun、具备完整生命周期管理能力的 TypeScript 插件框架。

**品牌口号：**

> Cordis — The heart of composable applications.

**技术副标题：**

> One Core. Node.js and Bun. Everything is a plugin.

---

# 2. 背景与机会

## 2.1 当前基础

当前 `@deepseek-ai/cordis` 是面向 TypeScript/JavaScript 应用的插件元框架，提供：

- 基于 Context 的依赖注入；
- 服务注册、覆盖与隔离；
- Fiber 插件生命周期；
- effect/disposer 自动清理；
- 同步、并行、串行、中止与 waterfall 事件；
- Standard Schema 配置校验；
- 带 Fiber 元数据的结构化日志；
- `cordis.yml` 驱动的插件树启动。

当前核心属于基于 Proxy 的进程内内存插件容器，不包含数据库、HTTP 服务、持久化或网络协议。其价值主要是“组合与生命周期秩序”，而不是基础设施客户端本身。

DeepSeek Harness 将 Cordis 及其基础库源码内置在 `vendor` 中，以便完整拥有、审计、修补和固定框架层。该目录实际包含九个需要共同维护的正式包，而不是单独一个 Cordis Core。

## 2.2 当前问题

### P1. 发布身份不属于 TEO Club

当前包全部使用 `@deepseek-ai` Scope，不能作为 TEO Club 的长期独立产品发布和演进。

### P2. `cosmokit` 名称存在历史负担

`cosmokit` 实际承担通用 TypeScript 工具库职责；在 `@teoclub` Scope 下继续保留 `cosmo` 没有清晰产品价值。

### P3. 当前工程目标以 Node.js 为主

现有构建目标、CLI、HMR、文件系统和部分日志实现以 Node.js 为主要宿主。虽然大量 Core 代码天然可以在 Bun 运行，但缺少明确的 Bun 支持承诺、测试矩阵和运行时验收。

### P4. 核心语义测试不足

当前 Cordis 包缺少针对 Fiber、Reflect、Events、Logger 和 Effect 的完整包内单元测试，且 vendor 源码不进入覆盖率门禁。直接重构存在较高行为回归风险。

### P5. 包族文档和版本存在漂移

来源资料中已出现 Cordis 清单版本与实际 `package.json` 不一致、README 残留旧 Scope、类型声明与运行时行为不一致等问题。

### P6. Bun 的原生服务器能力尚未转化为 Cordis 能力

Bun 已提供 HTTP、SQL、Redis、S3、Hash、Shell、文件和子进程等内置 API，但当前 Cordis 没有把这些能力组织成可注入、可隔离、可替换、可清理的官方 Service Provider。

## 2.3 产品机会

通过本项目，Cordis 可以从“DeepSeek Harness 内置的 Node-targeted vendor 框架层”演进为：

- 由 TEO Club 独立维护；
- Node.js 与 Bun 共用同一套 Core；
- 包族完整、来源可追踪；
- 插件语义稳定；
- Bun 使用体验更强；
- 可作为其他插件驱动产品的通用应用内核。

---

# 3. 产品目标与非目标

## 3.1 P0 目标

### G1. 完整接管九个源码包

将 `deepseek-harness/vendor` 中全部九个包迁移到 TEO Club 的正式 monorepo，不遗漏基础库和官方插件。

### G2. 完成统一重命名

- `@deepseek-ai/cosmokit` → `@teoclub/kit`
- 其他包统一迁移到 `@teoclub/*`
- 所有源码、声明、构建配置、文档、示例和测试中的旧 Scope 必须同步替换

### G3. 保留 Cordis 核心语义

兼容基线中的 Context、Fiber、Service、Effect、Events、配置和日志行为必须保留；任何有意改变必须进入 Breaking Changes 清单。

### G4. 同一套 Core 支持 Node.js 与 Bun

`@teoclub/cordis` 只有一套公开 API、一个包名和一套行为契约，在 Node.js 与 Bun 中均可直接使用。

### G5. 建立跨运行时语义测试

同一套 Conformance Suite 必须在 Node.js 和 Bun 中执行，并验证关键状态、事件顺序、清理顺序和错误行为一致。

### G6. 建立专业发布链路

全部包必须具备：

- 正确的 `exports`；
- 类型声明；
- npm pack 验证；
- 许可证和来源说明；
- 版本策略；
- 变更日志；
- CI 发布门禁；
- 可追踪的上游基线。

## 3.2 P1 目标

- 完善 CLI：`run`、`dev`、`inspect`、`doctor`、`version`；
- 提供 `cordis.config.ts` 类型化配置；
- 为 Bun 提供生命周期感知的 HMR 实现；
- 提供插件脚手架和测试工具；
- 提供 Fiber Tree、Service Graph、Effect Tree 等诊断能力。

## 3.3 P2 目标

基于统一 Service Contract，提供 Bun 原生能力插件：

- HTTP；
- SQL / SQLite；
- Redis；
- S3-compatible Storage；
- Password / Hash；
- Process / Shell；
- File；
- Cron / Scheduler。

## 3.4 非目标

以下内容不属于首个正式版本：

- 使用 Go 重写 Cordis Core；
- 将 Cordis 改造成跨进程 RPC 插件操作系统；
- 允许任意语言成为完整的进程内 Cordis 插件；
- 插件安全沙箱；
- 多租户权限平台；
- Cordis 插件商城或商业计费；
- 重写一个新的 HTTP 框架、数据库驱动或 Redis 客户端；
- 保证与所有上游 Cordis 历史版本源码兼容；
- 直接兼容 DeepSeek Harness 所有业务包。

---

# 4. 目标用户

## 4.1 框架维护者

需要维护 Cordis Core、官方插件、双运行时兼容和发布过程。

**核心诉求：**

- 行为有测试保障；
- 能追踪上游差异；
- 包关系清晰；
- 发布可复现；
- 不被单一 Runtime 锁死。

## 4.2 插件开发者

使用 TypeScript/JavaScript 编写 Cordis 插件。

**核心诉求：**

- 同一插件可运行于 Node.js 与 Bun；
- 依赖注入和生命周期清晰；
- 热更新不泄漏资源；
- 测试简单；
- 错误信息可定位。

## 4.3 应用开发者

使用 Cordis 组合服务、插件和业务能力。

**核心诉求：**

- 安装简单；
- Node/Bun 切换成本低；
- 配置可读、可覆盖；
- 服务实现可替换；
- 插件故障不会留下残余注册。

## 4.4 Provider 开发者

为 HTTP、数据库、缓存、存储等能力提供 Node 或 Bun 实现。

**核心诉求：**

- Service Contract 稳定；
- 能注入和隔离多个实例；
- 生命周期与资源释放自动化；
- 有统一 Contract Test。

---

# 5. 产品原则

## 5.1 一个 Core，而不是两套框架

```text
@teoclub/cordis
├── Node.js 直接运行
└── Bun 直接运行
```

不得创建语义分叉的 `CordisNodeCore` 和 `CordisBunCore`。

## 5.2 Bun-first 体验不等于 Bun-only Core

Bun 可以成为官方推荐开发体验和能力最完整的 Runtime，但 Cordis Core 不能直接依赖 `Bun.*`。

## 5.3 语义稳定优先于工具替换

使用 Bun 重构的重点是开发、运行、测试、热更新和 Provider 能力，而不是为了替换工具而改变 Cordis 已有语义。

## 5.4 Core 小而稳定，能力通过插件进入

HTTP、SQL、Redis、S3、Hash 和 Shell 等能力应以 Service Provider 插件提供，不直接写入 Core。

## 5.5 所有资源必须有所有者

监听器、服务、子插件、计时器、日志 exporter、Watcher、进程和其他可释放资源，必须归属于某个 Fiber Effect。

## 5.6 来源可追踪

每个迁移包都必须记录：

- 来源仓库；
- 来源路径；
- 来源 commit；
- 来源版本；
- TEO Club 修改记录；
- License。

## 5.7 不用理论兼容代替实际测试

Bun 支持大量 Node.js API，不代表所有包自动兼容。只有进入测试矩阵且通过验收的能力，才能标记为支持。

---

# 6. 产品范围与包映射

## 6.1 完整包清单

| 来源目录 | 来源包名 | TEO Club 包名 | 主要职责 | P0 运行时目标 |
|---|---|---|---|---|
| `cosmokit/` | `@deepseek-ai/cosmokit` | `@teoclub/kit` | 通用 TypeScript 工具 | Node / Bun 通用 |
| `schemastery/` | `@deepseek-ai/schemastery` | `@teoclub/schemastery` | Schema 构建、校验与序列化 | Node / Bun 通用 |
| `cordis/` | `@deepseek-ai/cordis` | `@teoclub/cordis` | Context、Fiber、Service、Effect、Events、Logger | Node / Bun 通用 |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | `@teoclub/cordis-plugin-loader` | 插件树、动态导入、配置协调 | Node / Bun 通用，内部可适配 |
| `include/` | `@deepseek-ai/cordis-plugin-include` | `@teoclub/cordis-plugin-include` | YAML/JSON 配置读取、Patch、写回 | Node / Bun 通用 |
| `group/` | `@deepseek-ai/cordis-plugin-group` | `@teoclub/cordis-plugin-group` | 嵌套插件组 | Node / Bun 通用 |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | `@teoclub/cordis-plugin-timer` | 生命周期计时器、节流、防抖 | Node / Bun 通用 |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | `@teoclub/cordis-plugin-hmr` | 配置与模块热更新 | Node 部分重载；Bun 安全重载 |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | `@teoclub/cordis-plugin-logger-console` | 控制台日志 exporter | Node / Bun 通用，格式化可适配 |

## 6.2 不纳入 TEO Scope 的第三方依赖

以下依赖继续使用原 npm 包，不复制为 `@teoclub/*`：

- `@standard-schema/spec`
- `js-yaml`
- `chokidar`
- `picomatch`
- `@babel/code-frame`
- `supports-color`
- `node-addon-require-builtin`
- 其他经审计确认的第三方包

## 6.3 不继续保留的历史命名

不发布：

- `@teoclub/cosmokit`
- `@teoclub/cordis-core`
- `@teoclub/bun-cordis`
- `@teoclub/cordis-node-core`
- `@teoclub/cordis-bun-core`

主包固定为：

```text
@teoclub/cordis
```

---

# 7. 信息架构与依赖关系

## 7.1 目标 Monorepo

```text
cordis/
├── packages/
│   ├── kit/
│   ├── schemastery/
│   ├── cordis/
│   └── plugins/
│       ├── loader/
│       ├── include/
│       ├── group/
│       ├── timer/
│       ├── hmr/
│       └── logger-console/
│
├── tests/
│   ├── conformance/
│   ├── node/
│   ├── bun/
│   ├── integration/
│   └── package/
│
├── examples/
│   ├── basic/
│   ├── config-tree/
│   ├── hmr/
│   ├── node/
│   └── bun/
│
├── scripts/
│   ├── audit-source.ts
│   ├── rescope.ts
│   ├── verify-packages.ts
│   ├── verify-old-scopes.ts
│   └── sync-upstream.ts
│
├── docs/
│   ├── architecture.md
│   ├── compatibility.md
│   ├── migration.md
│   ├── plugin-authoring.md
│   └── upstream.md
│
├── package.json
├── bun.lock
├── bunfig.toml
├── tsconfig.json
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

## 7.2 依赖图

```mermaid
graph TD
  Kit[@teoclub/kit]
  Schema[@teoclub/schemastery]
  Cordis[@teoclub/cordis]
  Loader[@teoclub/cordis-plugin-loader]
  Include[@teoclub/cordis-plugin-include]
  Group[@teoclub/cordis-plugin-group]
  Timer[@teoclub/cordis-plugin-timer]
  HMR[@teoclub/cordis-plugin-hmr]
  Logger[@teoclub/cordis-plugin-logger-console]

  Schema --> Kit
  Cordis --> Kit
  Loader --> Cordis
  Loader --> Kit
  Include --> Cordis
  Include --> Loader
  Group --> Loader
  Timer --> Cordis
  HMR --> Cordis
  HMR --> Loader
  HMR --> Include
  HMR --> Timer
  HMR --> Schema
  Logger --> Cordis
```

## 7.3 依赖约束

1. `@teoclub/kit` 不得依赖 Cordis、Schemastery 或运行时专属能力。
2. `@teoclub/schemastery` 可依赖 Kit，不得依赖 Cordis。
3. Cordis 可依赖 Kit 和 Standard Schema 类型协议。
4. 官方插件通过 peer dependency 依赖 `@teoclub/cordis`。
5. 插件之间只在真实功能需要时建立依赖。
6. 禁止循环 package dependency。
7. 所有 workspace 依赖在发布前必须解析为正确 semver，不得把 `workspace:*` 原样泄漏进错误的 tarball。

---

# 8. 功能需求

## 8.1 Distribution 级需求

### FR-DIST-001：全量源码迁移

必须迁移九个来源目录的：

- `src/`
- `package.json`
- `README`
- `LICENSE`
- 构建配置
- 类型配置
- 必要的 CLI 入口
- 测试与 fixture
- 来源差异记录

### FR-DIST-002：Scope 全量替换

所有以下引用必须被识别和替换：

```text
@deepseek-ai/cosmokit       → @teoclub/kit
@deepseek-ai/schemastery    → @teoclub/schemastery
@deepseek-ai/cordis         → @teoclub/cordis
@deepseek-ai/cordis-plugin-* → @teoclub/cordis-plugin-*
```

检查范围必须包含：

- TypeScript import/export；
- CJS `require()`；
- 动态 import 字符串；
- `declare module`；
- `package.json`；
- `exports`；
- `peerDependencies`；
- `optionalDependencies`；
- 测试快照；
- 文档和示例；
- 生成的声明文件；
- 构建脚本和发布脚本。

### FR-DIST-003：旧 Scope 零残留门禁

发布前执行自动检查。除“来源说明”和迁移文档外，生产源码和包产物中不得残留：

```text
@deepseek-ai/
@cordisjs/
cosmokit
```

### FR-DIST-004：来源元数据

每个包必须包含可机器读取的来源信息，例如：

```json
{
  "teoclub": {
    "source": {
      "repository": "deepseek-ai/deepseek-harness",
      "path": "vendor/cordis",
      "upstreamPackage": "@deepseek-ai/cordis",
      "upstreamVersion": "4.0.1",
      "commit": "<verified-commit>"
    }
  }
}
```

### FR-DIST-005：独立修改日志

必须维护：

```text
docs/upstream.md
CHANGELOG.md
```

分别记录：

- 上游同步基线；
- TEO Club 修改；
- 行为修复；
- Breaking Changes；
- Runtime 兼容差异。

---

## 8.2 `@teoclub/kit`

### 产品定位

TEO Club 的运行时无关 TypeScript 基础工具库。

### FR-KIT-001：保留有效公共能力

迁移原 `cosmokit` 中被 Cordis、Schemastery 和官方插件实际使用的：

- 数组工具；
- 对象工具；
- 字符串转换；
- 属性定义；
- 类型守卫；
- 深比较；
- 空值判断；
- 时间和通用类型工具。

### FR-KIT-002：Runtime-neutral

不得直接依赖：

- `node:*`
- `Bun.*`
- 文件系统；
- 网络；
- 进程；
- Cordis Context。

### FR-KIT-003：Tree-shaking

包必须声明：

```json
{
  "sideEffects": false
}
```

除非某个导出被证明存在必要初始化副作用；若存在，必须通过精确文件列表声明。

### FR-KIT-004：清晰子路径

首版允许单入口；当体积或导出冲突达到阈值后，可提供：

```text
@teoclub/kit/array
@teoclub/kit/object
@teoclub/kit/string
@teoclub/kit/time
@teoclub/kit/types
```

不得为了形式拆出空洞小包。

---

## 8.3 `@teoclub/schemastery`

### 产品定位

用于插件配置与通用类型模型的 Schema 构建、校验、转换和序列化工具。

### FR-SCHEMA-001：保留 Schema API

必须保留来源版本中被 Cordis 和官方插件使用的：

- object；
- union；
- intersect；
- transform；
- default；
- role；
- simplify；
- 扩展 Schema 类型；
- Schema 序列化能力。

### FR-SCHEMA-002：替换 Kit 依赖

所有 ESM 和 CJS 路径都必须改为 `@teoclub/kit`，特别检查延迟 `require()`。

### FR-SCHEMA-003：双模块兼容

若继续发布 ESM 和 CJS，必须通过显式 `exports` 区分：

```json
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

Node 与 Bun 中不得出现同一包被重复实例化导致的类型注册或单例问题。

### FR-SCHEMA-004：同步校验兼容

Cordis Core 的 P0 配置流程继续要求同步 Standard Schema；异步 Schema 不纳入 P0。

---

## 8.4 `@teoclub/cordis`

### 8.4.1 Context

必须保留以下能力：

| API | 需求 |
|---|---|
| `new Context()` | 创建根容器并安装内建服务 |
| `Context.is()` | 跨包实例识别 Cordis Context |
| `ctx.extend()` | 创建继承父 Context 的子作用域 |
| `ctx.isolate()` | 创建或加入服务隔离作用域 |
| `ctx.intercept()` | 为消费服务追加拦截配置 |
| `ctx.get()` | 显式获取服务 |
| `ctx.set()` | 服务提供者更新自己的服务值 |
| `ctx.provide()` | 注册生命周期绑定服务 |
| `ctx.accessor()` | 注册自定义 Context 访问器 |
| `ctx.mixin()` | 将 Service 成员暴露到 Context |
| `ctx.plugin()` | 装载插件并创建 Fiber |
| `ctx.inject()` | 依赖就绪后执行插件 |
| `ctx.effect()` | 注册自动清理副作用 |
| `ctx.on()/once()` | 注册生命周期绑定事件监听器 |
| `ctx.logger()` | 创建命名 Logger |

### 8.4.2 Fiber 生命周期

必须实现并测试以下状态转换：

```text
PENDING ──依赖齐全──> LOADING ──成功──> ACTIVE
                           └─失败──> UNLOADING ──> FAILED

ACTIVE ──依赖丢失/重启──> UNLOADING
                              ├─依赖缺失──> PENDING
                              └─依赖恢复──> LOADING

任意存活状态 ──dispose──> UNLOADING ──> DISPOSED
```

必须保留根 Fiber 特殊行为，并明确记录：

- 根 Fiber `uid = 0`；
- 根 Fiber `dispose()` 执行重启/清理流程；
- 普通 Fiber 可永久进入 `DISPOSED`。

### 8.4.3 插件契约

继续支持三种入口：

```ts
(ctx, config) => effect
new PluginClass(ctx, config)
{ apply(ctx, config), inject?, Config?, provide?, intercept?, name? }
```

必须保留：

- `name`；
- `Config`；
- `inject`；
- `provide`；
- `intercept`；
- `apply`；
- `@Inject` 类和方法装饰器语义。

### 8.4.4 Effect 契约

插件或 `ctx.effect()` 返回值必须支持：

- 单个 disposer；
- 空值；
- Promise；
- 同步 iterable；
- 异步 iterable。

清理必须保证：

1. disposer 至多执行一次；
2. 同一 Fiber 内按逆注册顺序清理；
3. Fiber 卸载等待异步清理完成；
4. setup 失败回滚已登记资源；
5. setup 与卸载重入时行为确定；
6. `UNLOADING` 和 `DISPOSED` 状态禁止创建新 effect；
7. 单个清理失败不得阻止其余清理；
8. 清理错误必须可诊断。

### 8.4.5 Events

必须保留：

| 模式 | 语义 |
|---|---|
| `emit` | 同步调用全部监听器，不等待 Promise |
| `parallel` | 并行等待并聚合异常 |
| `serial` | 顺序等待，遇 bail 值停止 |
| `bail` | 同步顺序调用，遇 bail 值停止 |
| `waterfall` | 监听器包裹 `next()`，可委托、替换或短路 |

必须保留：

- `prepend`；
- `global`；
- `once()`；
- Context 隔离过滤；
- waterfall 返回值传播。

### 8.4.6 Logger

必须保留：

- ERROR / INFO / WARN / DEBUG；
- 命名 Logger；
- Fiber 元数据；
- exporter；
- 默认内存 buffer；
- 最大记录数；
- 格式化能力；
- 清理隔离。

Core 不直接输出控制台，控制台行为仍由 `logger-console` 插件提供。

### 8.4.7 CLI 兼容

P0 保留：

```bash
cordis
```

默认行为继续支持从当前工作目录加载 `cordis.yml`。

P1 增加：

```bash
cordis run [config]
cordis dev [config]
cordis inspect
cordis doctor
cordis version
```

### 8.4.8 已知缺口修复

P0 必须评估并修复或明确保留：

1. `parallel()` 向内部 dispatch 报告错误模式；
2. `internal/listener` 类型声明与运行时 `EventOptions` 不一致；
3. Logger exporter disposer 可能删除错误 exporter；
4. `RegistryService.delete()` 销毁等待语义不明确；
5. 核心类型与根导出不完整或不一致。

任何修复都必须有回归测试和 Changelog。

---

## 8.5 `@teoclub/cordis-plugin-loader`

### 产品定位

管理配置化插件条目树、动态导入、依赖等待、运行时更新、替换与回滚。

### FR-LOADER-001：EntryTree

必须支持：

- 稳定 Entry ID；
- 插件模块名；
- 插件 config；
- group；
- disabled；
- inject；
- 嵌套树；
- Entry 定位；
- 条目遍历。

### FR-LOADER-002：动态导入

必须支持：

- npm 包名；
- 相对路径；
- file URL；
- ESM；
- 在可支持范围内处理 CJS/default export；
- Node 与 Bun 的模块解析差异。

### FR-LOADER-003：安全更新与回滚

条目更新必须区分：

- 只更新 config；
- 更新 inject；
- 更新插件 name；
- group 变化；
- disabled 变化。

更新失败时必须：

- 恢复旧 options；
- 恢复旧 Fiber 或旧插件；
- 保留可诊断错误阶段；
- 不留下重复 Service、Listener 或 Effect。

### FR-LOADER-004：运行时能力隔离

Node 内部 ModuleLoader 访问不得成为 Loader 的公开强制依赖。需要内部模块图时，通过可选能力或 HMR Engine 使用。

### FR-LOADER-005：共享环境数据

现有 `process.env.CORDIS_SHARED` 行为需要：

- 明确 Schema；
- 解析失败提示；
- 在 Bun 中通过兼容环境变量运行；
- 不进入 Cordis Core。

---

## 8.6 `@teoclub/cordis-plugin-include`

### 产品定位

将 YAML/JSON 文件转换为 Loader EntryTree，并支持 Patch、热刷新和可靠写回。

### FR-INCLUDE-001：文件格式

P0 支持：

- `.json`
- `.yaml`
- `.yml`

### FR-INCLUDE-002：YAML 方言

继续支持当前 Entry List 所需的 `!!js` 表达式节点和可逆序列化。

### FR-INCLUDE-003：Patch 语义

必须保证：

- Patch 按顺序应用；
- 可修改指定 ID；
- 可向根或 Group 插入条目；
- 同一 Patch 列表后续项可以命中前面新插入的条目；
- name 不匹配时跳过并警告；
- 原始输入不被原地污染；
- 删除 Patch 后可以恢复原始值。

### FR-INCLUDE-004：可靠写回

必须支持：

- 临时文件写入；
- 原子 rename；
- Windows 常见 EACCES / EBUSY / EPERM 重试；
- 格式保持在合理范围内；
- 失败时不破坏原配置文件。

### FR-INCLUDE-005：配置刷新

配置文件变化后：

- 读取、解析、校验、应用阶段错误要区分；
- 失败不得摧毁当前可运行插件树；
- 成功后按 Loader 更新语义应用；
- 支持 HMR 注册精确配置路径。

---

## 8.7 `@teoclub/cordis-plugin-group`

### 产品定位

提供 Loader 的嵌套插件组入口。

### FR-GROUP-001：保持轻量

该包只承担稳定命名和默认导出，不复制 Loader Group 实现。

### FR-GROUP-002：配置兼容

Group 配置必须保持文字值，不应错误地在 Group 载体层提前执行属于子 Entry 的表达式转换。

---

## 8.8 `@teoclub/cordis-plugin-timer`

### 产品定位

为 Context 提供与 Fiber 生命周期绑定的计时器、节流和防抖能力。

### FR-TIMER-001：公共能力

必须提供：

```text
ctx.timeout()
ctx.interval()
ctx.throttle()
ctx.debounce()
ctx.setTimeout()      // 兼容别名，可标记 deprecated
ctx.setInterval()     // 兼容别名，可标记 deprecated
ctx.timer
```

### FR-TIMER-002：生命周期绑定

- Timer 创建时自动登记 Effect；
- Fiber dispose 时清理 Timer；
- Promise 形式 timeout 在 Context 销毁时必须拒绝；
- AsyncIterator 形式 interval 在销毁时必须结束或抛出明确错误；
- throttle/debounce 返回值必须提供 `dispose()`。

### FR-TIMER-003：运行时中立类型

不得在公共类型中暴露 `NodeJS.Timeout`。应优先使用：

```ts
ReturnType<typeof setTimeout>
```

保证 Node 和 Bun 类型一致。

---

## 8.9 `@teoclub/cordis-plugin-hmr`

### 产品定位

监听配置和插件模块变化，以 Cordis Fiber 生命周期为边界执行安全重载。

### FR-HMR-001：公共 API 一致

Node 与 Bun 共享：

- 同一个包名；
- 同一个 Config 类型；
- `hmr/change`；
- `hmr/reload`；
- `hmr/config-update-failed`；
- 配置路径注册和注销能力；
- Fiber-aware reload 语义。

### FR-HMR-002：Node Engine

Node 环境应保留并加固：

- 模块依赖图；
- ESM cache 清理；
- CJS cache 清理；
- Plugin Runtime 重建；
- 失败回滚；
- 框架级变化触发完整重启。

Node 内部 API 必须封装在 Node Engine 中，并记录支持的 Node 版本。

### FR-HMR-003：Bun Engine

Bun 环境不得直接复用 Node 内部 ModuleLoader 实现。

P0 最低要求：

- 配置文件热刷新；
- 文件变化检测；
- 触发 Cordis 生命周期清理；
- 无法安全局部重载时执行可控的完整进程重启；
- 重启前等待 disposer 和信号处理；
- 不产生重复监听器、路由、Timer 和 Service。

P1 目标：

- Bun 模块图感知；
- 插件级局部重载；
- 失败回滚；
- 保留未受影响 Fiber；
- 与 Node Engine 共享验收语义。

### FR-HMR-004：禁止裸用 Runtime 热更新替代 Fiber 清理

不得仅依赖 `bun --hot` 重新执行模块而绕过 Cordis Fiber 卸载。任何热更新都必须先完成：

```text
停止旧 Fiber 接受新工作
→ 执行 disposer
→ 注销 Service / Listener / Timer
→ 导入新模块
→ 创建新 Fiber
→ 等待依赖与激活
→ 失败时回滚或完整重启
```

---

## 8.10 `@teoclub/cordis-plugin-logger-console`

### 产品定位

将 Cordis 结构化日志输出到终端。

### FR-LOG-001：统一配置

Node 与 Bun 共享：

- 日志级别；
- 颜色等级；
- 时间显示；
- Fiber 名；
- 对象格式化；
- 单行限制；
- exporter 生命周期。

### FR-LOG-002：格式化差异封装

当前 Node `util.inspect` 实现可保留在 Node 入口；Bun 可：

1. 使用其 Node 兼容 `node:util`；或
2. 提供 Bun Formatter。

对外输出契约一致，不要求每个字符完全相同，但关键字段、等级和错误栈必须一致。

### FR-LOG-003：颜色检测

颜色检测不得在非 TTY 环境强制输出 ANSI；CI、文件重定向和 JSON 输出模式必须可关闭颜色。

---

# 9. Node.js / Bun 双运行时要求

## 9.1 支持模型

```text
同一个 npm 包
同一套 TypeScript 类型
同一套插件 API
同一套状态机和 Effect 语义
不同 Runtime 可使用不同内部实现
```

## 9.2 Core 禁止项

`@teoclub/cordis` Core 源码原则上不得直接使用：

```text
Bun.*
bun:*
node:fs
node:path
node:http
node:child_process
node:worker_threads
```

若某段功能确实属于 CLI 或宿主入口，应从 Core 模块边界隔离。

## 9.3 Runtime 检测规则

不允许在 Core 大量散布：

```ts
if (typeof Bun !== 'undefined') {
  // ...
}
```

优先顺序：

1. 使用标准 ECMAScript / Web API；
2. 使用 Node 与 Bun 都兼容的 API；
3. 通过局部 Engine / Adapter 隔离真实差异；
4. 仅在包入口或能力选择层做显式 Runtime 判断。

## 9.4 首批支持版本

建议发布基线：

- Node.js：`^22.19.0 || >=24.0.0`
- Bun：当前 Stable 与前一 Stable
- TypeScript：与发布构建验证版本一致

最终精确版本由发布时 CI 验证结果写入 `engines` 和兼容矩阵，不得只从宿主仓库间接推断。

## 9.5 包导出

通用包优先：

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

仅在真实需要时增加：

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "bun": "./dist/bun.js",
      "node": "./dist/node.js",
      "import": "./dist/index.js"
    }
  }
}
```

不得因为存在 Bun 就为每个包无条件生成双实现。

## 9.6 源码导出

当前兼容基线允许 `./src/*`。P0 默认继续保留，以降低迁移破坏；同时：

- 标记为高级/不稳定入口；
- 不承诺跨大版本稳定；
- 所有正式公共 API 应从根入口导出；
- P1 评估是否逐步收敛源码导出。

---

# 10. Bun 原生能力扩展路线

## 10.1 原则

> Bun 提供运行时原语，Cordis 提供组合、依赖、作用域和生命周期。

Bun 原生能力不得直接塞进 Core，应作为官方 Provider 插件进入。

## 10.2 规划包

| 能力 | 建议包 | Bun 实现 | Node 实现 |
|---|---|---|---|
| HTTP | `@teoclub/cordis-plugin-http` | `Bun.serve` | Node HTTP Provider |
| SQL | `@teoclub/cordis-plugin-sql` | Bun SQL | PostgreSQL/MySQL Provider |
| SQLite | `@teoclub/cordis-plugin-sqlite` | `bun:sqlite` | Node SQLite Provider |
| Cache | `@teoclub/cordis-plugin-cache` | Bun Redis | node-redis 或其他 Provider |
| Storage | `@teoclub/cordis-plugin-storage` | Bun S3 | AWS SDK / MinIO Provider |
| Password | `@teoclub/cordis-plugin-password` | `Bun.password` | Node 安全哈希 Provider |
| Process | `@teoclub/cordis-plugin-process` | `Bun.spawn` / Shell | `node:child_process` |
| File | `@teoclub/cordis-plugin-file` | Bun File API | Node FS Provider |

## 10.3 Service Contract 优先

业务插件依赖：

```text
database
cache
storage
password
process
http
```

不得直接依赖：

```text
Bun.SQL
Bun.redis
Bun.s3
Bun.password
Bun.spawn
```

## 10.4 多实例和隔离

所有 Provider 必须支持：

- 命名实例；
- Context 隔离；
- 测试替换；
- Fiber 自动清理；
- 健康检查；
- 配置验证；
- Secret 不进入普通日志。

---

# 11. 开发者体验

## 11.1 安装

### Bun

```bash
bun add @teoclub/cordis
```

### Node.js

```bash
npm install @teoclub/cordis
```

## 11.2 同一份应用代码

```ts
import { Context } from '@teoclub/cordis'

const ctx = new Context()

ctx.plugin(function hello(ctx) {
  const logger = ctx.logger('hello')
  logger.info('Cordis started')

  return () => logger.info('Cordis stopped')
})
```

Node.js：

```bash
node dist/app.js
```

Bun：

```bash
bun app.ts
```

## 11.3 配置启动

P0：

```yaml
# cordis.yml
- id: logger
  name: '@teoclub/cordis-plugin-logger-console'

- id: timer
  name: '@teoclub/cordis-plugin-timer'
```

```bash
cordis
```

## 11.4 错误信息

所有插件错误至少包含：

- 插件名；
- Entry ID；
- Fiber UID；
- 生命周期阶段；
- 配置路径；
- Runtime；
- 原始 cause；
- 可操作修复建议（适用时）。

---

# 12. 配置需求

## 12.1 P0 配置格式

继续支持 `cordis.yml`，并由 Loader + Include 加载。

## 12.2 配置解析顺序

保持：

1. 保存原始 config；
2. 等待 inject 服务；
3. 执行 `internal/config` waterfall；
4. 执行同步 Schema 校验；
5. 调用插件；
6. 更新时执行 `internal/update` waterfall。

## 12.3 类型化配置

P1 增加：

```ts
// cordis.config.ts
import { defineConfig } from '@teoclub/cordis'

export default defineConfig({
  plugins: [
    ['@teoclub/cordis-plugin-timer'],
    ['@teoclub/cordis-plugin-logger-console', { level: 2 }],
  ],
})
```

类型化配置不得取代 YAML，而是作为并列入口。

## 12.4 环境变量

Core 不主动读取业务环境变量。环境变量读取属于 Loader、配置插件或具体 Provider 的职责。

---

# 13. 兼容与迁移

## 13.1 Import 映射

```text
@deepseek-ai/cosmokit
→ @teoclub/kit

@deepseek-ai/schemastery
→ @teoclub/schemastery

@deepseek-ai/cordis
→ @teoclub/cordis

@deepseek-ai/cordis-plugin-loader
→ @teoclub/cordis-plugin-loader

@deepseek-ai/cordis-plugin-include
→ @teoclub/cordis-plugin-include

@deepseek-ai/cordis-plugin-group
→ @teoclub/cordis-plugin-group

@deepseek-ai/cordis-plugin-timer
→ @teoclub/cordis-plugin-timer

@deepseek-ai/cordis-plugin-hmr
→ @teoclub/cordis-plugin-hmr

@deepseek-ai/cordis-plugin-logger-console
→ @teoclub/cordis-plugin-logger-console
```

## 13.2 兼容目标

### 源码兼容

除 Scope、明确修复和运行时适配外，现有 `@deepseek-ai/cordis` 插件应尽量通过替换 import 后运行。

### 行为兼容

以下必须保持：

- Fiber 状态转换；
- Inject 等待；
- Service 解析；
- Context 隔离；
- Event 顺序；
- Effect 清理；
- Config waterfall；
- Plugin 三种入口；
- Loader Entry 更新和回滚。

### 不承诺兼容

- 未公开内部字段；
- Node 内部 ModuleLoader 私有结构；
- 未经文档化的错误字符串；
- 已确认缺陷；
- DeepSeek Harness 私有宿主钩子。

## 13.3 Codemod

P1 提供：

```bash
bunx @teoclub/cordis-codemod rescope ./src
```

至少支持：

- import/export；
- require；
- declare module；
- package.json dependency；
- YAML 插件名。

---

# 14. 非功能需求

## 14.1 性能

### NFR-PERF-001

Core 基准测试相对兼容基线不得出现无法解释的显著退化。

重点测量：

- 创建 Context；
- 创建/销毁 Fiber；
- Service resolve；
- Inject 触发；
- emit/parallel/serial/waterfall；
- Effect 注册和逆序清理；
- Loader 初始化与条目更新。

### NFR-PERF-002

P0 建议门槛：

- 常见生命周期微基准中位数退化不超过 10%；
- 无新增 O(n²) 热路径；
- 日志 buffer 仍有固定上限；
- HMR 文件变化不会无限堆积任务。

## 14.2 可靠性

- 所有 dispose 操作幂等；
- 更新失败可回滚；
- 配置刷新失败不破坏当前运行树；
- 单个清理错误不阻断其他清理；
- HMR 失败后系统保持旧版本或执行明确完整重启；
- 无未处理 Promise rejection。

## 14.3 安全

Cordis 插件仍被视为可信代码。P0 不提供安全沙箱。

必须做到：

- README 明确安全边界；
- 动态加载配置必须来自可信来源；
- Logger 文档提示敏感信息脱敏；
- 发布启用 npm provenance；
- 依赖审计；
- 无隐式远程代码下载；
- Bun auto-install 在生产示例中默认禁用；
- 安装脚本最小化。

## 14.4 可维护性

- 每个包必须有 README；
- 每个公共 API 必须有类型与基本文档；
- 运行时差异集中管理；
- 不允许复制两套大规模 Core 实现；
- 所有上游同步差异可枚举。

## 14.5 包体积

- Core 不引入服务器基础设施大依赖；
- Kit 保持零或极少运行时依赖；
- HMR 重依赖只存在于 HMR 包；
- Provider 能力按需安装。

---

# 15. 测试策略

## 15.1 测试分层

| 层级 | 目标 |
|---|---|
| Unit | 单模块和边界行为 |
| Conformance | Node/Bun 同语义 |
| Integration | 九包组合工作 |
| Runtime | Node 和 Bun 特有行为 |
| Package | npm pack 后真实安装 |
| Migration | 旧 import 和旧配置迁移 |
| Performance | 生命周期与事件基准 |

## 15.2 Core Conformance Suite

至少覆盖：

### Context

- root；
- extend；
- isolate；
- intercept；
- get/set/provide；
- accessor；
- mixin。

### Fiber

- pending → loading → active；
- 依赖丢失；
- 依赖恢复；
- restart；
- update；
- failed；
- dispose；
- 根 Fiber。

### Effect

- sync disposer；
- async disposer；
- Promise；
- iterable；
- async iterable；
- 逆序；
- setup rollback；
- reentrant dispose；
- duplicate dispose。

### Events

- emit；
- parallel；
- serial；
- bail；
- waterfall；
- prepend；
- global；
- once；
- 隔离过滤。

### Registry / Reflect

- provide；
- replace；
- inject；
- epoch；
- Service.check；
- accessor 冲突；
- provider 自更新限制。

### Logger

- level；
- buffer 上限；
- exporter；
- disposer；
- Fiber metadata；
- 错误隔离。

## 15.3 Runtime 矩阵

```text
Node.js 22.19+
Node.js 24+
Bun Stable
Bun Previous Stable
```

## 15.4 HMR 专项测试

- 单插件文件变化；
- 插件依赖文件变化；
- 框架文件变化；
- CJS 插件；
- ESM 插件；
- 配置文件变化；
- 配置解析失败；
- 新插件导入失败；
- disposer 失败；
- 回滚成功；
- 回滚失败；
- 连续快速保存；
- unlink/add；
- Windows 文件锁；
- Bun 安全完整重启。

## 15.5 覆盖率门槛

P0 建议：

- `@teoclub/cordis` 行覆盖率 ≥ 90%；
- 分支覆盖率 ≥ 85%；
- Kit / Schemastery / Loader / Include / Timer ≥ 85%；
- HMR 核心状态逻辑 ≥ 80%；
- 所有已知缺口必须有回归测试。

覆盖率不作为替代验收，Conformance 结果优先。

---

# 16. 构建与发布

## 16.1 工具链

建议：

- 包管理与 workspace：Bun；
- 主开发 Runtime：Bun；
- Node 兼容测试：Node.js；
- 类型检查与声明：TypeScript `tsc`；
- 运行时代码构建：Bun Build 或经验证的 ESM 构建器；
- 静态检查：Oxlint / ESLint 二选一并固定；
- 版本与 Changelog：Changesets 或等价工具。

Bun-first 工具链不影响最终包在 Node 中运行。

## 16.2 Build 产物

每个包至少发布：

- ESM runtime；
- `.d.ts`；
- README；
- LICENSE；
- package.json；
- 必要的 source map；
- 兼容要求中的 `src/`。

## 16.3 发布验证

每个包发布前必须：

1. build；
2. typecheck；
3. lint；
4. Node test；
5. Bun test；
6. npm pack；
7. 解压 tarball；
8. 检查 exports；
9. 检查类型入口；
10. 检查旧 Scope；
11. 在空项目安装；
12. 执行 Node/Bun smoke test。

## 16.4 版本策略

- 包使用独立 SemVer；
- `@teoclub/cordis` 首个正式双运行时大版本建议为 `5.0.0`；
- 其他包版本基于实际 API 变化单独决定；
- Distribution 可使用统一 Release Train 标签，但不强制所有包版本相同；
- Breaking Change 必须有迁移说明。

## 16.5 发布身份

- npm 包由 `@teoclub` 组织发布；
- GitHub 仓库为 `teoclub/cordis`；
- 使用组织 2FA；
- 启用 npm provenance；
- Release tag 与 Changelog 对齐。

---

# 17. 文档需求

P0 必须交付：

1. `README.md`：定位、安装、最小示例；
2. `docs/architecture.md`：Context、Fiber、Service、Effect；
3. `docs/compatibility.md`：Node/Bun 支持矩阵；
4. `docs/migration.md`：从 `@deepseek-ai/*` 迁移；
5. `docs/plugin-authoring.md`：插件契约和生命周期；
6. `docs/configuration.md`：Loader、Include、Patch；
7. `docs/hmr.md`：Node/Bun HMR 差异；
8. `docs/upstream.md`：来源和修改；
9. 每个包独立 README；
10. API reference。

文档不得把 TEO Club 版本描述为 `cordiverse` 官方版本。

建议身份声明：

> Cordis by TEO Club is an independent Node.js and Bun-compatible distribution based on the Cordis framework layer used by DeepSeek Harness. It is not affiliated with the cordiverse organization.

最终法律和品牌表述需在发布前确认。

---

# 18. 成功指标

## 18.1 发布质量

- 9/9 包可独立 build 和 pack；
- 9/9 包使用正确 `@teoclub` 名称；
- 生产产物旧 Scope 残留为 0；
- 所有包 License 与来源信息完整；
- Node/Bun smoke test 通过率 100%。

## 18.2 兼容质量

- Core Conformance 在 Node 与 Bun 全部通过；
- 已确认兼容基线行为无未记录回归；
- P0 已知缺口全部有结论；
- HMR 不产生可复现的资源重复注册。

## 18.3 开发者体验

- 新用户可在一个最小示例中完成安装、装载插件、查看日志和 dispose；
- Node 与 Bun 示例代码主体一致；
- 迁移主要工作可通过 import 替换和配置包名替换完成；
- 错误能定位到插件、Entry、Fiber 和阶段。

## 18.4 维护质量

- 上游同步可重复；
- 每个本地差异有记录；
- 每次发布自动生成兼容矩阵；
- 包依赖图无循环；
- 无未声明运行时依赖。

---

# 19. 阶段规划与退出条件

## Phase 0：来源审计

**交付：**

- 九包源码清单；
- 每包真实版本；
- 上游 commit；
- License；
- 依赖图；
- Node 专属 API 清单；
- Bun 兼容风险清单。

**退出条件：**

所有来源信息可验证，README 清单漂移已被标记。

## Phase 1：Rescope 与 Monorepo 建立

**交付：**

- `@teoclub` 九包；
- `cosmokit` → `kit`；
- 构建通过；
- 旧 Scope 检查；
- pack 验证。

**退出条件：**

九包在不改变核心行为的前提下可发布 RC。

## Phase 2：Core Conformance

**交付：**

- Context、Fiber、Effect、Events、Registry、Logger 测试；
- 已知缺口修复；
- API compatibility report。

**退出条件：**

Node 基线完全通过，行为变更均有文档。

## Phase 3：Bun Runtime 支持

**交付：**

- 九包 Bun smoke；
- 公共类型修复；
- Loader / Include / Logger 兼容；
- HMR Bun 安全重载；
- Bun 兼容矩阵。

**退出条件：**

同一 Core Conformance 在 Bun 通过，未通过项有明确降级和文档。

## Phase 4：正式发行

**交付：**

- npm 正式包；
- GitHub Release；
- 完整文档；
- Migration Guide；
- 示例；
- npm provenance。

**退出条件：**

满足本 PRD 第 20 节全部 P0 验收标准。

## Phase 5：Bun 能力插件

**交付：**

- Service Contract；
- Bun Provider；
- Node Provider 或明确仅 Bun 能力；
- Contract Tests；
- 资源生命周期测试。

---

# 20. P0 验收标准

## AC-001：包完整性

- [ ] 九个目标包全部存在。
- [ ] 每个包名称与本 PRD 一致。
- [ ] 每个包都有 README、LICENSE、types 和可执行 runtime 产物。

## AC-002：Scope 迁移

- [ ] `@deepseek-ai/*` 生产引用为 0。
- [ ] `@cordisjs/*` 生产引用为 0。
- [ ] `cosmokit` 生产引用为 0。
- [ ] CJS 延迟 require 已检查。
- [ ] `declare module` 已检查。

## AC-003：Core 行为

- [ ] Context API 通过。
- [ ] Fiber 全状态机通过。
- [ ] Inject 服务变化通过。
- [ ] Effect 所有形式和逆序清理通过。
- [ ] 五种 Event 模式通过。
- [ ] Logger exporter 生命周期通过。

## AC-004：Loader / Include

- [ ] ESM 插件加载通过。
- [ ] 条目增删改、disabled、inject 更新通过。
- [ ] 更新失败回滚通过。
- [ ] YAML/JSON 读取通过。
- [ ] Patch 插入和覆盖通过。
- [ ] 原子写回和重试通过。

## AC-005：Node.js

- [ ] Node 22.19+ CI 通过。
- [ ] Node 24+ CI 通过。
- [ ] CLI 启动通过。
- [ ] HMR Node Engine 通过核心用例。

## AC-006：Bun

- [ ] Bun Stable CI 通过。
- [ ] Bun Previous Stable CI 通过。
- [ ] Core Conformance 与 Node 一致。
- [ ] Loader / Include / Timer / Logger 通过。
- [ ] HMR 至少支持配置刷新和安全完整重启。

## AC-007：发布

- [ ] 所有 npm pack 内容正确。
- [ ] 空 Node 项目安装和运行通过。
- [ ] 空 Bun 项目安装和运行通过。
- [ ] npm provenance 可用。
- [ ] Changelog、Migration、Upstream 记录完整。

## AC-008：安全与声明

- [ ] README 明确插件为可信代码。
- [ ] 不宣传安全沙箱。
- [ ] 不误导为 cordiverse 官方发行。
- [ ] 第三方 License 和 Notices 完整。

---

# 21. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Cordis 名称与现有上游项目混淆 | 品牌、社区和法律风险 | 明确 TEO Club 独立发行身份，保留来源与 License，发布前审查命名表述 |
| README 清单版本与源码不一致 | 错误迁移版本 | 以 package.json 和源码为事实源，自动生成来源清单 |
| Bun 对 Node 私有 API不兼容 | HMR 和 Loader 失败 | 将私有 API 隔离到 Node Engine；Bun 使用独立安全重载路径 |
| 两个 Runtime 行为漂移 | 插件不可预测 | 单一 Conformance Suite；禁止两套 Core |
| HMR 造成 Effect 泄漏 | 重复 Listener、Service、Timer | Fiber-aware unload；资源树测试；失败回滚 |
| `kit` 变成杂物包 | 依赖膨胀、边界混乱 | 严格无 I/O、无 Cordis 依赖、无 Runtime API 原则 |
| Scope 批量替换遗漏 CJS/声明 | 运行时隐藏错误 | AST + 文本双检查；pack 后扫描；真实安装测试 |
| 过早开发大量 Bun Provider | 分散 Core 迁移资源 | 先完成 Distribution 与 Conformance，再进入 Provider 阶段 |
| Bun 升级同时影响多种内置 API | Provider 行为连锁变化 | Cordis Service Contract 作为稳定层；Bun 版本矩阵；Contract Test |
| 动态插件加载安全风险 | 执行不可信代码 | 文档声明可信边界；生产禁用隐式 auto-install；后续独立安全项目 |

---

# 22. 已确认决策

1. 产品品牌使用 **Cordis**。
2. 不使用 **Cordiverse** 作为 TEO Club 品牌或 Scope。
3. npm Scope 使用 **`@teoclub`**。
4. `cosmokit` 正式改名为 **`@teoclub/kit`**。
5. `deepseek-harness/vendor` 中九个包全部纳入，不只迁移 Core。
6. Cordis Core 使用 TypeScript 实现。
7. Cordis Core 同时支持 Node.js 和 Bun。
8. 不使用 Go 重写 Core。
9. Bun 原生能力通过插件和 Provider 增强 Cordis，不污染 Core。
10. HMR 必须尊重 Fiber 生命周期，不能用裸 Runtime 热更新替代资源清理。

---

# 23. 待工程审计后定稿的事项

以下事项不阻塞 PRD，但必须在 Phase 0 后写入技术设计：

1. 九个包各自实际 `package.json` 版本与来源 commit；
2. `@teoclub/cordis` 首发精确版本；
3. 是否继续发布 Schemastery CJS；
4. HMR Bun Engine 的首版实现策略；
5. Core `./src/*` 导出的长期去留；
6. Bun Build 与现有 tsdown 的最终取舍；
7. Node 最低版本是否继续固定为 22.19；
8. Bun Stable / Previous Stable 的具体版本号；
9. 独立发行身份的最终法律措辞。

默认决策为：在没有足够证据改变前，优先保留兼容、显式记录差异、使用最小必要适配。

---

# 24. 附录 A：最小 API 示例

## 24.1 Service Provider

```ts
import { Context, Service } from '@teoclub/cordis'

class GreetingService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeting')
  }

  hello(name: string) {
    return `Hello, ${name}`
  }
}

export default GreetingService
```

## 24.2 Consumer Plugin

```ts
import type { Context } from '@teoclub/cordis'

export default {
  name: 'welcome',
  inject: ['greeting'],
  apply(ctx: Context) {
    ctx.logger('welcome').info(ctx.greeting.hello('Cordis'))
  },
}
```

## 24.3 Lifecycle Timer

```ts
export default function heartbeat(ctx) {
  ctx.interval(() => {
    ctx.logger('heartbeat').debug('tick')
  }, 1_000)

  // 无需手动 clearInterval；Fiber 卸载自动清理。
}
```

---

# 25. 附录 B：参考基线

1. 用户提供：`SPEC.md`，`@deepseek-ai/cordis` 4.0.1 逆向规格，2026-08-23。
2. DeepSeek Harness：`vendor/README.md`，Cordis framework layer 的包清单、重命名和上游同步说明。
3. DeepSeek Harness：Cordis Primer，插件、Context、Inject、Events、Effect 基础语义。
4. DeepSeek Harness：Architecture，Everything is a plugin 和可逆注册模式。
5. Bun 官方文档：Node.js compatibility、module resolution、watch/hot、Bun APIs。

---

# 26. 最终产品定稿

> **Cordis 是 TEO Club 维护的 Node.js / Bun 双运行时 TypeScript 插件框架。它以 Context 管理作用域，以 Fiber 管理插件生命周期，以 Service 管理依赖与替换，以 Effect 管理资源回收，以 Events 管理组合与扩展。**
>
> **首个正式发行将完整接管 DeepSeek Harness vendor 中的九个框架包，统一发布到 `@teoclub`，其中 `cosmokit` 更名为 `@teoclub/kit`。Bun 的 HTTP、SQL、Redis、S3、Hash、Shell 等内置能力将在 Core 稳定后，通过官方 Provider 插件进入 Cordis。**
