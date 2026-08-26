# Qomicex 插件开发技能包（qomicex-plugin）

面向 AI agent（Claude / opencode / Cursor 等）的 Qomicex 启动器插件（`.qplugin`）开发技能包，随 `@qomicex/cli` 分发。本技能把"生成合规插件"所需的全部事实（manifest 校验、权限目录、桥 API、主题 token、签名、调试）收敛到一个目录，避免 AI 臆造字段。

## 何时使用

用户要求**开发 / 修改 / 审查 / 打包 / 发布** Qomicex 启动器插件时加载本技能。判断依据：涉及 `manifest.json`、`__PLUGIN_API__`、`entry.frontend`、`contributes`、权限声明、`.qplugin` 打包等关键词。

## 文件导航（建议全读，勿跳）

| 文件 | 内容 |
|------|------|
| `manifest-schema.md` | manifest.json 全字段 + layers 语义 + render 默认 iframe + dependencies + contributes |
| `permissions.md` | 权限目录（normal/warning/danger）+ 每个权限对应的桥 API 方法 |
| `plugin-api.md` | 桥 API（`__PLUGIN_API__`）签名速查 |
| `theme.md` | 主题语义 token 三级体系 + `var()` 消费约定 + 主题贡献 |
| `signing.md` | Ed25519 签名流程（生成密钥 → pack --key → publish） |
| `debugging.md` | harness 热重载调试 |
| `rules.md` | AI 生成插件的硬性规则（必须逐条遵守） |

## 完整流程（create → dev → verify → pack → publish）

```bash
# 1. 生成项目（id 需反向域名格式，如 com.example.demo）
qomicex create com.example.demo

# 2. 本地调试（仓库内自动进 harness，固定端口 1420；仓库外裸 Vite 默认 5173）
cd com.example.demo && pnpm install && qomicex dev

# 3. 校验（提交/打包前必跑，0 error 才算通过）
qomicex verify

# 4. 打包（tsc && vite build → release/<id>-<version>.qplugin）
qomicex pack --version 0.2.0
qomicex pack --key ./dev-key.pem   # 附签名（仅 signature.json；完整证书链走 publish）

# 5. 发布（设备流登录 → 商店签发证书 → 签名 → 上传）
export QOMICEX_SIGN_KEY=<私钥 base64/PEM>
qomicex publish
```

## 常见错误与规避

| 错误 | 规避 |
|------|------|
| `id` 不含点 / 大写 / 连续双点 | id 用 `^[a-z0-9]+([.-][a-z0-9]+)*$`，3-128 字符，含至少一个点 |
| `version` 非 semver | 严格 `数字.数字.数字`（可带 `-预发布` / `+构建号`） |
| `entry.frontend` 指向非 `.html` | `verify` 警告：frontend 应指向 `.html`（如 `dist/index.html`） |
| 声明了 frontend 但 `layers` 无 `l2`/`l3` | 无法渲染 UI；UI 插件务必声明 `l2`（iframe 沙箱，默认推荐） |
| 权限声明与源码调用不一致 | `verify` 会做权限最小化扫描，声明未用 / 用了未声明**都会报错** |
| 相对 import 不带扩展名 | Vite 强制：`import { x } from './api.ts'`，漏 `.ts/.tsx` 直接构建失败 |
| 插件里 `fetch()` 外部 URL 被 CORS / SSRF 拦 | 用 `proxyFetch` / `proxyFetchStream`（带 SSRF 防护） |
| 沙箱内 `window.open` 被拦 | 用 `callBackend('/system/open-url', { url })` 或 `openUrl` |
| `vite.config.ts` 没设 `base: './'` | 产物 `/assets/...` 会被解析成站点根，插件白屏 |
| 长循环 / 无界 `setInterval` | `verify` 会告警；放 Worker / WASM / 后端 |
| 硬编码 API key 进插件源码 | 无密钥存储；让用户经 `setSettings` 配置，运行时 `getSettings` 读取 |

## 事实一致红线

- 本技能内容与代码事实对齐（`src/plugins/types.ts`、CLI `src/lib/*`、公开文档 `docs/plugins/plugin-api.md`）。字段含义有疑问时**以代码为准**，不确定就标注，不要虚构 API 或字段。
- `packages/plugin-ui`（`@qomicex/plugin-ui`）的组件库使用参见 `tailwind.config.js` 的 `@qomicex/plugin-ui/tailwind-preset`，主题类名（`bg-primary`、`text-muted-foreground` 等）直接消费语义 token。

## 起步提示词（给 AI 用）

> 你是 Qomicex 插件开发工程师。先读 `skills/qomicex-plugin/` 下的 SKILL.md 与各分册（尤其 rules.md），再按流程工作：`qomicex create <id>` 生成项目 → 实现功能 → `qomicex verify` 过 0 error → `qomicex pack` 出包。manifest 字段、权限、API 签名一律以技能包内文档为准，不臆造。
