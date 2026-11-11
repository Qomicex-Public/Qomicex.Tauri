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

WPF 风格绑定：

```xml
<Text Value="{Binding Data.news.title, Converter=Upper}" />
<TextBox Value="{Binding Inputs.price, Converter=Money, ConverterParameter='N2', Mode=TwoWay}" />
<Text Value="{MultiBinding Paths='Inputs.first|Inputs.last', Converter=Join, ConverterParameter=' '}" />
```

- `Converter` 引用 `<Widget.Converters>` 里的 `Converter.Name`
- `ConverterParameter` 可选，支持单引号或双引号
- `Mode`：`OneWay`（默认）/ `TwoWay` / `OneWayToSource`
- `Path` 仍是现有绑定路径；`{Data.foo}` 等旧写法继续可用
- `MultiBinding` 的 `Paths` 用 `|` 分隔

## Converters

```xml
<Widget.Converters>
  <Converter Name="Upper" Type="Upper" />
  <Converter Name="Money" Type="Format" Format="N2" />
  <Converter Name="Visible" Type="BoolToVisibility" />
  <Converter Name="Label" Type="Map">
    <MapEntry From="True" To="开" />
    <MapEntry From="False" To="关" />
  </Converter>
  <Converter Name="Double" Type="Script">
    <Converter.Convert>return Number(value) * 2</Converter.Convert>
    <Converter.ConvertBack>return Number(value) / 2</Converter.ConvertBack>
  </Converter>
</Widget.Converters>
```

内置 `Type`：`String` / `Number` / `Bool` / `DateTime` / `Json` / `Format` / `Map` / `BoolToVisibility` / `Upper` / `Lower` / `Join` / `Script`。

- `Format`：数字按 `Format` 或 `ConverterParameter` 格式化，如 `N2`
- `DateTime`：按 `Format` 输出日期，支持 `yyyy` / `MM` / `dd` / `HH` / `mm` / `ss`
- `Map`：按 `From` 精确匹配，未命中返回原值
- `Join`：多值按 `ConverterParameter`（默认 `, `）连接
- `Script`：`Convert` 必填，`ConvertBack` 可选；参数为 `value` / `values` / `parameter` / `targetType` / `culture` / `scope`
- 脚本异常返回 `undefined`，不会中断渲染；远程组件的脚本 Converter 会进入可执行指纹确认

## Animations

```xml
<Button.Animations>
  <FadeIn Duration="180" Delay="0" Easing="EaseOut" Trigger="Loaded" />
  <ScaleTo Duration="120" From="0.96" To="1" Trigger="Hover" />
  <Pulse Duration="600" Repeat="Infinite" Trigger="Click" />
</Button.Animations>
```

- 元素：`FadeIn` / `SlideIn` / `ScaleTo` / `RotateTo` / `Pulse` / `Spin`
- `Duration` / `Delay` 毫秒；`Easing`：`Linear` / `Ease` / `EaseIn` / `EaseOut` / `EaseInOut`
- `Repeat`：数字或 `Infinite`；`Trigger`：`Loaded` / `Hover` / `Click`
- `SlideIn` 支持 `Direction`（`Left` / `Right` / `Top` / `Bottom`）和 `Distance`
- `FadeIn` / `ScaleTo` 支持 `From` / `To`；`RotateTo` 使用角度
- 声明 `Animations` 只接管该节点的默认 transition；声明 `Effects` 只接管 Effect，两者互不影响

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

### 2026-11-10 更新

## 补充（2026-11-10）

### LauncherVersion

```xml
<Widget Name="示例" Version="1.0.0" LauncherVersion="1.4.0">
  ...
</Widget>
```

`LauncherVersion` 表示最低启动器版本（semver，如 `1.4` / `1.4.0` / `1.4.0-beta`）。运行时当前版本低于要求时组件显示错误占位；编辑器信息面板显示要求版本与当前版本。

### Resource 的 Text 属性

`String` / `Bool` / `Number` / `Binary` / `Resource` 同时支持文本内容与 `Text` 属性：

```xml
<String Name="Greeting">你好，Qomicex</String>
<String Name="Greeting" Text="你好，Qomicex" />
```

两种写法等价；`Binary` 的 `Text` 填 base64。

### 编辑器补全

- 输入 `<` 出现元素候选；输入 `<Text ` 出现属性候选。
- 属性候选按 Tab/Enter 会插入 `Name=""` 并把光标放在引号内；标签/值/绑定候选只插入名称。
- 输入 `/` 会自动补成 `/>`（已有 `>` 时只补 `/`）。



### 2026-11-10 更新

## 三种等价写法（属性 / 内容 / 属性元素）

同一个属性赋值支持三种写法，效果一致；同时设置会报 `duplicateProperty`。

```xml
<!-- 属性语法 -->
<Text Value="Hello" />

<!-- 内容语法（ContentProperty） -->
<Text>Hello</Text>

<!-- 属性元素语法 -->
<Text><Text.Value>Hello</Text.Value></Text>
```

内容语法依赖每个元素的 ContentProperty：

| 元素 | ContentProperty |
|---|---|
| `Text` | `Value` |
| `Button` / `Link` / `CheckBox` / `FilePicker` | `Text` |
| `TextBox` / `ColorPicker` / `Progress` / `Slider` | `Value` |
| `Select` | `Options`（JSON） |
| `Media` | `Source` |
| `Image` | `Src` |
| `Spacer` | `Size` |
| `Data` | `Url` |
| `String` / `Bool` / `Number` / `Binary` / `Resource` | 文本内容（等价 `Text` 属性） |
| `Container` / `Row` / `Column` / `Grid` / `Tabs` / `List` / `If` / `Widget` | 子元素（内容语法天然支持） |

示例：

```xml
<Button OnClick="Navigate" To="Instances">实例管理</Button>

<TextBox Name="Keyword" Placeholder="搜索">
  <TextBox.Value>{Resources.LastKeyword}</TextBox.Value>
</TextBox>

<Media Type="Audio">
  <Media.Source>{Data.Music.Url}</Media.Source>
</Media>
```

注意：

- 内容语法只能表达**文本值**；属性元素语法适合显式指定属性、枚举、动作参数，以及未来可能出现的复杂对象。
- 元素内容不能同时放子元素和文本（容器除外：容器内容就是子元素）。
- 属性与内容/属性元素重复设置同一个属性会直接报错。

