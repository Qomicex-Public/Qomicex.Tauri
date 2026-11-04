// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { installDragRegions } from "@qomicex/plugin-ui";
import { installGlobalErrorLogging } from "./lib/frontendLog.ts";
import "./index.css";

// 触控板友好的窗口拖动区（实现见 @qomicex/plugin-ui 的 lib/dragRegions）：
// 主窗口 / game-log-window / plugin-webview-* 都加载本入口，装一次即可全覆盖
installDragRegions();

// 全局未捕获异常上报：必须在 App 挂载前安装，覆盖启动阶段的错误。
installGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
