import { cn } from '../lib/utils.ts'

const ICON_NAMES = [
  'Grass', 'GrassPath', 'CobbleStone', 'GoldBlock', 'RedstoneBlock',
  'RedstoneLampOn', 'RedstoneLampOff', 'CommandBlock', 'Anvil', 'Egg',
  'Fabric', 'Quilt', 'NeoForge', 'OptiFabric', 'LabyMod', 'Cleanroom',
] as const

export type InstanceIconName = typeof ICON_NAMES[number]

const LOADER_ICONS: Record<string, InstanceIconName> = {
  forge: 'Anvil',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
  optifabric: 'OptiFabric',
  labymod: 'LabyMod',
  cleanroom: 'Cleanroom',
}

export function getDefaultIcon(loader?: string | null): InstanceIconName {
  if (loader && LOADER_ICONS[loader.toLowerCase()]) return LOADER_ICONS[loader.toLowerCase()]
  return 'Grass'
}

interface InstanceIconProps {
  icon: string | null | undefined
  iconData?: string | null | undefined
  loader?: string | null
  className?: string
  imgClassName?: string
}

export function InstanceIcon({ icon, iconData, loader, className, imgClassName }: InstanceIconProps) {
  if (iconData?.startsWith('data:image/')) {
    return (
      <div className={cn('flex items-center justify-center overflow-hidden', className)}>
        <img src={iconData} alt="" className={cn('h-full w-full object-cover', imgClassName)} />
      </div>
    )
  }
  const name = (icon || getDefaultIcon(loader)).replace(/\.png$/i, '')
  const src = `/instances-icons/${name}.png`
  return (
    <div className={cn('flex items-center justify-center overflow-hidden', className)}>
      <img src={src} alt="" className={cn('h-full w-full object-cover', imgClassName)} />
    </div>
  )
}

export { ICON_NAMES }
