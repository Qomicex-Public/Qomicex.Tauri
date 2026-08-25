// CLI 通用 IO：输出 / 退出 / 子进程。
import { spawn } from 'node:child_process'

export function info(msg: string): void {
  console.log(msg)
}

export function warn(msg: string): void {
  console.warn(`⚠  ${msg}`)
}

export function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 以 shell 方式运行命令（继承 stdio），返回退出码。Windows/Linux/macOS 通用。 */
export function runShell(cmdLine: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmdLine, { cwd, stdio: 'inherit', shell: true })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** 非交互确认：默认 N，回答 y/yes 才放行。 */
export async function confirm(question: string, yesFlag: boolean): Promise<boolean> {
  if (yesFlag) return true
  process.stdout.write(`${question} [y/N] `)
  return await new Promise<boolean>((resolve) => {
    process.stdin.once('data', (d) => {
      const a = d.toString().trim().toLowerCase()
      resolve(a === 'y' || a === 'yes')
    })
  })
}
