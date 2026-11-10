# 主页自定义组件 XML 语法 v2

> 生成时间：2026-11-10 22:30

# 主页自定义组件 XML 语法（v2）

主页编辑态 → 添加组件 → 自定义组件 → 新建组件。

## 根元素

```xml
<Widget Name="每日新闻" Version="1.0.0" Author="示例"
        Description="可选" UpdateUrl="https://example.com/news.qwidget">
  ...
</Widget>
```

`Name` / `Version` 必填；`UpdateUrl` 必须是 https:443 并走代理。

## 命名

所有元素、属性、枚举值均为大驼峰：`Text`、`Value`、`Size="Lg"`、`Weight="Bold"`、`OnClick="CallFunction"`。

## 属性元素与附加属性

```xml
<Text>
  <Text.Value>{Data.Title}</Text.Value>
  <Text.Size>Lg</Text.Size>
  <Text.Weight>Bold</Text.Weight>
</Text>

<Button Text="提交">
  <Button.OnClick>CallFunction</Button.OnClick>
  <Button.Function>CreateUser</Button.Function>
  <Button.Arguments><![CDATA[{"name":"{Inputs.UserName}"}]]></Button.Arguments>
</Button>
```

`Grid` 子元素支持 `Grid.Row` / `Grid.Column` / `Grid.RowSpan` / `Grid.ColumnSpan`，可写成属性或属性元素。

## 绑定

- `{Data.<Source>.<Path>}`；未命名数据源为 `{Data.<Path>}`
- `{Resources.<Name>}`、`{Inputs.<Name>}`
- `{Results.<Function>.<Output>}`、`{Results.Command.ExitCode}`、`{Results.PluginApi.*}`
- `{Children.<As>.Inputs/Data/Results/State}`
- `{State.Loading}` / `{State.Error}`

## Data

```xml
<Data Name="News" Type="Json" Source="Url" Url="https://api.example.com/news" Refresh="3600" />
<Data Name="Feed" Type="Xml" Url="https://example.com/feed.xml" />
<Data Name="Cover" Type="Binary" Source="File" Path="./assets/cover.png" Mime="image/png" />
<Data Name="Text" Type="Text" Source="File" Path="C:\docs\notice.txt" />
```

- `Type`：`Json` / `Text` / `Xml` / `Binary`
- `Xml` 解析为 `{ Root: { Name, Attributes, Text, Children } }`
- `Binary` 解析为 `{ Url, Base64, Mime, Size }`，`Url` 可直接给 `Image`/`Media`
- `Source`：`Url`（默认）或 `File`；相对路径基于组件文件目录（URL 导入用启动器数据目录），绝对路径原样
- 在线文本/JSON/XML 上限 1MB，二进制 8MB；在线请求仅 https:443、禁重定向、后端拒绝回环/内网地址

## Resources

```xml
<Resources>
  <String Name="AppName">Qomicex</String>
  <Bool Name="ShowTip">True</Bool>
  <Number Name="PageSize">10</Number>
  <Binary Name="Beep" Mime="audio/wav">BASE64...</Binary>
  <Resource Name="Alias" Type="String">...</Resource>
</Resources>
```

## Triggers

```xml
<Triggers>
  <Trigger Event="Loaded" Function="Init" />
  <Trigger Event="DataChanged" Data="News" Function="RenderNews" />
  <Trigger Event="Click" Control="SearchButton" Function="Search" />
  <Trigger Event="Timer" Interval="60000" Function="Tick" Once="False" />
</Triggers>
```

`Trigger` 可写 `Function` 或 `Action` + 动作参数；触发频率上限 20 次/秒。

## 控件

| 控件 | 关键属性 |
|---|---|
| `TextBox` | `Name` `Value` `Placeholder` `Multiline` `Password` `ReadOnly` `MaxLength` `OnChange` |
| `CheckBox` | `Name` `Text` `Checked` `OnChange` |
| `Slider` | `Name` `Value` `Min` `Max` `Step` `OnChange` |
| `Select` | `Name` `Value` `Options`(JSON) `OnChange` |
| `Progress` | `Value` `Max` |
| `Link` | `Text` `Url` `OnClick` |
| `Media` | `Type`(Audio/Video) `Source` `Controls` `AutoPlay` `Loop` `Poster` `Volume` `Muted` |
| `FilePicker` | `Name` `Text` `Filter` `Value` |
| `ColorPicker` | `Name` `Value` `OnChange` |

控件当前值进入 `{Inputs.<Name>}`；`Button`/`Link` 的 `Name` 可供 Click Trigger 使用。

## Function（TS 脚本）

```xml
<Function Name="CreateUser" Timeout="3000">
  <Function.Interface>
    <Struct Name="CreateUserInput">
      <Field Name="name" Type="String" />
      <Field Name="age" Type="Number" />
    </Struct>
    <Struct Name="UserProfile">
      <Field Name="id" Type="Number" />
      <Field Name="name" Type="String" />
      <Field Name="createdAt" Type="DateTime" />
    </Struct>
  </Function.Interface>
  <Function.Input Type="CreateUserInput">Input</Function.Input>
  <Function.Output Type="UserProfile">User</Function.Output>
  <Function.Output Type="String">Message</Function.Output>
  <Function.Script><![CDATA[
    return {
      User: { id: Date.now(), name: Input.name, age: Input.age, createdAt: new Date().toISOString() },
      Message: "ok"
    };
  ]]></Function.Script>
</Function>
```

- 类型：`String` / `Number` / `Bool` / `DateTime` / `Json` / `Binary` / Struct
- 脚本可读 `Input`、`Inputs`、`Resources`、`Data`、`Results`、`Host`（`Notify`/`OpenUrl`/`Navigate`/`Log`）
- 禁止网络、DOM、localStorage、`import`/`require`；默认 3s 超时，超时销毁沙箱
- 结果写入 `{Results.<Function>.<Output>}`

## 动作

| 动作 | 参数 |
|---|---|
| `Launch` | `Instance?` |
| `SetDefaultInstance` / `OpenInstance` | `Instance` |
| `Navigate` | `To` |
| `OpenUrl` | `Url` |
| `OpenFolder` | `Folder` |
| `Copy` | `Value` |
| `SelectAccount` | — |
| `Install` | `ProjectId` `Source` `Category` |
| `Refresh` | — |
| `CallFunction` | `Function` `Arguments?` |
| `RunCommand` | `Command` `WorkingDirectory?` `Timeout?` |
| `PluginApi` | `PluginId` `Method` `Arguments?` |

`Arguments` 是 JSON，内部 `{Inputs.*}` / `{Results.*}` 会插值。`RunCommand` 经 Tauri IPC 执行；`PluginApi` 调用主窗口插件注册表。

## 嵌套组件

```xml
<Widget.Using Name="WeatherCard" As="Weather" />
<Widget.Using Url="https://example.com/weather.qwidget" As="Weather" />
<Widget.Using As="Weather">WeatherCard</Widget.Using>
<Widget.Using Name="WeatherCard" As="Weather">
  <Widget.Using.Arguments><![CDATA[{"city":"{Inputs.City}"}]]></Widget.Using.Arguments>
</Widget.Using>
```

- 本地按 `Name` 精确匹配；重名/缺失会在编辑器标记，导出时提示依赖未随包分发
- 远程按 `Url` 拉取，6h TTL 静默更新；新增脚本/命令沿用风险提示
- 深度上限 5，检测自引用/循环，单父组件最多 20 个嵌套实例
- 子组件状态隔离；父组件只读 `{Children.<As>.Inputs/Data/Results/State}`
- `Widget.Using.Arguments` 传初始 Inputs，支持 `{Inputs.*}` / `{Data.*}`

## 编辑器

- CodeMirror 6：行号、语法高亮、折叠、搜索、括号/标签自动闭合
- Schema 补全：元素/属性/枚举/动作/绑定/本地组件名
- 实时 lint：XML 结构、动作、URL、资源、函数、触发器、嵌套依赖
- Function 页签：TS 高亮/补全/试运行，改动回写 `Function.Script`
- 首次保存含脚本或危险动作的组件会弹风险提示；含危险动作时编辑器常驻红色横幅

## 安全说明

自定义组件可以执行 TS 脚本、执行命令、调用插件 API 和读取本地文件；远程组件会静默更新。请只使用你信任的组件。启动器开发者不对自定义组件造成的安全风险负责。


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-11-10 | v1.0 | 初版创建 | AI Agent |