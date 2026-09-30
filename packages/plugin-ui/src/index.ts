// 拖动区 / 触控板手势 / 滚动抑制（ADR-086 / ADR-087）。
// 供启动器与所有插件运行时复用：宿主入口调用一次 installDragRegions() 即可。
export {
  DRAG_REGION_ATTR,
  NO_DRAG_ATTR,
  SCROLL_ATTR,
  DRAG_THRESHOLD_PX,
  DRAG_CLICK_SLOP_PX,
  FRAME_TOP_PX,
  FRAME_LEFT_PX,
  FRAME_RIGHT_PX,
  FRAME_BOTTOM_PX,
  WHEEL_BURST_GAP_MS,
  ENABLE_SCROLL_CONTAINMENT,
  installDragRegions,
  isDragRegionsInstalled,
  applyScrollContainment,
  classifyTarget,
} from './lib/dragRegions.js'
export type { HitCategory } from './lib/dragRegions.js'
export { cn } from './lib/cn.js'
export { Badge, badgeVariants } from './components/Badge.js'
export { BatchToolbar } from './components/BatchToolbar.js'
export { Button, buttonVariants } from './components/Button.js'
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './components/Card.js'
export { Checkbox } from './components/Checkbox.js'
export { Combobox } from './components/Combobox.js'
export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from './components/Dialog.js'
export { Input } from './components/Input.js'
export { Label } from './components/Label.js'
export { MessageBoxProvider, useMessageBox } from './components/MessageBox.js'
export { Select, SelectOption, SelectDivider } from './components/Select.js'
export { Skeleton, SkeletonCard, SkeletonList } from './components/Skeleton.js'
export { Separator } from './components/Separator.js'
export { Switch } from './components/Switch.js'
export { Popover } from './components/Popover.js'
export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption } from './components/Table.js'
export { Tabs, TabContent } from './components/Tabs.js'
export type { Tab } from './components/Tabs.js'
export { Textarea } from './components/Textarea.js'
export { Tooltip } from './components/Tooltip.js'
export { useFloatingPosition, useTooltipPosition } from './hooks/useFloatingPosition.js'
export type { PluginManifest, PluginDependency, PluginLayer, PluginEntry, PluginContributes, PluginMenuItem, PermissionInfo } from './plugins.js'
export { PERMISSION_CATALOG } from './plugins.js'
