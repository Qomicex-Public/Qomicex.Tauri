# Task 10 报告：导航项与路由

## 实现内容
- 新建占位页面 `src/pages/Connect.tsx`，仅渲染 `PageHeader`（title="联机", subtitle="创建或加入联机房间"）。
- `src/components/Sidebar.tsx`：import 行加入 `faNetworkWired`；`links` 数组在 `resource-center` 之后追加 `{ to: '/connect', label: '联机', icon: faNetworkWired }`。
- `src/App.tsx`：加入 `import Connect from './pages/Connect.tsx'`；在 `/resource-center/:resourceId` 路由之后追加 `<Route path="/connect" element={<Connect />} />`。

## 偏差
无。完全按 brief 实现。

## Build 结果
`npm run build` 通过（tsc strict + vite build，7.91s）。输出仅有项目既有的 chunk/动态导入警告，与本次改动无关。

## 变更文件
- `src/pages/Connect.tsx`（新建）
- `src/components/Sidebar.tsx`
- `src/App.tsx`

## 自审
- [x] 所有本地 import 含 `.tsx` 扩展名。
- [x] `faNetworkWired` 已在 Sidebar 导入并使用。
- [x] 导航项置于 resource-center 之后；路由置于 resource-center/:resourceId 之后。
- [x] 占位页正常渲染（PageHeader props 匹配：title/subtitle）。
- [x] 使用 `<Route>` / `NavLink`，未使用 `<a>`。

## 顾虑
无。仅为 Task 11 完整 UI 预留占位。
