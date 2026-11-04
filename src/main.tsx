// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import { installDragRegions } from "@qomicex/plugin-ui";
import { installGlobalErrorLogging, logError } from "./lib/frontendLog.ts";
import "./index.css";

// 触控板友好的窗口拖动区（实现见 @qomicex/plugin-ui 的 lib/dragRegions）：
// 主窗口 / game-log-window / plugin-webview-* 都加载本入口，装一次即可全覆盖
installDragRegions();

// 全局未捕获异常上报：必须在 App 及其依赖求值前安装，覆盖启动阶段的错误。
installGlobalErrorLogging();

// 动态导入 App：静态 import 会在 main.tsx 执行前求值 App 依赖，早于全局监听器。
void import("./App.tsx")
  .then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((e) => logError("startup.importApp", e));
