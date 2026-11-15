#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// scripts/pr-policy.mjs 的契约测试。
//
// 为什么需要它：策略校验直接阻断 PR，误判的代价是正常贡献被挡在门外。
// 这里钉住「合规样本必须零问题」与「每类格式违规必须被抓到」，改动规则时
// 先跑本测试再推。
//
// 运行：pnpm run test:pr-policy

import assert from 'node:assert/strict'

import { checkPr, checkSubject } from './pr-policy.mjs'

const TEMPLATE_BODY = `<!--
PR 模板 -->
## 变更类型 | Change Type

- [ ] 新功能 | New feature
- [x] 缺陷修复 | Bug fix

## 背景 / 根因 | Background / Root Cause

说明为什么改。

## 改动 | Change

说明改了什么。

## 验证 | Verification

- [x] \`cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml\`

## 风险 / 回滚 | Risk / Rollback

无。

## AI 使用披露 | AI Usage Disclosure

- 工具 / 模型 | Tool / model：Claude
- 生成范围 | Generated scope：测试与提交信息
- 人工验证方式 | Human verification：逐行 review
- 我确认能解释全部改动 | I can explain every change：是 Yes

## 关联 Issue | Related Issues

Closes #1

## 日志与附件 | Logs & Attachments

无。

## 提交前确认 | Checklist

- [x] 标题遵循 Conventional Commits
`

const COMPLIANT = {
  title: 'fix(instance): 修正存档列表判定',
  body: TEMPLATE_BODY,
  commits: ['fix(instance): 修正存档列表判定\n\n原因与验证见 PR。', 'Merge branch main into fix/x'],
}

const cases = []
const test = (name, fn) => cases.push([name, fn])

test('合规 PR 零问题', () => {
  assert.deepEqual(checkPr(COMPLIANT), [])
})

test('缺少类型前缀的标题被抓到', () => {
  const issues = checkPr({ ...COMPLIANT, title: '修正存档列表判定' })
  assert.equal(issues.length, 1)
  assert.match(issues[0], /PR 标题不符合 Conventional Commits/)
})

test('标题以句号结尾被抓到', () => {
  const issues = checkSubject('fix: 修正问题。', 'PR 标题')
  assert.equal(issues.length, 1)
  assert.match(issues[0], /句号/)
})

test('未知 type 被拒绝', () => {
  assert.equal(checkSubject('update: 更新依赖', 'PR 标题').length, 1)
})

test('scope 为空括号被拒绝', () => {
  assert.equal(checkSubject('fix(): 修正问题', 'PR 标题').length, 1)
})

test('正文为空被抓到', () => {
  const issues = checkPr({ title: COMPLIANT.title, body: '   ', commits: [] })
  assert.deepEqual(issues, ['PR 正文为空'])
})

test('缺少模板分节被抓到', () => {
  const issues = checkPr({ ...COMPLIANT, body: '## 变更类型\n\n- [x] 缺陷修复\n' })
  assert.ok(issues.some((issue) => issue.includes('缺少分节「背景/根因」')))
  assert.ok(issues.some((issue) => issue.includes('缺少分节「AI使用披露」')))
})

test('变更类型未勾选被抓到', () => {
  const body = TEMPLATE_BODY.replace('- [x] 缺陷修复 | Bug fix', '- [ ] 缺陷修复 | Bug fix')
  const issues = checkPr({ ...COMPLIANT, body })
  assert.ok(issues.some((issue) => issue.includes('至少勾选一项')))
})

test('只留模板空勾选项的验证段被抓到', () => {
  const body = TEMPLATE_BODY.replace(
    '- [x] `cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml`',
    '- [ ] `pnpm run typecheck`（前端改动 | frontend）',
  )
  const issues = checkPr({ ...COMPLIANT, body })
  assert.ok(issues.some((issue) => issue.includes('「验证」')))
})

test('验证段写「未运行」可通过', () => {
  const body = TEMPLATE_BODY.replace(
    '- [x] `cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml`',
    '未运行：仅改文档。',
  )
  assert.deepEqual(checkPr({ ...COMPLIANT, body }), [])
})

test('AI 披露缺字段被抓到', () => {
  const body = TEMPLATE_BODY.replace('- 生成范围 | Generated scope：测试与提交信息\n', '')
  const issues = checkPr({ ...COMPLIANT, body })
  assert.ok(issues.some((issue) => issue.includes('缺少字段「生成范围」')))
})

test('AI 披露字段留空被抓到', () => {
  const body = TEMPLATE_BODY.replace('人工验证方式 | Human verification：逐行 review', '人工验证方式 | Human verification：')
  const issues = checkPr({ ...COMPLIANT, body })
  assert.ok(issues.some((issue) => issue.includes('「人工验证方式」未填写')))
})

test('空分节被抓到', () => {
  const body = TEMPLATE_BODY.replace('说明改了什么。', '')
  const issues = checkPr({ ...COMPLIANT, body })
  assert.ok(issues.some((issue) => issue.includes('「改动」为空')))
})

test('提交信息不合规被抓到，merge 提交被跳过', () => {
  const issues = checkPr({ ...COMPLIANT, commits: ['更新文件', 'Merge pull request #9 from x/y'] })
  assert.equal(issues.length, 1)
  assert.match(issues[0], /提交信息不符合 Conventional Commits/)
})

test('子标题不会切断所属分节的内容', () => {
  const body = TEMPLATE_BODY.replace('说明改了什么。', '### 细节\n\n补充说明。')
  assert.deepEqual(checkPr({ ...COMPLIANT, body }), [])
})

test('未闭合的 HTML 注释不影响分节判定', () => {
  const body = `${TEMPLATE_BODY}\n<!-- 这条注释没有闭合`
  assert.deepEqual(checkPr({ ...COMPLIANT, body }), [])
})

test('注释内嵌套的 <!-- 整体被丢弃', () => {
  const body = TEMPLATE_BODY.replace(
    '说明。',
    '说明 <!-- 内层 <!-- 嵌套 --> 剩余文字',
  )
  assert.deepEqual(checkPr({ ...COMPLIANT, body }), [])
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n${error.message}`)
  }
}

if (failed > 0) {
  console.error(`\npr-policy: ${failed}/${cases.length} failed`)
  process.exit(1)
}
console.log(`\npr-policy: ${cases.length} passed`)
