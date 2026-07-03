export interface Contributor {
  name: string
  role: string
  url: string
  avatar?: string
}

export interface Dependency {
  name: string
  version: string
  url: string
  license: string
}

export interface CreditService {
  name: string
  description: string
  url: string
  icon?: string
}

export interface LicenseInfo {
  name: string
  url: string
}

export const APP_INFO = {
  name: 'Qomicex Launcher',
  version: '0.1.0',
  description: '现代化的 Minecraft 游戏启动器',
  techStack: 'ASP.NET Core + React + Tauri',
}

export const CONTRIBUTORS: Contributor[] = [
  { name: 'lenmei233', role: '项目发起人 / 主要开发者', url: 'https://github.com/lenmei233', avatar: '/avatars/lenmei233.png' },
  { name: 'TheMyceliumOfAntan', role: '项目发起人 / 主要开发者', url: 'https://github.com/TheMyceliumOfAntan', avatar: '/avatars/TheMyceliumOfAntan.png' },
]

export const BACKEND_DEPENDENCIES: Record<string, Dependency[]> = {
  '.NET 与运行时': [
    { name: '.NET 10', version: '10.x', url: 'https://dotnet.microsoft.com', license: 'MIT' },
    { name: 'ASP.NET Core', version: '10.x', url: 'https://learn.microsoft.com/aspnet/core', license: 'MIT' },
  ],
  '核心库': [
    { name: 'Qomicex.Core', version: '内置', url: 'https://github.com/Qomicex-Public/Qomicex.Tauri', license: '自研' },
    { name: 'Qomicex.Downloader', version: '内置', url: 'https://github.com/Qomicex-Public/Qomicex.Tauri', license: '自研' },
  ],
}

export const DEPENDENCIES: Record<string, Dependency[]> = {
  '核心框架': [
    { name: 'react', version: '19.1.0', url: 'https://react.dev', license: 'MIT' },
    { name: 'react-dom', version: '19.1.0', url: 'https://react.dev', license: 'MIT' },
    { name: 'react-router-dom', version: '7.18.0', url: 'https://reactrouter.com', license: 'MIT' },
    { name: '@tauri-apps/api', version: '2.x', url: 'https://tauri.app', license: 'MIT' },
    { name: '@tauri-apps/plugin-opener', version: '2.x', url: 'https://tauri.app', license: 'MIT' },
    { name: '@tauri-apps/plugin-dialog', version: '2.7.1', url: 'https://tauri.app', license: 'MIT' },
  ],
  'UI 组件': [
    { name: '@radix-ui/react-checkbox', version: '1.3.5', url: 'https://radix-ui.com', license: 'MIT' },
    { name: '@radix-ui/react-slot', version: '1.3.0', url: 'https://radix-ui.com', license: 'MIT' },
    { name: '@fortawesome/free-solid-svg-icons', version: '7.2.0', url: 'https://fontawesome.com', license: 'MIT' },
    { name: '@fortawesome/free-brands-svg-icons', version: '7.2.0', url: 'https://fontawesome.com', license: 'MIT' },
    { name: '@fortawesome/react-fontawesome', version: '3.3.1', url: 'https://fontawesome.com', license: 'MIT' },
  ],
  '样式与工具': [
    { name: 'tailwindcss', version: '3.4.19', url: 'https://tailwindcss.com', license: 'MIT' },
    { name: 'class-variance-authority', version: '0.7.1', url: 'https://cva.style', license: 'MIT' },
    { name: 'clsx', version: '2.1.1', url: 'https://github.com/lukeed/clsx', license: 'MIT' },
    { name: 'tailwind-merge', version: '3.6.0', url: 'https://github.com/dcastil/tailwind-merge', license: 'MIT' },
  ],
  '动画': [
    { name: 'gsap', version: '3.15.0', url: 'https://gsap.com', license: 'see site' },
    { name: '@gsap/react', version: '2.1.2', url: 'https://gsap.com', license: 'see site' },
  ],
  '渲染与展示': [
    { name: 'react-markdown', version: '10.1.0', url: 'https://github.com/remarkjs/react-markdown', license: 'MIT' },
    { name: 'rehype-raw', version: '7.0.0', url: 'https://github.com/rehypejs/rehype-raw', license: 'MIT' },
    { name: 'remark-gfm', version: '4.0.1', url: 'https://github.com/remarkjs/remark-gfm', license: 'MIT' },
    { name: 'skinview3d', version: '3.4.2', url: 'https://github.com/bs-community/skinview3d', license: 'MIT' },
  ],
}

export const SERVICES: CreditService[] = [
  { name: 'Modrinth', description: 'Mod 和资源搜索 API', url: 'https://modrinth.com', icon: '/services/modrinth.svg' },
  { name: 'CurseForge', description: 'Mod 和资源搜索 API', url: 'https://www.curseforge.com', icon: '/services/curseforge.png' },
  { name: 'FTB', description: '整合包 API', url: 'https://www.feed-the-beast.com', icon: '/services/ftb.png' },
  { name: 'bangbang93', description: '提供BMCLAPI下载镜像服务', url: 'https://bmclapi2.bangbang93.com', icon: '/services/bangbang93.png' },
  { name: 'mcmod', description: '中文 Mod 数据库', url: 'https://www.mcmod.cn', icon: '/services/mcmod.png' },
  { name: 'Minecraft官网', description: 'Minecraft 官方网站,支持正版!', url: 'https://www.minecraft.net', icon: '/services/minecraft.png' },
]

export const LICENSE: LicenseInfo = {
  name: 'GPL-3.0 License',
  url: 'https://www.gnu.org/licenses/gpl-3.0.en.html',
}

export const REPOSITORY_URL = 'https://github.com/lenmei233/Qomicex.Tauri'

export interface ReferenceProject {
  name: string
  url: string
  description: string
}

export const REFERENCE_PROJECTS: ReferenceProject[] = [
  { name: 'HMCL', url: 'https://github.com/HMCL-dev/HMCL/tree/main', description: '版本检测参考' },
  { name: 'ProjBobcat', url: 'https://github.com/Corona-Studio/ProjBobcat', description: 'ModLoader 安装器参考' },
  { name: 'PCL', url: 'https://github.com/Meloong-Git/PCL', description: '启动流程参考' },
]

