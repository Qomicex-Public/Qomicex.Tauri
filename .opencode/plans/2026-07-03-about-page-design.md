# About Page Design Spec

**Date**: 2026-07-03
**Status**: Draft

## Goal

Expand the existing "About" tab in `Settings.tsx` to include a comprehensive about page with version info, developer credits, frontend dependency attribution, and backend API service credits — matching the Avalonia version's about page plus extra sections. Designed for easy extension later.

## Scope

- Extend the `about` tab in `Settings.tsx` (not a standalone page)
- Add a separate data file `src/data/credits.ts` for all extensible content
- Chinese-only text for now (i18n-ready structure, i18n later)
- Use existing UI components (Card, Badge, Separator, Tooltip)

## Architecture

### Data File: `src/constants/credits.ts`

Centralized, typed data structure for all about page content. Adding a new contributor/dependency/service = adding one entry to the appropriate array.

```ts
export interface Contributor {
  name: string
  role: string
  url: string          // GitHub/profile URL
  github?: string      // GitHub username for avatar API lookup
}

export interface Dependency {
  name: string
  version: string      // from package.json
  url: string          // npm/homepage URL
  license: string
}

export interface CreditService {
  name: string
  description: string  // what it provides
  url: string
  icon?: string        // optional icon identifier
}

export interface LicenseInfo {
  name: string
  url: string
  file?: string        // path to bundled license file
}

export const APP_INFO = { name, version, description, techStack }
export const CONTRIBUTORS: Contributor[] = [...]
export const DEPENDENCIES: Record<string, Dependency[]> = { category: [...] }
export const SERVICES: CreditService[] = [...]
export const LICENSE: LicenseInfo = {...}
```

### GitHub Avatar Fetch

- Endpoint: `https://api.github.com/repos/lenmei233/Qomicex.Tauri/contributors`
- Trigger: when user enters the About tab
- Cache: module-level variable, persists for entire runtime session
- Matching: match `github` field against API response `login` field → get `avatar_url`
- Fallback chain: GitHub avatar → initial letter circle
- API rate limit: 60 requests/hour (unauthenticated), more than enough for one call per session

### UI Component: expanded About tab in `Settings.tsx`

Replace the current hardcoded `<Card>` (Settings.tsx:1072-1113) with a vertical scroll of sections:

| Section | Content | Data Source |
|---------|---------|-------------|
| Header | App logo, name, version, description | `APP_INFO` |
| Version Info | App version, system, arch, memory, React version | `APP_INFO` + `getSystemInfo()` API |
| Contributors | Avatar circle + name + role + link button | `CONTRIBUTORS` |
| Dependencies | Collapsible categories per dependency group | `DEPENDENCIES` |
| Credits | Service cards with name/description/link | `SERVICES` |
| License | License name + "View" button | `LICENSE` |

### Behaviors

- External links open via `openUrl()` from `@tauri-apps/plugin-opener` (existing pattern)
- System info fetched once on about tab mount via `getSystemInfo()` (existing API, already called by Settings.tsx)
- Dependency categories are collapsible (click to expand/collapse) to avoid overwhelming the user
- All text centralized in `credits.ts` — no JSX text literals beyond labels
- Contributor avatars fetched from GitHub API on About tab mount, cached for runtime session

### Files Changed

| File | Action |
|------|--------|
| `src/constants/credits.ts` | New — all about page data |
| `src/pages/Settings.tsx` | Modify — replace current About tab content with new sections |
| `src/components/ui/` | None — reuse existing Card, Badge, Separator |

### Dependencies to credit

**Core**: react, react-dom, react-router-dom, @tauri-apps/api, @tauri-apps/plugin-opener
**UI**: @radix-ui/*, tailwindcss, class-variance-authority, clsx, tailwind-merge, @fortawesome/*
**Animations**: gsap, @gsap/react
**Rendering**: react-markdown, rehype-raw, remark-gfm
**Gaming**: skinview3d
**APIs**: Modrinth, CurseForge, FTB, BMCLAPI, mcmod, Mojang

### Services to credit

| Service | Purpose | URL |
|---------|---------|-----|
| Modrinth | Mod/resource API | modrinth.com |
| CurseForge | Mod/resource API | curseforge.com |
| FTB | Modpack API | feed-the-beast.com |
| BMCLAPI | Mirror/download API | bmclapi2.bangbang93.com |
| mcmod | Chinese mod database | mcmod.cn |
| Mojang | Minecraft official | mojang.com |

### Contributors

| Name | Role | URL |
|------|------|-----|
| lenmei233 | Lead Developer | github.com/lenmei233 |
| TheMyceliumOfAntan | Contributor | github.com/TheMyceliumOfAntan |

## Out of Scope

- i18n (user said "后续完善i18n")
- Animated transitions between sections
- Update checker (not yet implemented in backend)
- Bundled local avatar files (avatars come from GitHub API)
- Clickable license text viewer

## Test Plan

1. Navigate to Settings → About tab — should show all sections
2. Click each external link — should open in system browser
3. Expand/collapse dependency categories — should toggle visibility
4. System info section should display OS/arch/memory from API
5. Contributor avatars load from GitHub API (online) or fall back to initial letter circle (offline)
6. No console errors
7. Pass `npx tsc --noEmit` with 0 errors
