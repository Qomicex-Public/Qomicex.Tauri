import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

const TS_FILES = ['**/*.{ts,tsx,mts,cts}']
const SCRIPT_FILES = ['**/*.{js,mjs,cjs}']

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/target/**',
      '**/node_modules/**',
      '**/.git/**',
      'docs/**',
      'public/**',
      'plugins-dev/**',
      'promo-video/**',
      'video-assets/**',
      '.shots-home/**',
      'build-test/**',
      'packages/qomicex-cli/templates/**',
      // gitignore 的本地运行时残留；其中那个 NTFS 保留名目录会让 ESLint 遍历 ENOENT。
      'src-backend/Qomicex.Launcher.Backend.Neo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: TS_FILES,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // React 规则取稳定子集；react-hooks v7 的 compiler 系规则（static-components/
      // use-memo/immutability 等）暂不启用，见 AGENTS.md「Lint 现状」。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Vite Fast Refresh：对 barrel/store 文件噪音过大，暂关。
      'react-refresh/only-export-components': 'off',
      // 项目有意使用 console.warn/console.error（见 src/App.tsx 日志桥），其余级别视为调试残留。
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      // tsc 的 noUnusedLocals/noUnusedParameters 已覆盖，避免同一问题重复报两次。
      '@typescript-eslint/no-unused-vars': 'off',
      // 历史存量 39 处，清理后升为 error（见 AGENTS.md「Lint 现状」）。
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: SCRIPT_FILES,
    // harness 脚本的 page.evaluate 回调里会用到浏览器全局（document/window）。
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // CLI 的职责就是往终端输出，console 是其对用户的唯一界面（info/warn/fail 封装）。
    files: ['packages/qomicex-cli/src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // 必须放在最后：关闭所有与 Prettier 排版冲突的 stylistic 规则。
  prettier,
)
