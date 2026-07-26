// scripts/generate-changelog.mjs
// 根据当前版本和发布类型，从 git 提交历史自动生成 changelog
// 用法: node scripts/generate-changelog.mjs <versionTag> <releaseType> [outputFile]

import { execSync } from "child_process";
import { writeFileSync } from "fs";

const [vtag, releaseType, outputFile = "RELEASE_NOTES.md"] = process.argv.slice(2);

if (!vtag || !releaseType) {
  console.error("用法: node generate-changelog.mjs <versionTag> <releaseType> [outputFile]");
  process.exit(1);
}

const typeLabel = { alpha: "Alpha", beta: "Beta", release: "Release" }[releaseType] || releaseType;

/** 从 tag 名中提取发布类型 */
function tagReleaseType(tag) {
  if (/alpha\d{8}\.\d+$/.test(tag)) return "alpha";
  if (/alpha\d{6}\.build\d+$/.test(tag)) return "alpha";
  if (/beta\d+\.\d+$/.test(tag)) return "beta";
  return "release";
}

/** 查找同类型的前一个 tag */
function findPrevTag(currentTag, rtype) {
  const tags = execSync("git tag --sort=-creatordate", { encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  let found = false;
  for (const tag of tags) {
    if (found && tagReleaseType(tag) === rtype) {
      return tag;
    }
    if (tag === currentTag) {
      found = true;
    }
  }
  // 当前 tag 尚未创建（CI 中 changelog 在 tag 推送之前生成）
  // 返回最新的同类型 tag 作为 prev
  if (!found) {
    for (const tag of tags) {
      if (tagReleaseType(tag) === rtype) return tag;
    }
  }
  return null;
}

/** 获取两个 tag 之间的提交消息，按 convention 分组 */
function getCommitsBetween(prev, current) {
  const range = prev ? `${prev}..${current}` : current;
  let raw;
  try {
    raw = execSync(`git log --format="%s" --no-merges ${range}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    if (!prev && current.startsWith("v")) {
      console.error(`tag ${current} 不在本地，回退到 git log HEAD`);
      raw = execSync(`git log --format="%s" --no-merges HEAD`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    } else if (prev && current.startsWith("v")) {
      console.error(`tag ${current} 不在本地，回退到 git log ${prev}..HEAD`);
      raw = execSync(`git log --format="%s" --no-merges ${prev}..HEAD`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    } else {
      throw e;
    }
  }
  return raw.trim().split("\n").filter(Boolean);
}

/** 按 conventional commit 标签分组 */
const CATEGORIES = {
  feat: { emoji: "✨", title: "新增功能" },
  fix: { emoji: "🐛", title: "修复" },
  refactor: { emoji: "🔧", title: "重构" },
  perf: { emoji: "⚡", title: "性能优化" },
};

const SKIP_TYPES = new Set(["ci", "build", "chore", "docs", "style", "test"]);

function classifyCommit(msg) {
  const match = msg.match(/^(\w+)(\([^)]*\))?!?:\s*(.+)/);
  if (!match) return null;
  let [, type, , desc] = match;
  if (type === "checkpoint") type = "fix";
  if (SKIP_TYPES.has(type)) return null;
  return { type: type in CATEGORIES ? type : null, desc };
}

function formatChangelog(version, rtype, commits) {
  const lines = [`## Qomicex Launcher ${version}`, ``, `**${typeLabel} 版本**`, ``, `---`, ``];

  if (commits.length === 0) {
    lines.push("*（仅构建变更，无代码改动）*");
    return lines.join("\n");
  }

  const grouped = {};
  for (const c of commits) {
    const classified = classifyCommit(c);
    if (!classified) continue;
    const { type, desc } = classified;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(desc);
  }

  const order = ["feat", "fix", "refactor", "perf"];

  for (const key of order) {
    if (!grouped[key] || grouped[key].length === 0) continue;
    const cat = CATEGORIES[key] || { emoji: "", title: key };
    lines.push(`#### ${cat.emoji} ${cat.title}`);
    lines.push("");
    for (const desc of grouped[key]) {
      lines.push(`- ${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const prev = findPrevTag(vtag, releaseType);
console.error(`当前: ${vtag}, 前一个同类型: ${prev || "(无)"}`);

const commits = getCommitsBetween(prev, vtag);
console.error(`找到 ${commits.length} 条提交`);

const body = formatChangelog(vtag, releaseType, commits);
writeFileSync(outputFile, body, "utf-8");
console.error(`已写入 ${outputFile}`);
