# 待办清单

> 生成时间：2026-09-07

## 高优先级

- [ ] **修复 Issue #86**：主页组件位置修改后下次打开会重置（GitHub open issue）

## 中优先级

- [ ] **modpack.rs:1174**：整合包安装参数为占位值，待解析 manifest.zip 取真实值
- [ ] **instance_files.rs:1001**：mcmod 中文名 enrich 未接入（McmodService 缺接口）

## 低优先级

- [ ] **skin.rs:907**：切换 `axum::extract::Multipart` 替换现有上传解析
- [ ] **resource_center.rs:708**：FTB 无分页，聚合搜索翻页会重复
- [ ] **UpdateDialog.tsx:36**：插件下载无真中止 API，cancel 语义 = 下完不装

## 技术债备忘（ponytail 有意简化，非 bug）

- `src/lib/simple-cache.ts` / `src/api/skin.ts`：全局内存缓存无淘汰，内存敏感时需 LRU
- `src-tauri/src/ipc.rs:260`：导出响应整体缓冲进内存，大文件应走 `ipc_stream`
- `src/pages/Accounts.tsx:96`：shift-select 搜索变化时区间选择漂移
- CI（debug.yml / release.yml）：QEMU 下 pnpm tarball 校验异常的 workaround
