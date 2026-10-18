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
//! 判据：
//! - Windows：`OpenProcess` + `GetExitCodeProcess` 是否仍为 `STILL_ACTIVE`。
//!   不用「管道断开」代替：TCP 模式下根本没有管道，且管道断开也可能只是重连。
//! - Unix：`kill(ppid, 0)`；父进程被回收后子进程会被 init 收养（ppid 变 1），
//!   那本身就是明确信号。

/// 父进程是否仍在运行。取不到父 pid 时保守返回 `true`（不误杀）。
pub fn parent_alive() -> bool {
    #[cfg(windows)]
    {
        windows_parent_alive()
    }
    #[cfg(unix)]
    {
        unix_parent_alive()
    }
    #[cfg(not(any(windows, unix)))]
    {
        true
    }
}

#[cfg(windows)]
fn windows_parent_alive() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let Some(parent_pid) = windows_parent_pid() else {
        return true;
    };

    // SAFETY: OpenProcess 失败返回空句柄，据此提前返回；成功时与 CloseHandle 配对。
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent_pid);
        if handle == 0 {
            // 打不开：父进程已退出（ERROR_INVALID_PARAMETER）时判定为死亡；
            // 权限不足（ERROR_ACCESS_DENIED）时保守按存活处理，避免误杀。
            const ERROR_ACCESS_DENIED: i32 = 5;
            return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED);
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        if !ok {
            return true;
        }
        code == STILL_ACTIVE as u32
    }
}

/// 通过进程快照查自己的父 pid。取不到返回 `None`。
#[cfg(windows)]
fn windows_parent_pid() -> Option<u32> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let own_pid = std::process::id();
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
                if entry.th32ProcessID == own_pid {
                    parent = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        parent.filter(|pid| *pid != 0)
    }
}

#[cfg(unix)]
fn unix_parent_alive() -> bool {
    unsafe extern "C" {
        fn getppid() -> i32;
    }
    // SAFETY: getppid 无参数、无副作用、总是成功。
    let ppid = unsafe { getppid() };
    // 1 = 被 init 收养，说明原父进程已退出
    ppid > 1
}

/// 后台看护：父进程消失时执行 `on_parent_gone`（通常是触发 shutdown）。
///
/// 用固定间隔轮询而非事件等待：父进程的句柄在子进程侧**无法**可靠地做等待信号化
/// （父进程退出后句柄仍可等待，但拿不到「进程对象已终止」之外的语义，且跨平台不一致）。
/// 1 秒一次的开销可以忽略，换来的是所有非优雅退出路径都能被兜住。
///
/// 未设置 `QOMICEX_PARENT_PID` 时直接返回：手工运行后端（开发、CI、curl 调试）不该
/// 被这个机制影响。
pub fn spawn_guard<F>(on_parent_gone: F)
where
    F: Fn() + Send + 'static,
{
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
    if std::env::var_os("QOMICEX_PARENT_PID").is_none() {
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

    /// 当前父进程（测试运行时是 cargo runner）必然存活：基础健全性检查。
    ///
    /// 若这里返回 false，说明把「活着」误判为「已退出」，后端会毫无理由自杀 ——
    /// 那比残留僵尸更糟。
    #[test]
    fn live_parent_is_reported_alive() {
        assert!(parent_alive(), "父进程（cargo runner）存活时必须返回 true");
    }

    /// 未设置 `QOMICEX_PARENT_PID` 时看护不得触发。
    ///
    /// 手工运行后端（开发/CI/curl 调试）没有启动器父进程；若不设这个开关，后端会在
    /// 1 秒后自杀，表现为「后端刚起来就退出」且没有任何请求报错可查。
    #[test]
    fn guard_is_inert_without_parent_env() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let fired = Arc::new(AtomicBool::new(false));
        let flag = fired.clone();
        let had_env = std::env::var_os("QOMICEX_PARENT_PID");
        // 安全：本用例内没有其它线程读该变量；结束后立即还原
        unsafe { std::env::remove_var("QOMICEX_PARENT_PID") };
        spawn_guard(move || flag.store(true, Ordering::SeqCst));
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let observed = fired.load(Ordering::SeqCst);
        if let Some(v) = had_env {
            unsafe { std::env::set_var("QOMICEX_PARENT_PID", v) };
        }
        assert!(!observed, "未设置 QOMICEX_PARENT_PID 时看护不得触发");
    }
}
