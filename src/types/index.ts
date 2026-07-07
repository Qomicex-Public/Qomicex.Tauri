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

export interface RoomCodeResponse {
  code: string
}

export interface ConnectorPlayer {
  name: string
  vendor: string
  iconBase64: string | null
  kind: 'host' | 'guest'
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
  versionDirName: string | null
  isDefault: boolean
  icon: string | null
  skipIntegrityCheck?: boolean
  resolvedGameDir: string | null
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

export interface ScannedVersion {
  name: string
  gameVersion: string
  state: string
  stateDescribe: string
  loaders: ScannedVersionLoader[]
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
  progress: number
  error: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  currentFile: string
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
  error?: string
  createdAt: string
  completedAt?: string
  instanceId?: string
  /** for file downloads */
  taskId?: string
  /** for batch tasks - all child taskIds */
  batchTaskIds?: string[]
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
  filename: string
  size: number
}

export interface FileEntry {
  name: string
  size: number
  lastModified: string
  isDirectory: boolean
  extension: string
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
  source?: string | null
  mcmodId?: number | null
  chineseName?: string | null
  active: boolean
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
}

export interface GameSettingDto {
  name: string
  defaultValue: string
  currentValue: string
  description: string
  validValues: string
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
  gameVersion: string
  loader: string
  loaderVersion: string | null
  source: string
  files: ModpackFileEntry[]
  hasOverrides: boolean
  fileCount: number
  overridesZip: string | null
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
}

export interface SkinProfile {
  profileId: string | null
  profileName: string | null
  skinUrl: string
  capeUrl: string | null
  model: string
  skinSource?: string
}
