//! __QOMICEX_PLUGIN_NAME__ — L3 WASM 插件（wasmtime 沙箱）。
//!
//! 宿主函数位于 `qomicex` 导入模块。编译为 wasm32-unknown-unknown 后
//! 重命名为 `plugin.wasm` 放入包根目录（网关按固定文件名加载）。

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
    const MSG: &[u8] = b"__QOMICEX_PLUGIN_ID__ on_load";
    unsafe {
        log(0, MSG.as_ptr() as i32, MSG.len() as i32);
    }
}

/// 示例自定义导出：写入一条 key/value，供前端 `callWasm(id, 'db_set_test')` 调用。
#[no_mangle]
pub extern "C" fn db_set_test() {
    const KEY: &[u8] = b"greeting";
    const VAL: &[u8] = b"hello from __QOMICEX_PLUGIN_ID__";
    unsafe {
        db_set(KEY.as_ptr() as i32, KEY.len() as i32, VAL.as_ptr() as i32, VAL.len() as i32);
    }
}

/// 契约导出：把插件 id 写入 out，返回长度。
#[no_mangle]
pub extern "C" fn get_manifest(out_ptr: i32, out_cap: i32) -> i32 {
    fill_out(out_ptr, out_cap, b"__QOMICEX_PLUGIN_ID__")
}

#[no_mangle]
pub extern "C" fn on_unload() {}