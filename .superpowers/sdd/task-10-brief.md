## Task 10: 导航项与路由

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Create (占位): `src/pages/Connect.tsx`

**Interfaces:**
- Consumes: `Connect` 页面组件。
- Produces: `/connect` 路由与侧栏入口。

- [ ] **Step 1: 创建 Connect.tsx 占位（便于路由先通过编译）**

```tsx
import { PageHeader } from '../components/PageHeader.tsx'

export default function Connect() {
  return (
    <div className="space-y-6">
      <PageHeader title="联机" subtitle="创建或加入联机房间" />
    </div>
  )
}
```

- [ ] **Step 2: Sidebar.tsx 加导航项**

修改 import 行加入 `faNetworkWired`：

```tsx
import { faHouse, faCube, faDownload, faUser, faGear, faCompass, faNetworkWired } from '@fortawesome/free-solid-svg-icons'
```

在 `links` 数组中 `resource-center` 之后追加：

```tsx
  { to: '/connect', label: '联机', icon: faNetworkWired },
```

- [ ] **Step 3: App.tsx 加路由**

加 import：

```tsx
import Connect from './pages/Connect.tsx'
```

在 `<Route path="/resource-center/:resourceId" ... />` 之后追加：

```tsx
            <Route path="/connect" element={<Connect />} />
```

- [ ] **Step 4: 验证 build**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/pages/Connect.tsx
git commit -m "feat: add connect nav item, route, placeholder page"
```

---

