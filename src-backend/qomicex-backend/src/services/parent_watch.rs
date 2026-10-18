// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 父进程存活性看护。
//!
//! 后端由启动器 spawn，正常情况下启动器在 `RunEvent::Exit` 里 kill 它。但那条路径
//! 只在**优雅退出**时走到：任务管理器结束、崩溃、OOM、`kill -9`、更新器替换进程等
//! 情况父进程直接消失，没有任何人回收后端 —— 每遇到一次就多一个僵尸后端。堆积之后
//! 新启的启动器连不上自己的管道（`IPC_CONNECT_FAILED: 系统找不到指定的文件`），
//! 所有 API 502，表现为「点历史却进了新对话」这类诡异现象。
//!
//! 因此后端自己也要知道「父进程没了」，不能只依赖被 kill。
//!
//! 判据都用「启动器注入的 pid」而不是系统报告的 ppid：
//! - 注入值才是确定的身份。系统侧的 ppid 在父进程退出后**不会更新**（Windows）或在
//!   subreaper 环境下被改指到别的进程（Linux systemd 会话），两者都会让「父进程还在」
//!   的判断变成假阳性 —— 那意味着后端永远不会退出，正是本模块要修的问题。
//! - Windows：`WaitForSingleObject(handle, 0)`。**不用** `GetExitCodeProcess` 的
//!   `STILL_ACTIVE`(259)：进程可以合法地以 259 退出，那个判据有歧义。
//! - Unix：`getppid()` 与注入值比较；不一致即原父进程已退出（被收养）。

/// 注入的父进程 pid（`QOMICEX_PARENT_PID`）。未注入返回 `None`。
pub fn expected_parent_pid() -> Option<u32> {
    std::env::var("QOMICEX_PARENT_PID")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
}

/// 父进程是否仍在运行。取不到注入值或探测失败时保守返回 `true`（不误杀）。
pub fn parent_alive() -> bool {
    let Some(expected) = expected_parent_pid() else {
        return true;
    };
    #[cfg(windows)]
    {
        windows_parent_alive(expected)
    }
    #[cfg(unix)]
    {
        unix_parent_alive(expected)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = expected;
        true
    }
}

#[cfg(windows)]
fn windows_parent_alive(expected_pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

    // SAFETY: OpenProcess 失败返回 0，据此提前返回；成功时与 CloseHandle 配对。
    // WaitForSingleObject 仅在句柄有效时调用，零超时无阻塞。
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, expected_pid);
        if handle == 0 {
            // 打不开：父进程已不存在（或用其他身份创建，权限不足）。
            // 后者按「已退出」处理会误杀高权限父进程的子进程，故用错误码区分。
            const ERROR_ACCESS_DENIED: i32 = 5;
            return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED);
        }
        // WAIT_OBJECT_0 = 已终止；WAIT_TIMEOUT = 仍在运行。
        // 259 退出码在 WAIT_OBJECT_0 面前不构成歧义，这正是换掉 GetExitCodeProcess 的原因。
        let wait = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        match wait {
            WAIT_OBJECT_0 => false,
            WAIT_TIMEOUT => true,
            // 其它（WAIT_FAILED 等）按存活处理，避免误杀
            _ => true,
        }
    }
}

#[cfg(unix)]
fn unix_parent_alive(expected_pid: u32) -> bool {
    unsafe extern "C" {
        fn getppid() -> i32;
    }
    // SAFETY: getppid 无参数、无副作用、总是成功。
    let ppid = unsafe { getppid() };
    // 与注入值比较，而不是「ppid > 1」：systemd 会话等 subreaper 环境下，孤儿进程会被
    // 收养到 PID 大于 1 的进程，此时 ppid 仍 > 1，旧判据会一直认为父进程还活着。
    ppid > 0 && ppid as u32 == expected_pid
}

/// 后台看护：父进程消失时执行 `on_parent_gone`（通常是触发 shutdown）。
///
/// 用固定间隔轮询而非事件等待：跨平台拿「父进程退出」的事件语义不一致，1 秒一次的
/// 开销可以忽略，换来所有非优雅退出路径都被兜住。
///
/// 未注入 `QOMICEX_PARENT_PID` 时直接返回：手工运行后端（开发、CI、curl 调试）没有
/// 启动器父进程，若不加这个开关，后端会因「父进程不在」而在 1 秒后自杀。
pub fn spawn_guard<F>(on_parent_gone: F)
where
    F: Fn() + Send + 'static,
{
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
    if expected_parent_pid().is_none() {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(INTERVAL);
        if !parent_alive() {
            on_parent_gone();
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些用例都读写 `QOMICEX_PARENT_PID`，cargo 默认并行执行会互相污染。
    /// 用一把全局锁把它们串起来。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 在锁内设置环境变量，测试结束自动还原。
    struct EnvGuard {
        had: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(value: Option<&str>) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let had = std::env::var_os("QOMICEX_PARENT_PID");
            // 安全：已持锁，且这些用例是唯一读写该变量的地方
            unsafe {
                match value {
                    Some(v) => std::env::set_var("QOMICEX_PARENT_PID", v),
                    None => std::env::remove_var("QOMICEX_PARENT_PID"),
                }
            }
            Self { had, _lock: lock }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // 安全：仍持锁
            unsafe {
                match &self.had {
                    Some(v) => std::env::set_var("QOMICEX_PARENT_PID", v),
                    None => std::env::remove_var("QOMICEX_PARENT_PID"),
                }
            }
        }
    }

    /// 注入的 pid 要被正确解析；缺失或非法时返回 None（看护据此不启动）。
    #[test]
    fn expected_parent_pid_parses_injected_value() {
        {
            let _g = EnvGuard::set(Some("4242"));
            assert_eq!(expected_parent_pid(), Some(4242));
        }
        {
            let _g = EnvGuard::set(Some(" 4242 "));
            assert_eq!(expected_parent_pid(), Some(4242), "应容忍首尾空白");
        }
        {
            let _g = EnvGuard::set(Some("not-a-pid"));
            assert_eq!(expected_parent_pid(), None);
        }
        {
            let _g = EnvGuard::set(None);
            assert_eq!(expected_parent_pid(), None);
        }
    }

    /// 当前父进程（测试运行时是 cargo runner）存活时必须判定为 alive。
    ///
    /// 若这里返回 false，说明把「活着」误判为「已退出」，后端会毫无理由自杀 ——
    /// 那比残留僵尸更糟。
    #[test]
    fn live_parent_is_reported_alive() {
        let parent = real_parent_pid().expect("应能查到父进程 pid");
        let _g = EnvGuard::set(Some(&parent.to_string()));
        assert!(parent_alive(), "父进程存活时必须返回 true");
    }

    /// 注入一个不可能存在的 pid 时必须判定为已退出。
    ///
    /// 这条直接对应本模块的存在意义：父进程消失后后端要能自己发现。
    #[test]
    fn dead_parent_is_reported_dead() {
        let _g = EnvGuard::set(Some("4294967290"));
        assert!(!parent_alive(), "不存在的父进程必须判定为已退出");
    }

    /// 未注入 `QOMICEX_PARENT_PID` 时看护不得触发。
    #[test]
    fn guard_is_inert_without_parent_env() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let _g = EnvGuard::set(None);
        let fired = Arc::new(AtomicBool::new(false));
        let flag = fired.clone();
        spawn_guard(move || flag.store(true, Ordering::SeqCst));
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(!fired.load(Ordering::SeqCst), "未注入父 pid 时看护不得触发");
    }

    /// 当前进程的真实父 pid（cargo runner）。
    fn real_parent_pid() -> Option<u32> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            };
            let own = std::process::id();
            // SAFETY: 快照句柄用后关闭；PROCESSENTRY32W 先置 dwSize 再由系统填充。
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot == 0 {
                    return None;
                }
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                let mut parent = None;
                if Process32FirstW(snapshot, &mut entry) != 0 {
                    loop {
                        if entry.th32ProcessID == own {
                            parent = Some(entry.th32ParentProcessID);
                            break;
                        }
                        if Process32NextW(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snapshot);
                parent.filter(|p| *p != 0)
            }
        }
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn getppid() -> i32;
            }
            let ppid = unsafe { getppid() };
            u32::try_from(ppid).ok().filter(|p| *p > 1)
        }
        #[cfg(not(any(windows, unix)))]
        {
            None
        }
    }
}
