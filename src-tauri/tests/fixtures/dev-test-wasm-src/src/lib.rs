//! dev.test.wasm — WASM 网关测试插件。
//!
//! 供 `src-tauri/src/plugin_gateway/mod.rs` 的集成测试使用：
//!   - `on_load`      () -> ()   宿主扫描加载后由测试调用
//!   - `db_set_test`  () -> ()   测试宿主 `db_set` 往返
//!   - `on_unload` / `get_manifest` 契约导出
//!
//! 宿主函数位于 `qomicex` 导入模块（见 loader.rs 的 linker.func_wrap）。

#![no_std]
#![no_main]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

#[link(wasm_import_module = "qomicex")]
extern "C" {
    fn log(level: i32, msg_ptr: i32, msg_len: i32);
    fn db_set(key_ptr: i32, key_len: i32, val_ptr: i32, val_len: i32);
    fn get_plugin_id(out_ptr: i32, out_cap: i32) -> i32;
}

/// 把字符串拷进插件线性内存的 out 缓冲区，返回实际写入字节数。
fn fill_out(out_ptr: i32, out_cap: i32, s: &[u8]) -> i32 {
    if out_cap < 0 {
        return -1;
    }
    let n = core::cmp::min(s.len(), out_cap as usize);
    unsafe {
        core::ptr::copy_nonoverlapping(s.as_ptr(), out_ptr as *mut u8, n);
    }
    n as i32
}

#[no_mangle]
pub extern "C" fn on_load() {
    const MSG: &[u8] = b"dev.test.wasm on_load";
    unsafe {
        log(0, MSG.as_ptr() as i32, MSG.len() as i32);
    }
}

/// 测试宿主 db_set：写入一条固定的 key/value。
#[no_mangle]
pub extern "C" fn db_set_test() {
    const KEY: &[u8] = b"test_key";
    const VAL: &[u8] = b"test_value";
    unsafe {
        db_set(KEY.as_ptr() as i32, KEY.len() as i32, VAL.as_ptr() as i32, VAL.len() as i32);
    }
}

/// 契约导出：把插件 id 写入 out，返回长度。
#[no_mangle]
pub extern "C" fn get_manifest(out_ptr: i32, out_cap: i32) -> i32 {
    fill_out(out_ptr, out_cap, b"dev.test.wasm")
}

#[no_mangle]
pub extern "C" fn on_unload() {}
