# 前端 API 调用规范

## 客户端模块

所有 API 调用封装在 `src/api/` 目录下的模块中，按领域划分：

| 模块 | 文件 | 用途 |
|:---|:---|:---|
| Client | `client.ts` | 核心 HTTP 客户端、ApiError 类、通用请求函数 |
| Account | `account.ts` | 账户 CRUD、认证 |
| Instance | `instance.ts` | 实例 CRUD、启动、安装 |
| Resource | `resource.ts` | 资源搜索、详情、版本 |
| Resource Download | `resource-download.ts` | 资源下载 |
| Java | `java.ts` | Java 运行时管理 |
| Settings | `settings.ts` | 应用设置 |
| Logs | `logs.ts` | 日志管理 |
| Skin | `skin.ts` | 皮肤获取/上传 |
| 其他 | ... | 见 `src/api/` 目录 |

## 调用规范

- 每个端点模块导出类型化异步函数
- 使用 `apiClient` 实例发起请求
- 错误统一通过 `ApiError` 捕获
- 路径参数使用模板字符串: `/instance/${id}/launch`

## 进度流

使用 SSE (`/progress/stream`) 监听安装/下载进度:

```typescript
const eventSource = new EventSource('/api/progress/stream')
eventSource.addEventListener('progress', (e) => {
  const data = JSON.parse(e.data)
  // 处理进度更新
})
```
