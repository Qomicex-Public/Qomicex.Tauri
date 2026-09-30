import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { installDragRegions } from "@qomicex/plugin-ui";
import "./index.css";

// 触控板友好的窗口拖动区（实现见 @qomicex/plugin-ui 的 lib/dragRegions）：
// 主窗口 / game-log-window / plugin-webview-* 都加载本入口，装一次即可全覆盖
installDragRegions();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
