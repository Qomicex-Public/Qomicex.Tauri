// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 表单错误行：高度从 0fr 展开到 1fr（不是硬插入一行）。
 *
 * 直接 `{error && <p>}` 会让下面的按钮/内容瞬间下移；这里保持节点常驻，
 * 用 grid-template-rows 做高度过渡，读屏仍能通过 aria-live 播报。
 */
export function FieldError({ message }: { message?: string | null }) {
  const open = !!message
  return (
    <div aria-live="polite" className="field-error" data-open={open ? 'true' : 'false'}>
      <div className="min-h-0 overflow-hidden">
        <p className="text-destructive text-sm">{message ?? ''}</p>
      </div>
    </div>
  )
}
