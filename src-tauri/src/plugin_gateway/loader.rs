use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use wasmtime::{Engine, Linker, Module, Store};

use crate::plugin_gateway::config;

/// WASM 插件实例（保持链接与 store 状态）
pub struct WasmPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub store: Store<PluginData>,
    pub instance: wasmtime::Instance,
}

/// Store 内保存的插件数据（Host API 需要访问）
pub struct PluginData {
    pub plugin_id: String,
    pub db: Arc<Mutex<HashMap<String, String>>>,
    pub log: Vec<String>,
}

impl PluginData {
    fn new(plugin_id: String, db: Arc<Mutex<HashMap<String, String>>>) -> Self {
        Self {
            plugin_id,
            db,
            log: Vec::new(),
        }
    }
}

pub struct PluginRuntime {
    engine: Engine,
    plugins: HashMap<String, WasmPlugin>,
}

impl PluginRuntime {
    pub fn new() -> anyhow::Result<Self> {
        let engine = Engine::default();
        Ok(Self {
            engine,
            plugins: HashMap::new(),
        })
    }

    pub fn scan_and_load(&mut self) -> anyhow::Result<()> {
        let dir = config::plugins_dir();
        if !dir.exists() {
            return Ok(());
        }

        let db: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let manifest_path = path.join("manifest.json");
            let wasm_path = path.join("plugin.wasm");
            if !manifest_path.exists() || !wasm_path.exists() {
                continue;
            }

            let manifest_text = std::fs::read_to_string(&manifest_path)?;
            let manifest: serde_json::Value = serde_json::from_str(&manifest_text)?;

            let id = manifest["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }

            let layers = manifest["layers"].as_array();
            let has_l3 = layers.map(|l| l.iter().any(|v| v == "l3")).unwrap_or(false);
            if !has_l3 {
                continue;
            }

            let permissions: Vec<String> = manifest["permissions"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let wasm_bytes = std::fs::read(&wasm_path)?;
            match self.load_plugin(
                id.clone(),
                manifest["name"].as_str().unwrap_or(&id).to_string(),
                manifest["version"].as_str().unwrap_or("0.0.0").to_string(),
                permissions,
                wasm_bytes,
                db.clone(),
            ) {
                Ok(_) => tauri_log!("plugin", "loaded WASM plugin: {}", id),
                Err(e) => tauri_log!("plugin", "failed to load {}: {e}", id),
            }
        }
        Ok(())
    }

    fn load_plugin(
        &mut self,
        id: String,
        name: String,
        version: String,
        permissions: Vec<String>,
        wasm_bytes: Vec<u8>,
        db: Arc<Mutex<HashMap<String, String>>>,
    ) -> anyhow::Result<()> {
        let module = Module::new(&self.engine, &wasm_bytes)?;

        let mut linker: Linker<PluginData> = Linker::new(&self.engine);

        // ---- Host API：log ----
        linker.func_wrap(
            "qomicex",
            "log",
            |mut caller: wasmtime::Caller<'_, PluginData>,
             level: i32,
             msg_ptr: i32,
             msg_len: i32| {
                let mem = caller.get_export("memory").and_then(|e| e.into_memory());
                if let Some(mem) = mem {
                    if msg_ptr >= 0 && msg_len >= 0 {
                        let mut buf = vec![0u8; msg_len as usize];
                        if mem.read(&mut caller, msg_ptr as usize, &mut buf).is_ok() {
                            let msg = String::from_utf8_lossy(&buf).to_string();
                            tauri_log!("plugin:log", "{msg}");
                        }
                    }
                }
                Ok(())
            },
        )?;

        // ---- Host API：http_fetch ----
        linker.func_wrap(
            "qomicex",
            "http_fetch",
            |_caller: wasmtime::Caller<'_, PluginData>,
             _url_ptr: i32,
             _url_len: i32,
             _method_ptr: i32,
             _method_len: i32,
             _body_ptr: i32,
             _body_len: i32,
             _out_ptr: i32| {
                // 暂返回 -1（失败），前端可通过代理 API 直接请求
                Ok(-1)
            },
        )?;

        // ---- Host API：instance_list ----
        linker.func_wrap(
            "qomicex",
            "instance_list",
            |_caller: wasmtime::Caller<'_, PluginData>, _out_ptr: i32| Ok(-1),
        )?;

        // ---- Host API：db_set ----
        linker.func_wrap(
            "qomicex",
            "db_set",
            |mut caller: wasmtime::Caller<'_, PluginData>,
             key_ptr: i32,
             key_len: i32,
             val_ptr: i32,
             val_len: i32| {
                let mem = caller.get_export("memory").and_then(|e| e.into_memory());
                let db = caller.data().db.clone();
                if let Some(mem) = mem {
                    if key_ptr >= 0 && key_len >= 0 && val_ptr >= 0 && val_len >= 0 {
                        let mut kb = vec![0u8; key_len as usize];
                        let mut vb = vec![0u8; val_len as usize];
                        if mem.read(&mut caller, key_ptr as usize, &mut kb).is_ok()
                            && mem.read(&mut caller, val_ptr as usize, &mut vb).is_ok()
                        {
                            let key = String::from_utf8_lossy(&kb).to_string();
                            let val = String::from_utf8_lossy(&vb).to_string();
                            db.lock().unwrap().insert(key, val);
                        }
                    }
                }
                Ok(())
            },
        )?;

        // ---- Host API：db_get ----
        linker.func_wrap(
            "qomicex",
            "db_get",
            |mut caller: wasmtime::Caller<'_, PluginData>,
             key_ptr: i32,
             key_len: i32,
             out_ptr: i32,
             out_cap: i32|
             -> wasmtime::Result<i32> {
                let mem = caller.get_export("memory").and_then(|e| e.into_memory());
                let db = caller.data().db.clone();
                let mem = match mem {
                    Some(m) => m,
                    None => return Ok(-1),
                };
                if key_ptr < 0 || key_len < 0 || out_ptr < 0 || out_cap < 0 {
                    return Ok(-1);
                }
                let mut kb = vec![0u8; key_len as usize];
                mem.read(&mut caller, key_ptr as usize, &mut kb)
                    .map_err(|_| wasmtime::Error::msg("read key failed"))?;
                let key = String::from_utf8_lossy(&kb).to_string();
                let val = db.lock().unwrap().get(&key).cloned().unwrap_or_default();
                let bytes = val.into_bytes();
                let n = bytes.len().min(out_cap as usize);
                mem.write(&mut caller, out_ptr as usize, &bytes[..n])
                    .map_err(|_| wasmtime::Error::msg("write out failed"))?;
                Ok(n as i32)
            },
        )?;

        // ---- Host API：get_plugin_id（辅助） ----
        linker.func_wrap(
            "qomicex",
            "get_plugin_id",
            |mut caller: wasmtime::Caller<'_, PluginData>,
             out_ptr: i32,
             out_cap: i32|
             -> wasmtime::Result<i32> {
                let mem = caller.get_export("memory").and_then(|e| e.into_memory());
                let pid = caller.data().plugin_id.clone();
                let mem = match mem {
                    Some(m) => m,
                    None => return Ok(-1),
                };
                let bytes = pid.into_bytes();
                let n = bytes.len().min(out_cap as usize);
                mem.write(&mut caller, out_ptr as usize, &bytes[..n])
                    .map_err(|_| wasmtime::Error::msg("write id failed"))?;
                Ok(n as i32)
            },
        )?;

        let mut store = Store::new(&self.engine, PluginData::new(id.clone(), db));
        let instance = linker.instantiate(&mut store, &module)?;

        self.plugins.insert(
            id.clone(),
            WasmPlugin {
                id,
                name,
                version,
                permissions,
                store,
                instance,
            },
        );
        Ok(())
    }

    pub fn get_plugin(&self, id: &str) -> Option<&WasmPlugin> {
        self.plugins.get(id)
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    pub fn plugin_ids(&self) -> impl Iterator<Item = &str> {
        self.plugins.keys().map(|s| s.as_str())
    }

    /// 调用插件导出的函数（如 on_load / on_unload / get_manifest）
    pub fn call_export(&mut self, id: &str, name: &str) -> anyhow::Result<serde_json::Value> {
        let plugin = self
            .plugins
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("plugin not found"))?;

        // 尝试 () -> ()
        if let Ok(f) = plugin
            .instance
            .get_typed_func::<(), ()>(&mut plugin.store, name)
        {
            f.call(&mut plugin.store, ())?;
            return Ok(serde_json::json!({ "ok": true }));
        }
        // 尝试 () -> i32
        if let Ok(f) = plugin
            .instance
            .get_typed_func::<(), i32>(&mut plugin.store, name)
        {
            let ret = f.call(&mut plugin.store, ())?;
            return Ok(serde_json::json!({ "ok": true, "result": ret }));
        }
        Err(anyhow::anyhow!("no export named {name}"))
    }
}
