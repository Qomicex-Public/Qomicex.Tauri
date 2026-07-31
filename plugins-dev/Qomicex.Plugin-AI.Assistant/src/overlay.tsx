import { createRoot } from 'react-dom/client'
import ChatOverlay from './ChatOverlay.tsx'
import { initApi } from './api.ts'

const root = document.getElementById('root')!

initApi().then(() => {
  createRoot(root).render(<ChatOverlay />)
}).catch(() => {
  root.innerHTML =
    '<div style="padding:20px;text-align:center;color:var(--error,#f55);font-size:13px">API 桥接初始化失败</div>'
})
