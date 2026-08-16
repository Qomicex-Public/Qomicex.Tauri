export interface SystemInfo {
  osName: string
  os: string
  osVersion: string
  architecture: string
  osVersionId: string
  osDisplayName: string
  gitCommit: string
  memory: number
  availableMemory: number
}

export interface JavaRuntime {
  name: string
  path: string
  version: string
  versionID: number
  /** 后端实际序列化字段名（majorVersion）；versionID 为旧类型，运行时空值 */
  majorVersion?: number
  type: string
  arch: string
  state: string
  discoveredBy?: string
}

export interface JavaDownloadVendorInfo {
  id: string
  name: string
  platforms: string[]
  architectures: string[]
  versions: number[]
  isRecommended?: boolean
}

export interface JavaDownloadCatalogResponse {
  vendors: JavaDownloadVendorInfo[]
}

export interface JavaDownloadStartRequest {
  vendor: string
  version: number
  platform: string
  architecture: string
}

export interface JavaDownloadStartResponse {
  taskId: string
  status: string
  targetDir: string
}

export interface JavaDownloadProgressResponse {
  taskId: string
  status: string
  progress: number
  speed: number
  fileName: string
  targetDir: string
  error: string | null
}

export interface LauncherRequest {
  version: string
  gameDir: string
  maxMemory: string
  additionalParam?: string
  devideVersion: boolean
  accountName?: string
  accountUuid?: string
  accessToken?: string
  javaPath?: string
  javaVersionId: number
  launcherName?: string
}

export interface Account {
  name: string
  uuid: string
  token: string
  accessToken: string
  refreshToken: string
  loginMethod: string
  lastUsed?: number
  hasToken?: boolean
  isDefault?: boolean
  serverUrl?: string | null
}

export interface MicrosoftOAuthResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface YggdrasilLoginRequest {
  email: string
  password: string
  serverUrl: string
}

export interface YggdrasilAccount {
  name: string
  uuid: string
  accessToken: string
  clientToken: string
}

export interface YggdrasilProfileInfo {
  id: string
  name: string
}

export interface YggdrasilProfilesResponse {
  success: boolean
  accessToken?: string
  clientToken?: string
  profiles?: YggdrasilProfileInfo[]
  errorMessage?: string
}

export interface SuggestedSolution {
  title: string
  description: string
  action: string
}

export type IssueCategory =
  | 'Memory'
  | 'ModConflict'
  | 'JavaRelated'
  | 'Resource'
  | 'Performance'
  | 'Network'
  | 'Unknown'

export type IssueSeverity = 'Critical' | 'Error' | 'Warning' | 'Info'

export interface DetectedIssue {
  name: string
  patternId: string
  category: IssueCategory
  severity: IssueSeverity
  lineNumber: number
  matchedText: string
  capturedGroups: Record<string, string>
  solutions: SuggestedSolution[]
}

export interface LogAnalysisResult {
  isSuccess: boolean
  minecraftVersion: string | null
  modLoader: string | null
  loadedMods: string[]
  stackTrace: string | null
  rawLogExcerpt: string | null
  issues: DetectedIssue[]
  errorMessage: string | null
}

export interface CrashAnalysisResult {
  analysis: LogAnalysisResult
  mcloGsUrl: string | null
  qrCodeBase64: string | null
}

export interface CrashDialogState {
  instanceId: string
  title: string
  message: string
  detail?: string | null
  crashReport?: string | null
  args?: string | null
  analysis?: LogAnalysisResult | null
  mcloGsUrl?: string | null
  qrCodeBase64?: string | null
  loading: boolean
  error?: string
}

export interface ConnectorPlayer {
  name: string
  vendor: string
  iconBase64: string | null
  kind: 'host' | 'guest'
  machineId: string
}

/** 已踢玩家申请重新加入（房主弹窗三选：允许/拒绝/拒绝且不再提示）。 */
export interface KickReviewRequest {
  machineId: string
  name: string
  vendor: string
}

export interface ConnectorGameInfo {
  gameVersion: string
  loader: string | null
  loaderVersion: string | null
}

export interface ConnectorStatus {
  mode: 'idle' | 'starting' | 'host' | 'guest'
  roomCode: string | null
  mcHost: string | null
  mcPort: number | null
  gameInfo: ConnectorGameInfo | null
  players: ConnectorPlayer[]
  pendingKickReviews: KickReviewRequest[]
  kickedPlayers: KickReviewRequest[]
  error: string | null
}

export interface EasyTierStatus {
  installed: boolean
  status: 'idle' | 'resolving' | 'downloading' | 'extracting' | 'installed' | 'failed'
  progress: number
  speed: number
  error: string | null
}

export interface GameInstance {
  id: string
  name: string
  gameVersion: string
  loader: string | null
  loaderVersion: string | null
  javaPath: string | null
  maxMemory: number
  gameDir: string
  accountName: string | null
  accountUuid: string | null
  accessToken: string | null
  jvmArgs: string | null
  lastPlayed: string | null
  playTime: number
  isHidden: boolean
  versionIsolation: boolean | null
  isDefault: boolean
  icon: string | null
  iconData: string | null
  modpackName: string | null
  modpackVersion: string | null
  modpackAuthor: string | null
  modpackSummary: string | null
  skipIntegrityCheck?: boolean
  resolvedGameDir: string | null
  /** 所属自定义分组 id 列表（多对多） */
  customGroupIds?: string[]
}

export interface CreateInstanceRequest {
  name: string
  gameVersion: string
  loader?: string
  loaderVersion?: string
  javaPath?: string | null
  maxMemory: number
  gameDir: string
  accountName?: string
  accountUuid?: string
  accessToken?: string
  jvmArgs?: string
  versionIsolation?: boolean | null
  icon?: string
  skipIntegrityCheck?: boolean
  iconData?: string
  modpackName?: string
  modpackVersion?: string
  modpackAuthor?: string
  modpackSummary?: string
  /** 所属自定义分组 id 列表（多对多） */
  customGroupIds?: string[]
}

export interface LaunchResult {
  success: boolean
  processId: number
  error?: string | null
  detail?: string | null
  arguments?: string | null
  stage?: string | null
  missingFiles?: string[]
  exitCode?: number | null
  crashReport?: string | null
}

export interface LaunchProgress {
  stage: string
  message: string
  progress: number
  error?: string | null
  processId?: number | null
  exitCode?: number | null
  crashReport?: string | null
  missingFiles?: string[]
  arguments?: string | null
  isRunning: boolean
}

export interface ScannedVersionLoader {
  type: string
  version: string
}

export interface ScanVersionsResponse {
  path: string
  versions: ScannedVersion[]
  noJsonDirs: string[]
}

export interface ScannedVersion {
  name: string
  gameVersion: string
  state: string
  stateDescribe: string
  loaders: ScannedVersionLoader[]
  modpack?: {
    iconData?: string
    modpackName?: string
    modpackVersion?: string
    modpackAuthor?: string
    modpackSummary?: string
  } | null
}

export interface LoaderVersionInfo {
  type: number
  version: string
  minecraftVersion: string
  downloadUrl: string
  sha1: string
  isRecommended: boolean
  publishedAt: string | null
}

export interface LoaderAddonInfo {
  id: string
  label: string
  recommended: boolean
  description: string
  iconUrl: string
  projectUrl: string
  downloads: number
}

export interface MissingFile {
  name: string
  path: string
  url: string
  sha1: string
}

export interface VerifyResourcesResult {
  complete: boolean
  totalCount: number
  missingFiles: MissingFile[]
}

export interface RepairResourcesResult {
  status: string
  missingCount: number
}

export interface InstallProgressResponse {
  instanceId: string
  status: string
  stage: string
  progress: number
  error: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  currentFile: string
  currentFileProgress: number
  speed: number
  isPaused: boolean
}

export interface DownloadTask {
  id: string
  name: string
  type: 'game' | 'resource' | 'repair' | 'file' | 'batch' | 'java' | 'modpack'
  gameVersion: string
  loader?: string
  loaderVersion?: string
  addons?: string[]
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
  stage?: string
  progress: number
  speed?: number
  currentFile?: string
  totalFiles?: number
  completedFiles?: number
  /** 当前文件批次下载进度 0-100（按字节；仅下载阶段 > 0） */
  currentFileProgress?: number
  error?: string
  createdAt: string
  completedAt?: string
  icon?: string
  instanceId?: string
  /** for file downloads */
  taskId?: string
  /** for batch tasks - all child taskIds */
  batchTaskIds?: string[]
  /** for file downloads - bytes so far / total bytes */
  downloadedBytes?: number
  totalBytes?: number
}

export interface ResourceDownloadState {
  taskId: string
  url: string
  targetPath: string
  fileName: string
  progress: number
  speed: number
  status: string
  error?: string
  downloadedBytes: number
  totalBytes: number
  createdAt: string
}

export interface RemoteVersionInfo {
  id: string
  type: string
  releaseTime: string
  url: string
}

export interface ResourceItem {
  id: string
  title: string
  description: string
  author: string
  iconUrl: string
  downloadCount: number
  source: string
  categories: string[]
  projectUrl: string
  slug: string
  latestVersion: string
}

export interface ResourceDetail extends ResourceItem {
  body: string
}

export interface ResourceSearchResponse {
  items: ResourceItem[]
  total: number
  page: number
  pageSize: number
}

export interface ResourceFile {
  url: string
  fileName: string
  size: number
}

export interface FileEntry {
  name: string
  size: number
  lastModified: string
  isDirectory: boolean
  extension: string
}

export interface ModUpdateEntry {
  fileName: string
  name: string
  currentVersion: string
  latestVersion: string
  projectId: string
  source: string
  downloadUrl: string
  newFileName: string
}

export interface ModMetadata {
  fileName: string
  name: string
  version: string
  description: string
  authors: string[]
  iconUrl?: string | null
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  /** Modrinth 版本（文件）id（enrich 反查后填充） */
  modrinthVersionId?: string | null
  /** CurseForge 文件 id（enrich 反查后填充） */
  curseForgeFileId?: number | null
  source?: string | null
  mcmodId?: number | null
  chineseName?: string | null
  active: boolean
  fileSize?: number
  lastModified?: string
}

/** mods/enrich 返回条目（两段式第二步：按 fileName 合并 id 到列表） */
export interface ModEnrichEntry {
  fileName: string
  curseForgeId?: number | null
  modrinthId?: string | null
  modrinthVersionId?: string | null
  curseForgeFileId?: number | null
  source?: string | null
  /** 远程图标 URL（本地无图标时反查填充） */
  iconUrl?: string | null
  /** 远程项目名称（CF name / MR title） */
  name?: string | null
  /** mcmod.cn 中文名 */
  chineseName?: string | null
  /** mcmod.cn id */
  mcmodId?: number | null
}

export interface ResourcePackMetadata {
  fileName: string
  name: string
  description: string
  version: string
  packFormat: number
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}

export interface ShaderMetadata {
  fileName: string
  name: string
  description: string
  version: string
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}

export interface SaveMetadata {
  name: string
  filePath: string
  lastPlayed: number
  iconBase64?: string | null
}

/** 精选游戏规则子集（level.dat Data.GameRules，String "true"/"false"） */
export interface SaveGameRules {
  keepInventory: boolean
  doDaylightCycle: boolean
  doFireTick: boolean
  mobGriefing: boolean
  doMobSpawning: boolean
  doWeatherCycle: boolean
}

/** 存档设置（level.dat Data 精选白名单字段，与后端 LevelDatSettings 对应） */
export interface SaveSettings {
  levelName: string
  /** 0=生存 1=创造 2=冒险 3=旁观 */
  gameType: number
  /** 0=和平 1=简单 2=普通 3=困难 */
  difficulty: number
  allowCommands: boolean
  hardcore: boolean
  /** 世界时间（tick） */
  time: number
  /** 昼夜时间（0-24000） */
  dayTime: number
  raining: boolean
  thundering: boolean
  spawnX: number
  spawnY: number
  spawnZ: number
  randomSeed: number
  gameRules: SaveGameRules
}

export interface ScreenshotMetadata {
  fileName: string
  filePath: string
  createdAt: string
  fileSize: number
}

export interface DataPackMetadata {
  fileName: string
  name: string
  description: string
  version: string
  packFormat: number
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}

export interface ServerEntry {
  name: string
  ip: string
  iconBase64?: string | null
  acceptTextures?: boolean
}

export interface LanGameEntry {
  ip: string
  port: number
  motd: string
  worldName: string
  onlinePlayers: number
  maxPlayers: number
  gameVersion: string
}

export interface ServerState {
  name: string
  address: string
  isOnline: boolean
  ping: number
  onlinePlayers: number
  maxPlayers: number
  version: string
  description: string
  errorMessage: string
  iconBase64?: string | null
}

export interface ResourceVersion {
  id: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  downloads: ResourceFile[]
  dependencies: ModrinthDependency[]
  datePublished: string
}

export interface ModrinthDependency {
  versionId: string | null
  projectId: string
  fileName: string | null
  dependencyType: string
}

export interface ResolvedDependency {
  projectId: string
  name: string
  iconUrl: string
  versionId: string
  versionNumber: string
  downloadUrl: string
  fileName: string
  category: string
  source: string
}

export interface GameSettingDto {
  name: string
  defaultValue: string
  currentValue: string
  description: string
  validValuesRaw: string
  introducedVersion: string
  isAvailableInCurrentVersion: boolean
  valueKind: string
}

export interface ModpackFileEntry {
  path: string
  downloadUrl: string | null
  size: number | null
}

export interface ModpackParseResult {
  name: string
  summary: string | null
  author: string | null
  version: string | null
  gameVersion: string
  loader: string
  loaderVersion: string | null
  source: string
  files: ModpackFileEntry[]
  hasOverrides: boolean
  fileCount: number
  overridesZip: string | null
  iconData: string | null
  /** 本地导入：上传临时文件句柄，随 /modpack/install 传回 */
  fileId?: string | null
}

export interface ModpackInstallRequest {
  name: string
  gameVersion: string
  loader: string | null
  loaderVersion: string | null
  maxMemory?: number
  gameDir: string
  versionIsolation: boolean
  modpackFiles: ModpackFileEntry[]
  overridesZip: string | null
  iconData?: string | null
  modpackName?: string | null
  modpackVersion?: string | null
  modpackAuthor?: string | null
  modpackSummary?: string | null
  source?: string | null
  projectId?: string | null
  versionId?: string | null
  optifineVersion?: string | null
  /** 本地导入：parse 返回的临时文件句柄 */
  fileId?: string | null
}

export interface ModpackExportRequest {
  /** cf（CurseForge zip）或 mr（Modrinth mrpack） */
  format: 'cf' | 'mr'
  includeSaves?: boolean
  includeScreenshots?: boolean
}

export interface ModpackInstallDirectRequest {
  id: string
  type?: string
  projectId?: string
  fileId?: string
  path?: string
  gameDir: string
  versionIsolation?: boolean
  maxMemory?: number
}

export interface ModpackInstallDirectResult {
  instanceId: string
}

export interface NatTypeResult {
  type: 'cone' | 'symmetric' | 'blocked' | 'unknown'
  publicIp: string | null
  publicPort: number | null
}

export interface SkinProfile {
  profileId: string | null
  profileName: string | null
  skinUrl: string
  capeUrl: string | null
  model: string
  skinSource?: string
}

/** 微软披风（GET /minecraft/profile 的 capes 数组项）。 */
export interface McCape {
  id: string
  state: string
  alias?: string | null
}
