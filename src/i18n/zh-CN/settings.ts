// 设置页（zh-CN；批0 含 category 导航 + appearance 外观核心项，其余由迁移批次补充）
export default {
  category: {
    launcher: '启动器',
    java: 'Java 运行时',
    plugins: '插件',
    appearance: '外观',
    toolbox: '工具箱',
    logs: '日志',
    about: '关于',
    debug: '调试',
  },
  appearance: {
    title: '界面',
    language: '界面语言',
    theme: '主题',
    dark: '深色',
    light: '亮色',
    animations: '页面动画',
    animationsDesc: '开启后页面切换、弹窗等带有过渡动画效果',
    animationSpeed: '动画速度',
    slow: '慢',
    normal: '正常',
    fast: '快',
    maxFrameRate: '帧率上限',
    maxFrameRateUnlimited: '不限',
    maxFrameRateDesc: '限制启动器界面的渲染帧率，降低资源占用。设为不限则使用显示器的原始刷新率。',
  },
} as const
