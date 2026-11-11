// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { transform } from 'sucrase'

/** 只剥离 TS 类型；不做类型检查，也不引入额外 polyfill。 */
export function transpileScript(code: string): string {
  return transform(code, {
    transforms: ['typescript'],
    disableESTransforms: true,
    preserveDynamicImport: true,
  }).code
}
