//! 账号持久化服务（对应源 Services/AccountService.cs + Services/CryptHelper.cs）。
//!
//! ⚠️ 范围说明：源 `AccountService.cs` 的全部公开成员都是**账号存储的 CRUD 与默认账号
//! 管理**（登录/刷新/皮肤头像逻辑其实在 `Endpoints/AuthEndpoints.cs`，不在本文件，
//! 属后端路由层，非本次移植范围）。本文件逐字对应源 AccountService 的公开成员。
//! 源方法经 `qomicex_core::GameCore` 的 auth 提供方的调用路径本文件全部不涉及——
//! 源 AccountService 完全不引用 GameCore，仅借助 CryptHelper 对 accounts.dat 加解密。
//!
//! 持久化：源写 `{BaseDir}/data/accounts.dat`（CryptHelper AES-GCM 加密 + base64）。
//! 任务定案本 Rust 模块改存 `{BaseDir}/data/accounts.json`（明文 JSON），加解密暂用
//! no-op 占位（详见 `crypt` 子模块头注释的密码学缺口说明）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{ApiError, ApiResult};
use crate::settings::resolve_base_dir;

/// 存储的账号（源：StoredAccount，camelCase，随 accounts 列出）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub login_method: String,
    #[serde(default)]
    pub last_used: i64,
    #[serde(default)]
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
}

impl StoredAccount {
    /// 生成对外响应的 AccountInfo（源 `GetAccountsAsync` 的 Select 映射）。
    fn to_info(&self) -> AccountInfo {
        AccountInfo {
            name: self.name.clone(),
            uuid: self.uuid.clone(),
            token: self.token.clone(),
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            login_method: self.login_method.clone(),
            last_used: self.last_used,
            has_token: !self.access_token.is_empty(),
            is_default: self.is_default,
            server_url: self.server_url.clone(),
        }
    }
}

/// 对外账号信息 DTO（源：AccountInfo）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub name: String,
    pub uuid: String,
    pub token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub login_method: String,
    pub last_used: i64,
    pub has_token: bool,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
}

/// 内部状态：缓存 + 「账号曾丢失」标志（源字段 `_cache` / `_accountsWereLost`）。
struct Inner {
    cache: Option<Vec<StoredAccount>>,
    accounts_were_lost: bool,
}

pub struct AccountService {
    file_path: PathBuf,
    /// 源 `SemaphoreSlim(1,1)` → `tokio::sync::Mutex`（异步下 await 安全，串行化同语义）。
    lock: Mutex<Inner>,
}

impl AccountService {
    /// 构造（源无参构造）：`{BaseDir}/data/`，确保目录存在，`_filePath = {dataDir}/accounts.json`。
    pub fn new() -> Result<Self, ApiError> {
        let data_dir = resolve_base_dir().join("data");
        std::fs::create_dir_all(&data_dir).map_err(ApiError::from)?;
        let file_path = data_dir.join("accounts.json");
        Ok(Self {
            file_path,
            lock: Mutex::new(Inner {
                cache: None,
                accounts_were_lost: false,
            }),
        })
    }

    /// 列出全部账号（源 `GetAccountsAsync`）。返回 AccountInfo 列表。
    pub async fn get_accounts(&self) -> ApiResult<Vec<AccountInfo>> {
        Ok(self
            .load()
            .await?
            .iter()
            .map(StoredAccount::to_info)
            .collect())
    }

    /// 取出并清除「账号曾丢失」标志（源 `CheckAccountsLost`）。
    pub async fn check_accounts_lost(&self) -> bool {
        let mut inner = self.lock.lock().await;
        let v = inner.accounts_were_lost;
        inner.accounts_were_lost = false;
        v
    }

    /// 按 uuid 取账号（源 `GetAccountAsync`）。
    pub async fn get_account(&self, uuid: &str) -> ApiResult<Option<StoredAccount>> {
        Ok(self.load().await?.into_iter().find(|a| a.uuid == uuid))
    }

    /// 取默认账号（源 `GetDefaultAsync`）。
    pub async fn get_default(&self) -> ApiResult<Option<StoredAccount>> {
        Ok(self.load().await?.into_iter().find(|a| a.is_default))
    }

    /// 设为默认：清掉其他账号的 IsDefault（源 `SetDefaultAsync`；uuid 不存在则空操作）。
    pub async fn set_default(&self, uuid: &str) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        let has = accounts.iter().any(|a| a.uuid == uuid);
        if !has {
            return Ok(());
        }
        for a in accounts.iter_mut() {
            a.is_default = a.uuid == uuid;
        }
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 清除所有默认标记（源 `ClearDefaultAsync`）。
    pub async fn clear_default(&self) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        for a in accounts.iter_mut() {
            a.is_default = false;
        }
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 保存并自动处理默认账号（源 `AutoSetDefaultOnSaveAsync`）。
    /// `isNew` 时：若当前无默认则置为默认，否则按 uuid 替换（同时刷新 LastUsed）。
    pub async fn auto_set_default_on_save(&self, account: &mut StoredAccount) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        let is_new = !accounts.iter().any(|a| a.uuid == account.uuid);
        account.last_used = now_unix();
        if is_new {
            account.is_default = !accounts.iter().any(|a| a.is_default);
            accounts.push(account.clone());
        } else if let Some(idx) = accounts.iter().position(|a| a.uuid == account.uuid) {
            accounts[idx] = account.clone();
        }
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 删除后自动重指派默认（源 `AutoReassignDefaultOnDeleteAsync`）。
    /// 删除 uuid；若删除后无默认且仍存在账号，则把第一个置为默认。
    pub async fn auto_reassign_default_on_delete(&self, deleted_uuid: &str) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        accounts.retain(|a| a.uuid != deleted_uuid);
        if !accounts.iter().any(|a| a.is_default) && !accounts.is_empty() {
            accounts[0].is_default = true;
        }
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 保存账号：存在则替换，否则追加；刷新 LastUsed（源 `SaveAccountAsync`）。
    pub async fn save_account(&self, account: &mut StoredAccount) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        account.last_used = now_unix();
        if let Some(idx) = accounts.iter().position(|a| a.uuid == account.uuid) {
            accounts[idx] = account.clone();
        } else {
            accounts.push(account.clone());
        }
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 删除账号（源 `DeleteAccountAsync`）。
    pub async fn delete_account(&self, uuid: &str) -> ApiResult<()> {
        let mut inner = self.lock.lock().await;
        let mut accounts = read_or_cached(&mut inner, &self.file_path).await?;
        accounts.retain(|a| a.uuid != uuid);
        self.write_file(&accounts).await?;
        inner.cache = Some(accounts);
        Ok(())
    }

    /// 加载账号（源 `LoadAsync`）：缓存命中直接用，否则按锁内读文件并回填缓存。
    async fn load(&self) -> ApiResult<Vec<StoredAccount>> {
        let mut inner = self.lock.lock().await;
        if let Some(cache) = &inner.cache {
            return Ok(cache.clone());
        }
        let accounts = read_or_cached(&mut inner, &self.file_path).await?;
        Ok(accounts)
    }

    /// 写文件（源 `WriteFileAsync`）：JSON 序列化 → accounts.json。
    async fn write_file(&self, accounts: &[StoredAccount]) -> ApiResult<()> {
        let json = serde_json::to_vec(accounts).map_err(|e| ApiError::internal(e.to_string()))?;
        tokio::fs::write(&self.file_path, json).await?;
        Ok(())
    }
}

/// 读文件（源 `ReadFileAsync`，须调用方已持有 `self.lock`）。文件缺失返回空表。
///
/// 差异假设：源区分「解密失败(CryptographicException) → 置 lost+删除+重建」与
/// 「其他异常 → 仅返回空表」。本模块无加解密，等价转译为「JSON 解析/读取失败 →
/// 置 lost 标志、删除损坏文件并重建」（保留数据自愈意图）。
async fn read_file(file_path: &std::path::Path) -> ApiResult<(Vec<StoredAccount>, bool)> {
    let content = match tokio::fs::read_to_string(file_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(_) => {
            let _ = tokio::fs::remove_file(file_path).await;
            return Ok((Vec::new(), true));
        }
    };
    match serde_json::from_str::<Vec<StoredAccount>>(&content) {
        Ok(accounts) => Ok((accounts, false)),
        Err(_) => {
            let _ = tokio::fs::remove_file(file_path).await;
            Ok((Vec::new(), true))
        }
    }
}

/// 取缓存，命中则克隆；否则读文件并在缓存/ lost 标志上做记录（`source._cache ?? ReadFileAsync`）。
async fn read_or_cached(
    inner: &mut Inner,
    file_path: &std::path::Path,
) -> ApiResult<Vec<StoredAccount>> {
    if let Some(cache) = &inner.cache {
        return Ok(cache.clone());
    }
    let (accounts, lost) = read_file(file_path).await?;
    if lost {
        inner.accounts_were_lost = true;
    }
    inner.cache = Some(accounts.clone());
    Ok(accounts)
}

impl Default for AccountService {
    fn default() -> Self {
        // 无失败路径兜底：走 new()，失败时用临时文件路径（实际会被后续读写覆盖/报错）。
        Self::new().unwrap_or_else(|_| Self {
            file_path: std::env::temp_dir().join("accounts-fallback.json"),
            lock: Mutex::new(Inner {
                cache: None,
                accounts_were_lost: false,
            }),
        })
    }
}

/// 当前 Unix 时间戳（源 `DateTimeOffset.UtcNow.ToUnixTimeSeconds()`）。
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 加解密占位（源 CryptHelper.cs 的简化）。
///
/// ⚠️ 密码学方案缺口（请主控定夺）：
/// - 源 `CryptHelper.EncryptToBase64/DecryptFromBase64` 使用
///   AES-GCM（TagSize=16）+ PBKDF2（SHA256, 100k iter）+ HKDF-SHA256 派生 enc/cmt 双密钥
///   + HMAC 承诺 + 机器码派生；本模块当前为 **no-op 明文透传占位**，并未写入 accounts.json。
/// - 若要恢复到源同等安全，推荐引入 `aes-gcm` + `hkdf` + `pbkdf2`（或单一 `ring`/`crypto`）
///   按 CryptHelper 的 v1 头格式（version/salt/nonce/tag/commitment/len/ciphertext）实现。
///   此占位仅保证「接口形态」与源对齐，暂不影响功能（账号文件为明文 JSON）。
fn _crypt_placeholder_open() {}
