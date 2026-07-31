use std::collections::HashMap;
use wasmtime::{Engine, Module};
use crate::plugin_gateway::config;

pub struct WasmPlugin {
    pub id: String,
    pub module: Module,
    pub permissions: Vec<String>,
}

pub struct PluginRuntime {
    engine: Engine,
    plugins: HashMap<String, WasmPlugin>,
}

impl PluginRuntime {
    pub fn new() -> anyhow::Result<Self> {
        let engine = Engine::default();
        Ok(Self { engine, plugins: HashMap::new() })
    }

    pub fn scan_and_load(&mut self) -> anyhow::Result<()> {
        let dir = config::plugins_dir();
        if !dir.exists() { return Ok(()); }

        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() { continue; }

            let manifest_path = path.join("manifest.json");
            let wasm_path = path.join("plugin.wasm");
            if !manifest_path.exists() || !wasm_path.exists() { continue; }

            let manifest_text = std::fs::read_to_string(&manifest_path)?;
            let manifest: serde_json::Value = serde_json::from_str(&manifest_text)?;

            let id = manifest["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }

            let layers = manifest["layers"].as_array();
            let has_l3 = layers.map(|l| l.iter().any(|v| v == "l3")).unwrap_or(false);
            if !has_l3 { continue; }

            let permissions: Vec<String> = manifest["permissions"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            let wasm_bytes = std::fs::read(&wasm_path)?;
            let module = Module::new(&self.engine, &wasm_bytes)?;

            self.plugins.insert(id.clone(), WasmPlugin { id: id.clone(), module, permissions });
            eprintln!("[plugin] loaded WASM plugin: {}", id);
        }
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
}
