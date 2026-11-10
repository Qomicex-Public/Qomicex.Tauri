// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export const WIDGET_TEMPLATE = `<Widget name="我的组件" version="1.0.0">
  <Container padding="4" gap="3">
    <Text value="你好，Qomicex" size="lg" weight="bold" />
    <Row gap="2">
      <Button text="启动游戏" size="sm" onClick="launch" />
      <Button text="实例管理" size="sm" variant="outline" onClick="navigate" to="instances" />
    </Row>
  </Container>
</Widget>
`
