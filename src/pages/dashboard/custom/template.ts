// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export const WIDGET_TEMPLATE = `<Widget Name="我的组件" Version="1.0.0">
  <Resources>
    <String Name="Greeting">你好，Qomicex</String>
  </Resources>

  <Container Padding="4" Gap="3">
    <Text Value="{Resources.Greeting}" Size="Lg" Weight="Bold" />
    <TextBox Name="Keyword" Placeholder="输入关键词" />
    <Button Text="搜索" Size="Sm" OnClick="CallFunction" Function="Search" />
    <List Items="{Results.Search.Items}" As="Item" EmptyText="暂无结果">
      <ListItem>
        <Text Value="{Item.Title}" Size="Sm" />
      </ListItem>
    </List>
  </Container>

  <Function Name="Search" Timeout="3000">
    <Function.Interface>
      <Struct Name="SearchInput">
        <Field Name="Keyword" Type="String" />
      </Struct>
      <Struct Name="SearchItem">
        <Field Name="Title" Type="String" />
      </Struct>
    </Function.Interface>
    <Function.Input Type="SearchInput">Input</Function.Input>
    <Function.Output Type="Json">Items</Function.Output>
    <Function.Script><![CDATA[
      return {
        Items: Input.Keyword
          ? [{ Title: Input.Keyword }, { Title: Input.Keyword + " 2" }]
          : []
      };
    ]]></Function.Script>
  </Function>
</Widget>
`
