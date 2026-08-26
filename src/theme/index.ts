export {
  validateTheme,
  themeToCssVars,
  themeToCssBlock,
  ThemeError,
  THEME_SCHEMA_VERSION,
  KNOWN_COLOR_KEYS,
  normalizeVarName,
  type ColorTheme,
} from './schema.ts'
export {
  validateIconTheme,
  IconThemeError,
  ICON_THEME_SCHEMA_VERSION,
  type IconThemeEntry,
  type IconThemeDefinition,
} from './icon-theme.ts'
export {
  registerTheme,
  registerIconTheme,
  applyTheme,
  clearTheme,
  getActiveTheme,
  getActiveIconTheme,
  restoreSavedTheme,
  subscribeThemeChange,
  useTheme,
  useIconTheme,
  type UseThemeResult,
} from './manager.ts'

// 注册内置 Catppuccin 预设（以 .qtheme 迁移，值同 index.css → 视觉零回归）。
import { registerTheme } from './manager.ts'
import latte from './themes/catppuccin-latte.json'
import frappe from './themes/catppuccin-frappe.json'
import macchiato from './themes/catppuccin-macchiato.json'
import mocha from './themes/catppuccin-mocha.json'
registerTheme(latte)
registerTheme(frappe)
registerTheme(macchiato)
registerTheme(mocha)
