//! 构建脚本：Windows 运行时 DLL 复制 + `appsettings.json` 生成。
//!
//! ## appsettings.json 生成（issue #159）
//!
//! 该文件曾被 git 跟踪且含**有效的** `CurseForge:ApiKey` 明文（仓库为 public，
//! 发布时间随 release 分发）。现在它**不再入库**，改由本脚本在构建期生成：
//!
//! 1. 以 `appsettings.example.json`（入库模板，只含占位/公开值）为基线；
//! 2. 用环境变量覆盖敏感项（CI/发布由 GitHub Actions secret 提供）：
//!    - `CURSEFORGE_API_KEY`（机密）
//!    - `MICROSOFT_CLIENT_ID`（公开值，但允许覆盖以切换应用）
//! 3. 写出 `appsettings.json` 供 `include_str!` 在编译期读取。
//!
//! 写入策略：环境变量提供了值时总是重写（保证 CI 的值不被本地残留文件遮蔽）；
//! 无环境变量且文件已存在时保持不动（尊重开发者本地已填好的配置）。
//!
//! 未配置任何环境变量时，生成的文件里 `CurseForge.ApiKey` 为空字符串——
//! 依赖它的功能（模组图标补全、更新检查）优雅降级，**构建不会失败**
//! （消费侧已有 `is_empty()` 守卫，见 `endpoints/instance_files.rs`）。

use std::fs;
use std::path::PathBuf;

/// 敏感配置项：(环境变量名, JSON 键路径)。
const OVERRIDABLE: &[(&str, &[&str])] = &[
    ("CURSEFORGE_API_KEY", &["CurseForge", "ApiKey"]),
    ("MICROSOFT_CLIENT_ID", &["Microsoft", "ClientId"]),
];

fn main() {
    println!("cargo::rerun-if-env-changed=TARGET");

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());

    generate_appsettings(&manifest);

    // ---- Windows：复制 easytier 运行时 DLL 到 exe 同目录 ----
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }
    let arch = if target.starts_with("x86_64") {
        "x86_64"
    } else if target.starts_with("aarch64") {
        "arm64"
    } else {
        return;
    };

    let src = manifest.join(format!(
        "../../qomicex-connector-rust/easytier/third_party/{arch}"
    ));
    println!("cargo::rerun-if-changed={}", src.display());

    // ponytail: OUT_DIR = <target_dir>/[<triple>/]<profile>/build/<pkg>-<hash>/out，exe 目录在其上 3 级
    let exe_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap())
        .ancestors()
        .nth(3)
        .expect("OUT_DIR layout changed")
        .to_path_buf();

    for dll in ["Packet.dll", "wintun.dll"] {
        fs::copy(src.join(dll), exe_dir.join(dll))
            .unwrap_or_else(|e| panic!("copy {dll} to {} failed: {e}", exe_dir.display()));
    }
}

/// 由模板 + 环境变量生成 `appsettings.json`（详见模块头注释）。
fn generate_appsettings(manifest: &std::path::Path) {
    let example_path = manifest.join("appsettings.example.json");
    let out_path = manifest.join("appsettings.json");

    println!("cargo::rerun-if-changed={}", example_path.display());
    // 把**生成物本身**也登记为触发源：cargo 仅依据构建脚本自身的指纹
    // （rerun-if-changed / if-env-changed）决定是否重跑脚本。若不登记该文件，
    // 「脚本生成过一次后文件被删掉（git clean / 手工 rm）」这种情形下脚本不会重跑，
    // 编译期的 include_str! 随即报「找不到文件」而构建失败。
    // 登记后：文件缺失 → cargo 视为变化 → 重跑脚本 → 重新生成。
    // 不会造成反复重编：脚本运行后 cargo 记录当时的 mtime，此后不变即不重跑。
    println!("cargo::rerun-if-changed={}", out_path.display());
    for (env_var, _) in OVERRIDABLE {
        println!("cargo::rerun-if-env-changed={env_var}");
    }

    let example = match fs::read_to_string(&example_path) {
        Ok(s) => s,
        Err(e) => {
            // 模板是入库文件，缺失属仓库损坏，直接失败并给出可操作提示。
            panic!(
                "读取 {} 失败：{e}\n该模板文件应当入库；请确认仓库完整（git submodule / 浅克隆）。",
                example_path.display()
            );
        }
    };

    let mut doc: serde_json::Value = match serde_json::from_str(&example) {
        Ok(v) => v,
        Err(e) => panic!("{} 不是合法 JSON：{e}", example_path.display()),
    };

    let mut overridden: Vec<&str> = Vec::new();
    for (env_var, path) in OVERRIDABLE {
        let Ok(value) = std::env::var(env_var) else {
            continue;
        };
        // 空值视为「未配置」：CI 里未设置的 secret 会展开成空串，
        // 此时应保留模板基线（而非把基线覆盖成空）。
        if value.trim().is_empty() {
            continue;
        }
        let mut cursor = &mut doc;
        let (last, parents) = path.split_last().expect("OVERRIDABLE 路径非空");
        for key in parents {
            if !cursor[key].is_object() {
                cursor[key] = serde_json::json!({});
            }
            cursor = &mut cursor[key];
        }
        cursor[last] = serde_json::Value::String(value);
        overridden.push(env_var);
    }

    // 环境变量提供了值时总是重写（避免本地残留文件遮蔽 CI 注入的值）；
    // 否则仅在文件不存在时生成，不动开发者已填好的本地配置。
    if overridden.is_empty() && out_path.exists() {
        return;
    }

    let rendered = match serde_json::to_string_pretty(&doc) {
        Ok(s) => s,
        Err(e) => panic!("序列化 appsettings 失败：{e}"),
    };
    if let Err(e) = fs::write(&out_path, format!("{rendered}\n")) {
        panic!("写入 {} 失败：{e}", out_path.display());
    }

    if overridden.is_empty() {
        println!(
            "cargo::warning=appsettings.json 由模板生成（未提供 {}）；CurseForge 相关功能将降级",
            OVERRIDABLE
                .iter()
                .map(|(v, _)| *v)
                .collect::<Vec<_>>()
                .join(" / ")
        );
    } else {
        println!(
            "cargo::warning=appsettings.json 已注入：{}",
            overridden.join(" / ")
        );
    }
}
