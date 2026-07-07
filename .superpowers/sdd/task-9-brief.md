## Task 9: 前端类型与 API 封装

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/api/connector.ts`

**Interfaces:**
- Consumes: `get`/`post` from `./client.ts`。
- Produces: 类型 `ConnectorPlayer`、`ConnectorGameInfo`、`ConnectorStatus`；函数 `hostByPort`、`hostByInstance`、`joinRoom`、`getStatus`、`leave`。

- [ ] **Step 1: types/index.ts 追加类型**

在 `RoomCodeResponse` 定义之后追加：

```typescript
export interface ConnectorPlayer {
  name: string
  vendor: string
  iconBase64: string | null
  kind: 'host' | 'guest'
}

export interface ConnectorGameInfo {
  gameVersion: string
  loader: string | null
  loaderVersion: string | null
}

export interface ConnectorStatus {
  mode: 'idle' | 'host' | 'guest'
  roomCode: string | null
  mcHost: string | null
  mcPort: number | null
  gameInfo: ConnectorGameInfo | null
  players: ConnectorPlayer[]
}
```

- [ ] **Step 2: 创建 src/api/connector.ts**

```typescript
import { get, post } from './client.ts'
import type { ConnectorStatus } from '../types/index.ts'

export function hostByPort(port: number): Promise<{ roomCode: string }> {
  return post('/connector/host/port', { port })
}

export function hostByInstance(instanceId: string): Promise<{ status: string }> {
  return post('/connector/host/instance', { instanceId })
}

export function joinRoom(code: string): Promise<{ mcHost: string; mcPort: number }> {
  return post('/connector/join', { code })
}

export function getStatus(): Promise<ConnectorStatus> {
  return get<ConnectorStatus>('/connector/status')
}

export function leave(): Promise<{ status: string }> {
  return post('/connector/leave')
}
```

- [ ] **Step 3: 验证 build**

Run: `npm run build`
Expected: 编译通过（tsc 无类型错误，vite build 成功）。

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/api/connector.ts
git commit -m "feat: add connector types and API client"
```

---

