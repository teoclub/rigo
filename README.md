# rigo：最小 AI agent 脚手架

像给小朋友讲故事一样讲清楚：

- 🤖 **小机器人**：会听、会想、会玩玩具、会回答的 AI。
- 🧠 **脑子**：大模型。没有钥匙也能用假脑子玩。
- 🧰 **玩具箱**：工具。机器人需要什么玩具，就放什么玩具进去。
- 📓 **小本子**：会话，记住说过的话。
- 📦 **大盒子**：deepseek-harness 内核，把以上东西装在一起。
- 🧩 **积木**：cordis 插件。需要什么，就把对应的积木拿过来。

## 快速开始

```sh
bun install
bun run start        # 假脑子，不需要钥匙
bun run test         # 所有测试
bun run typecheck    # 类型检查
```

用真脑子，设置 `RIGO_LLM_BASE_URL`、`RIGO_LLM_API_KEY`、`RIGO_LLM_MODEL` 后再 `bun run start`，
细节见 [examples/minimal-agent/README.md](examples/minimal-agent/README.md)。

## 目录

```text
packages/harness/   deepseek-harness 内核和积木（llm、tools、session、agent-loop 等）
vendor/cordis/      cordis 积木系统（插件运行时），整个保留
examples/           最小机器人（bun run start 的入口）
tests/              测试
docs/               兼容矩阵、上游基线与审计记录
```

这个仓库已经不再包含 Work 产品、Code bundle、HTTP/SDK、网页界面和共享服务；
它们留在 git 历史里，需要时可以再按积木的方式加回来。
