import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { installDragRegions } from "./lib/dragRegions.ts";
import "./index.css";

// 触控板友好的窗口拖动区（详见 src/lib/dragRegions.ts）：主窗口 / game-log-window /
// plugin-webview-* 都加载本入口，装一次即可全覆盖
installDragRegions();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
