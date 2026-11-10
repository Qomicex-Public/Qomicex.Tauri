# 主页自定义组件 XML 语法

> 生成时间：2026-11-10 18:33

# 主页自定义组件 XML 语法

主页编辑态 → 添加组件 → 自定义组件 → 新建组件，可创建 `.qwidget` 单文件组件。

## 根元素

```xml
<Widget name="每日新闻" version="1.0.0" author="示例"
        description="可选说明" updateUrl="https://example.com/news.qwidget">
  ...
</Widget>
```

| 属性 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 组件显示名，≤64 字符 |
| `version` | 是 | 版本号（用于在线更新提示） |
| `author` / `description` | 否 | 元信息 |
| `updateUrl` | 否 | 在线更新地址；必须是 https:443 |

## 元素

| 元素 | 说明 | 属性 |
|---|---|---|
| `Data` | 数据源（JSON GET），可多个，不渲染 | `name`（默认 data）、`url`（https）、`refresh`（60–86400 秒） |
| `Container` | 视觉容器（边框/背景/圆角/内边距） | `direction`、`gap`、`padding`、`align`、`justify`、`border`、`background`、`radius` |
| `Row` / `Column` | 纯布局容器 | `gap`、`padding`、`align`、`justify`、`wrap` |
| `Grid` | 多列网格 | `columns`（1–6，必填）、`gap`、`padding`、`align`、`justify` |
| `Tabs` | 选项卡，只能包含 `TabItem` | `default`（默认索引，0 起） |
| `TabItem` | 单个页签 | `title`（必填） |
| `List` | 列表，只能包含一个 `ListItem` | `items`（数组路径）、`as`（默认 item）、`gap`、`emptyText` |
| `ListItem` | 列表项模板，只能包含一个根元素 | — |
| `If` | 条件渲染 | `test`（路径） |
| `Text` | 文本 | `value`、`size`、`weight`、`color`、`clamp`、`align` |
| `Button` | 唯一可点击元素 | `text`、`variant`、`size`、`onClick` + 动作参数 |
| `Image` | 图片 | `src`（https）、`alt`、`w`、`h`、`rounded` |
| `Divider` / `Spacer` | 分隔线 / 间距 | `Spacer.size`（0–48px） |

- `gap` / `padding`：0–8（Tailwind 间距刻度）。
- `align`：start/center/end/stretch；`justify`：start/center/end/between。
- `List` 最多渲染 200 项；`items` 支持 `{news.items}` 或 `news.items`。
- 元素内不允许直接写文本，文本必须走 `value` / `text` / `title` 属性。

## 数据绑定

- 任意字符串属性支持 `{path}` 插值；整个值就是一个绑定时保留原始类型。
- 数据源按 `name` 访问：`<Data name="news" .../>` → `{news.title}`；不写 name 时为 `{data.title}`。
- `List` 内提供 `{item.*}` 与 `{index}`。
- 运行状态：`{state.loading}`、`{state.error}`。
- 绑定路径只允许对象属性与数组下标，不能访问原型链。

## 动作

`Button` 的 `onClick` 只接受以下动作：

| 动作 | 参数 | 行为 |
|---|---|---|
| `launch` | `instance?` | 启动默认实例；指定 instance 时按 id/名称查找 |
| `setDefaultInstance` | `instance` | 设为默认实例 |
| `openInstance` | `instance` | 打开实例详情 |
| `navigate` | `to`：instances/downloads/accounts/resourceCenter/settings/connect/running | 站内跳转 |
| `openUrl` | `url`（https） | 系统浏览器打开 |
| `openFolder` | `target`：game/logs/data/screenshots | 打开目录 |
| `copy` | `value` | 复制文本 |
| `selectAccount` | — | 选择默认账户 |
| `install` | `projectId`、`source`（curseforge/modrinth/ftb）、`category` | 跳转资源详情页 |
| `refresh` | — | 重新拉取本组件数据 |

## 完整示例

```xml
<Widget name="每日新闻" version="1.0.0" updateUrl="https://example.com/news.qwidget">
  <Data name="newsData" url="https://api.example.com/news" refresh="3600" />
  <Container padding="4" gap="3" border="1" radius="lg" background="card">
    <Text value="{newsData.title}" size="lg" weight="bold" />
    <List items="{newsData.items}" as="item" gap="2" emptyText="暂无新闻">
      <ListItem>
        <Row gap="2" align="center">
          <Text value="{item.title}" size="sm" clamp="2" />
          <Button text="阅读" size="sm" variant="ghost" onClick="openUrl" url="{item.url}" />
        </Row>
      </ListItem>
    </List>
    <If test="{state.error}">
      <Text value="数据加载失败" size="xs" color="destructive" />
    </If>
  </Container>
  <Tabs>
    <TabItem title="快捷入口">
      <Grid columns="2" gap="2">
        <Button text="启动游戏" onClick="launch" />
        <Button text="资源中心" onClick="navigate" to="resourceCenter" />
      </Grid>
    </TabItem>
  </Tabs>
</Widget>
```

## 安全与限制

- XML ≤64KB、深度 ≤12、元素 ≤500；数据源 ≤8 个；单次响应 ≤512KB。
- URL 仅 https:443，且禁止重定向；后端会解析主机并拒绝回环/内网/保留地址。
- 导入或保存时必须逐项勾选组件会自动访问的域名（数据源、更新源、静态图片）。
- 在线组件按 6 小时 TTL 静默检查更新；更新若引入未确认域名，不会自动替换，需在编辑器中确认。
- 组件不能执行 JS、不能渲染任意 HTML、不能包含输入框；动作只能从白名单选择。
- 图片只在域名已确认时加载；动态图片 URL 也受同一域名白名单约束。


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-11-10 | v1.0 | 初版创建 | AI Agent |