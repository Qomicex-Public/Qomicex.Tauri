# Contributing

本文适用于 issue、discussion、pull request。开发细节见 HACKING.md。


## 最关键规则：你必须理解你的代码

如果你不能在不借助 AI 的情况下解释你的改动、边界条件以及它如何影响系统，就不要提交。

可以用 AI 写代码，也可以用 AI 追问代码库来建立理解。  
禁止提交你无法解释的 agent 生成内容。  
必须阅读并遵守 [AI_POLICY.md](AI_POLICY.md)。

## AI 使用

本仓库对 AI 使用有严格规则，见 [AI_POLICY.md](AI_POLICY.md)。  
PR 必须披露 AI 使用情况。

## 首次贡献者

如果这是开放贡献项目，建议使用 vouch 机制：

1. 先开 discussion，说明你想改什么、为什么。
2. 保持简洁。
3. 用你自己的话写，不要让 AI 代写。
4. 维护者回复 `!vouch` 后，才可以提交 PR。
5. 未 vouch 的 PR 会被自动或人工关闭。

原因：AI 让“看起来合理但质量低”的贡献成本变低，默认信任不再可行。

内部团队可改为：

1. 首次贡献先走 issue / 设计讨论。
2. 由 maintainer 或 owner 打 `approved-to-pr` 标签。
3. 无标签 PR 先关闭，要求补讨论。

## 质量与后果

反复违反规则或提交低质量内容：

1. 第一次：要求修改、重写提交信息、补测试。
2. 第二次：关闭 PR，要求先讨论。
3. 反复违规：加入质量黑名单，后续自动关闭。


## Issue 与 PR

- Issue 只用于可执行事项。
- 功能设计先 discussion，不要用 WIP PR 讨论设计。
- PR 应关联已接受的 issue。
- PR 不是设计讨论场所。
- 没有 issue 的 PR 可能被关闭或长期搁置。

## 提交信息

格式：

```text
<type>(<scope>): <summary>

<root cause>

<approach>

<verification>

<refs>
```

只写：标题、根因、方案、验证、风险、refs。

禁止写：

- 修法一 / 修法二
- 方案一 / 方案二
- CodeRabbit / 评审过程
- worktree / 子模块 pin / CI 临时环境
- AI 对话、AI 自夸、免责声明
- emoji、口号、自我评价
- 小说式叙事、PR 复盘

推荐：

```text
fix(resource): 补全 Technic 列表元数据并在切片前排序

Technic 列表接口只返回 id/name/slug/url/iconUrl，导致简介、作者、
下载数为空。现对候选集并发拉取详情补全，按 slug 缓存 1 小时；
单条失败降级为列表数据，不用空值覆盖已有值。

聚合搜索原先先切片再补全，补全后 download_count 变化会导致分页
边界漂移。现改为先补全完整候选集，按 download_count 降序、同值
按 id 排序，再切片，保证 take(F) 恒为全局前 F 名。

验证：cargo test --bin qomicex-backend；cargo fmt --check。

Refs: #197
```

## 注释

默认不写注释。只有以下情况写：

- 非显然的业务约束。
- 外部接口或上游数据的坑。
- 兼容性、安全性、性能陷阱。
- 为什么不能采用更直观的写法。

禁止：

- `// 修法一：...`
- `// 方案二：...`
- 变更日志式注释。
- 评审记录、PR 讨论、AI 对话残留。
- 解释显而易见的事。

TODO 必须带 issue：

```rust
// TODO(#123): 上游修复后移除兼容分支
```

## 验证

提交前必须实际运行：

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --bin qomicex-backend
```

不得声称运行过未运行的命令。

## 审查清单

- 提交信息是否像 PR 复盘？是则打回。
- 注释是否在解释显而易见的事？是则删除。
- 是否声称测试通过但无命令/输出？是则打回。
- 是否使用 AI 但未披露？是则补充。
- 是否包含无关重构、格式化、重命名？是则拆分。

## 结语

我们制定这样的规则，不是为了刁难开发者，Qomicex 在大量AI协助下编写，许多维护者都接受 AI工具 作为他们工作流程中的高效工具。作为一个项目，我们欢迎 AI 作为工具！
我们制定严格AI政策的原因并非出于反对AI，而是因为大量极不合格的人使用人工智能。这是问题出在人，而不是工具。包括过去 Qomicex 的提交记录也因为追求效率，几乎没有多少审查提交消息等，正因如此，我们呼吁大家一起改变，共同建立更规范，完善，干净的开源社区

