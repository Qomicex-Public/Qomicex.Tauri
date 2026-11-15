#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// PR 格式策略校验（.github/workflows/pr-policy.yml 调用）。
//
// 只校验格式：PR 标题与提交首行的 Conventional Commits 结构、PR 正文里
// .github/PULL_REQUEST_TEMPLATE.md 的九个分节与必填字段是否填了。
// 不校验内容（禁用词、措辞、emoji、验证命令是否真实），避免误伤正常提交。
//
// 用法：node scripts/pr-policy.mjs < input.json
//   input.json: {"title": "...", "body": "...", "commits": ["提交信息", ...]}
// 有问题逐条打印并以 1 退出；通过则输出一行 OK 并以 0 退出。

import { pathToFileURL } from 'node:url'

const TYPES = [
  'feat',
  'fix',
  'build',
  'chore',
  'ci',
  'docs',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]

// 标题：type(scope)!: summary。scope 不允许空括号或含空格。
const SUBJECT_RE = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s]+\\))?!?: \\S`)
const MERGE_RE = /^Merge (pull request|branch|remote-tracking|commit)\b/

// 模板分节（取「中文名 | English」的中文侧；比对时忽略空格）
const SECTIONS = [
  '变更类型',
  '背景/根因',
  '改动',
  '验证',
  '风险/回滚',
  'AI使用披露',
  '关联Issue',
  '日志与附件',
  '提交前确认',
]

// AI 披露四个字段（AI_POLICY.md「必须披露」）
const DISCLOSURE_FIELDS = ['工具', '生成范围', '人工验证方式', '我确认能解释']

const normalize = (text) => text.replace(/\s+/g, '')

/** 去掉 HTML 注释（模板里的填写说明），保留换行位置 */
const stripComments = (body) => body.replace(/<!--[\s\S]*?-->/g, '')

/**
 * 按 `## ` 二级标题切分正文。`###` 视为正文内容，避免用户写子标题时把
 * 所属分节的内容切走。返回 Map<归一化标题, 该节正文行数组>。
 */
function splitSections(body) {
  const sections = new Map()
  let current = null
  for (const line of stripComments(body).split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      current = normalize(heading[1].split('|')[0])
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current) sections.get(current).push(line)
  }
  return sections
}

/** 分节里的实质内容：非空行，且不是模板自带的 `- [ ] 命令` 勾选项 */
function meaningfulLines(lines) {
  return lines.filter((line) => line.trim() && !/^-\s*\[[ xX]\]/.test(line.trim()))
}

const hasCheckedBox = (lines) => lines.some((line) => /^-\s*\[[xX]\]/.test(line.trim()))

/** 标题行是否符合 Conventional Commits（含 summary 非空、结尾无句号） */
export function checkSubject(subject, label) {
  const issues = []
  if (!SUBJECT_RE.test(subject)) {
    issues.push(`${label}不符合 Conventional Commits（type(scope): summary，type 取 ${TYPES.join('/')}）：${subject}`)
  } else if (/[.．。]\s*$/.test(subject)) {
    issues.push(`${label}的 summary 不要以句号结尾：${subject}`)
  }
  return issues
}

function checkBody(body) {
  const issues = []
  const sections = splitSections(body)

  for (const name of SECTIONS) {
    if (!sections.has(name)) {
      issues.push(`PR 正文缺少分节「${name}」，请按 .github/PULL_REQUEST_TEMPLATE.md 填写`)
    }
  }

  const changeTypes = sections.get('变更类型')
  if (changeTypes && !hasCheckedBox(changeTypes)) {
    issues.push('PR 正文的「变更类型」至少勾选一项（- [x]）')
  }

  for (const name of SECTIONS) {
    const lines = sections.get(name)
    if (!lines || name === '变更类型' || name === '提交前确认') continue
    if (name === '验证') {
      // 允许不跑命令，但必须勾一项或写一句说明（不能只留模板里的空勾选项）
      if (!hasCheckedBox(lines) && meaningfulLines(lines).length === 0) {
        issues.push('PR 正文的「验证」要么勾选实际跑过的项，要么写明「未运行」及原因')
      }
      continue
    }
    if (meaningfulLines(lines).length === 0) {
      issues.push(`PR 正文的「${name}」为空，请填写`)
    }
  }

  const disclosure = sections.get('AI使用披露')
  if (disclosure) {
    const text = disclosure.join('\n')
    for (const field of DISCLOSURE_FIELDS) {
      const line = text
        .split(/\r?\n/)
        .find((candidate) => normalize(candidate).includes(normalize(field)))
      const value = line?.split(/[:：]/).slice(1).join(':').trim()
      if (!line) {
        issues.push(`「AI 使用披露」缺少字段「${field}」`)
      } else if (!value) {
        issues.push(`「AI 使用披露」的「${field}」未填写`)
      }
    }
  }

  return issues
}

/** 校验一个 PR：标题、正文、提交信息。返回问题列表（空数组 = 通过） */
export function checkPr({ title, body, commits = [] }) {
  const issues = []
  issues.push(...checkSubject((title ?? '').trim(), 'PR 标题'))
  if (!(body ?? '').trim()) {
    issues.push('PR 正文为空')
  } else {
    issues.push(...checkBody(body))
  }
  for (const message of commits) {
    const firstLine = (message ?? '').split(/\r?\n/, 1)[0].trim()
    if (!firstLine || MERGE_RE.test(firstLine)) continue
    issues.push(...checkSubject(firstLine, '提交信息'))
  }
  return issues
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    console.error('用法：node scripts/pr-policy.mjs < input.json')
    process.exit(2)
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    console.error(`输入不是合法 JSON：${error.message}`)
    process.exit(2)
  }

  const issues = checkPr(payload)
  if (issues.length > 0) {
    console.error(`PR 格式校验未通过（${issues.length} 项）：`)
    for (const issue of issues) console.error(`- ${issue}`)
    console.error('如为维护者且确需豁免，请给该 PR 添加 policy: skip 标签。')
    process.exit(1)
  }
  console.log('PR 格式校验通过。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
