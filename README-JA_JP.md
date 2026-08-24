[English](README.md) | [简体中文](README-ZH_CN.md) | [繁體中文](README-ZH_TW.md) | **日本語** | [Русский](README-RU_RU.md)

<div align="center">
  
<img width="80" height="80" alt="QML Icon" src="/public/logo.svg" />

# Qomicex Minecraft Launcher

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHBhdGggZD0iTTggLjI1YS43NS43NSAwIDAgMSAuNjczLjQxOGwxLjg4MiAzLjgxNSA0LjIxLjYxMmEuNzUuNzUgMCAwIDEgLjQxNiAxLjI3OWwtMy4wNDYgMi45Ny43MTkgNC4xOTJhLjc1MS43NTEgMCAwIDEtMS4wODguNzkxTDggMTIuMzQ3bC0zLjc2NiAxLjk4YS43NS43NSAwIDAgMS0xLjA4OC0uNzlsLjcyLTQuMTk0TC44MTggNi4zNzRhLjc1Ljc1IDAgMCAxIC40MTYtMS4yOGw0LjIxLS42MTFMNy4zMjcuNjY4QS43NS43NSAwIDAgMSA4IC4yNVoiIGZpbGw9IiNlYWM1NGYiLz48L3N2Zz4=&logoSize=auto&label=stars&labelColor=444444&color=eac54f)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
![GitHub Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?label=release&logo=github&style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge)

[![Issues](https://img.shields.io/github/issues/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=issues&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/issues)
[![Pull requests](https://img.shields.io/github/issues-pr/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=pull%20requests&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/pulls)
![GitHub Downloads (all assets, all releases)](https://ghapi.qomicex.top/?style=for-the-badge&color=green)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Release](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml/badge.svg)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml)

<div align="center">
   
[公式サイト](https://www.qomicex.top)
[最新版をダウンロード](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest)

</div>

</div>

[Qomicex Minecraft Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri)（略称 QML）は現在ベータ段階です。ぜひお試しください。

> ランチャーのバックエンドは Rust（axum）で完全に書き直されました。コアライブラリとダウンローダーも Rust サブモジュール（`qomicex-core-rust` / `qomicex-connector-rust` / `qomicex-downloader-rust`）へ移行済みで、.NET SDK には依存していません。

## ✨ 主な機能

> デスクトップ版（Tauri v2）の現在の機能。コアロジックはすべて Rust で実装されています。

Qomicex Launcher（略称 QML）の目標は、「起動・インストール・インスタンス管理」といった日常操作をできるだけシンプルで直接的なものにすることです。日常的なプレイから Modpack の導入、友人とのマルチプレイまで。

### 🚀 ゲーム起動

バニラ Minecraft の起動に対応しているほか、主要な Mod Loader の**ワンクリック自動インストール**にも対応しています：

- Vanilla
- Forge
- Fabric
- NeoForge
- Quilt
- Babric
- LegacyFabric
- Cleanroom

ランチャーはインスタンス設定を読み込み、ゲームに必要な libraries・assets・natives・JVM 引数・ゲーム引数を自動で組み立てます。起動後は完全な起動ログを記録するため、クラッシュや Mod の競合の調査に役立ちます。

### 🔐 アカウントログイン

複数のログイン方式に対応しています：

- **Microsoft 正規アカウント**（OAuth デバイスコードフロー）：使い捨てのデバイスコードで認証でき、ログイン情報はローカルに保存されるため次回からそのまま利用可能
- **オフラインプレイヤー名**：ローカルテスト、シングルプレイ、正規認証が不要な環境向け
- **Yggdrasil スキンサーバー**：LittleSkin、Blessing Skin などのよく使われるサーバーのプリセットを内蔵。その他のサーバーも手軽に追加できます

スキンサーバーは**リンクをドラッグ＆ドロップしてワンクリック追加**に対応：Yggdrasil サーバーアドレスは自動解析されます（authlib-injector 仕様）。手入力は不要です。

### 🌐 内蔵マルチプレイ

QML は **Scaffolding プロトコルによるマルチプレイ**を内蔵しており、グローバル IP がなくても友人とネットワークを組んで遊べます：

- ルーム作成 / 参加、NAT タイプ検出（STUN マルチポートフォールバック）、リレーネットワーキング
- キックは **deny 永続物理 BAN** に強化：キックされたプレイヤーは再接続・再起動後でも部屋に戻れません
- 誤キック救済：再接続審査ポップアップ（許可 / 拒否 / 拒否して今後表示しない）、ホスト側ブラックリストからワンクリックで BAN 解除
- ホスト Mod 検証：不足 Mod の検出、ホストと不一致の場合の強制同期
- HMCL、PCL-CE、PCL.Mac など Scaffolding プロトコルを実装したランチャーとの相互接続に対応

### 📦 インスタンス管理

各ゲームバージョンや Modpack は**独立したインスタンス**として保存され、ディレクトリはバージョンごとに分離されます：

- バージョンと Forge / Fabric / NeoForge / Quilt などのローダーをワンクリックインストール
- インスタンスごとに Mod・セーブデータ・リソースパック・シェーダーパック・設定ファイル・Java とメモリ・JVM 引数を個別管理
- インスタンスのカスタムグループ化で、大量のバージョンも整理整頓

### 📐 スキーマティック管理 · Deepslate 3D プレビュー

インスタンス詳細ページに **Litematica スキーマティック**の管理とプレビュー機能を内蔵：

- 一覧 / 検索 / フォルダを開く / ローカルインポート（multipart、拡張子ホワイトリスト）/ リネーム / 個別削除 + 一括削除
- **Deepslate WebGL 3D プレビュー**：スキーマティックの全内容表示 + マテリアルパレット + Y レイヤースライダー + マルチリージョン + ブロック/素材の統計リスト
- マテリアルはスキーマティックのパレットサブセットから、必要に応じてユーザーのゲーム jar から実行時に抽出しローカルキャッシュ。**Mojang 素材は同梱しません**（著作権コンプライアンス）
- schematics ディレクトリもバージョン分離の対象で、インスタンスごとに独立して保存

### 🗂️ リソースセンター

**Modrinth / CurseForge / FTB** の 3 大データソースを集約し、リソースをワンストップで探せます：

- Mod・Modpack・シェーダー・リソースパック・データパック・セーブデータなどのカテゴリ検索に対応
- MC Wiki による中国語名補完で、より見やすく
- オンラインで Mod・リソースパック・シェーダーパックを検索してインストール
- リソース詳細をワンストップで確認

### ⬇️ ダウンロードセンター

統一ダウンローダーがゲームファイル・依存ライブラリ・リソースファイル・ローダーインストーラー・Modpack・オンライン Mod ダウンロードを担当します：

- 自社開発の高速ダウンロードエンジン。複数ファイルの非同期ダウンロード、タスクごとのリアルタイム進捗表示
- レジューム機能、一時停止 / 再開 / キャンセル
-低速時や失敗時の自動ソース切替、現在のソースのクールダウンにより、レート制限中のソースへの連続リクエストを回避

インスタンスのインストール、Mod のダウンロード、Java ランタイムなど、すべてのダウンロードタスクはダウンロードセンターで一元管理され、進捗と失敗原因をいつでも確認できます。

### 📥 Modpack のインポート / エクスポート

- **インポート**：ローカルの `zip` / Modrinth `.mrpack` をアップロードして解析し、ワンクリックでインストール。バージョン・ローダー・Mod・設定・リソースディレクトリを自動判別；インストール中断・失敗時は中途半端なファイルを自動クリーンアップし、残留物を残しません
- **エクスポート**：CurseForge `zip`、Modrinth `mrpack`、または Qomicex 独自の `.qmodpack` でエクスポート可能。ハッシュ逆引きでファイルマニフェストを自動生成
- HMCL 風の**ファイル単位チェックボックス**エクスポート：パッケージ名 / バージョン / 作者をカスタマイズ、非同期タスクは進捗表示・キャンセル可能・保存先をカスタマイズ可能

### 🧩 Mod 管理

各インスタンスには専用の管理ページがあります：

- インストール済み Mod の表示、有効化 / 無効化、削除
- インスタンスディレクトリ、および mods・saves・resourcepacks・shaderpacks・config などのよく使うフォルダを開く
- オンラインで Mod を検索してインストール、リソースパック・シェーダーパックのダウンロード
- **Mod 更新チェック**：Modrinth / CurseForge のバッチハッシュ照合。変更リストはダウンロードセンターに渡して更新を調整

Mod を無効化してもファイルは保持され、有効状態のみが変更されるため、競合の切り分けが容易です。

### 📎 Mod 依存関係の自動インストール

Mod をインストールする際、QML は Modrinth / CurseForge データソースから**依存関係リスト**を自動解析します：

- **必須依存関係（required dependencies）**を識別して表示。深い依存関係の再帰解析に対応
- 前置 Mod もまとめてワンクリックでターゲットインスタンスにインストール。「前置がないと起動しない」「名前が赤くなるエラー」の悩みを解消
- 必須ではない依存関係はスキップ可能。必要な範囲を選んでインストールできます

### ☕ Java ランタイム管理

バージョンによって必要な Java は異なります。QML はインスタンスのバージョンに応じて自動選択します：

- ローカルにインストール済みの Java を自動スキャン
- 不足している Java 8 / 17 / 21 をオンラインダウンロード
- Java パスの手動指定、インスタンスごとの個別設定
- 起動時に現在のゲームバージョンと Java の適合性をチェック

### 💾 セーブデータ & ゲーム設定エディター

- **セーブデータ設定エディター（level.dat NBT）**：ゲームモード・難易度・天候・スポーン地点・ワールド境界・ゲームルールなどをビジュアル編集。`level.dat_old` からの復元にも対応
- **ゲーム設定**：`options.txt` のビジュアル編集。多言語説明付き、配列値（resourcePacks / datapacks など）はチップ形式で追加・削除

### 🩺 ログ分析 & クラッシュ調査

ゲームクラッシュ後、起動ログを読み込んで分析できます：

- **ローカルルール分析**：44 種類のエラーパターンを内蔵し、Critical > Error > Warning > Info の順でソート。追加設定不要
- **AI 分析**（プラグイン提供）：OpenAI 互換形式の API アドレス・Key・モデル名を入力して呼び出し

### 🧩 プラグインシステム

QML は拡張可能なプラグインエコシステムを提供します：

- マニフェスト貢献ポイント、インラインレンダリング / iframe オーバーレイ、プラグイン間メソッド呼び出し
- **L3 WASM プラグインゲートウェイ**（wasmtime サンドボックス、Rust 実装）：プラグインは WebAssembly として制限付きサンドボックス内で安全に実行
- プラグインパッケージ（`.qplugin`）のアップロード・インストールに対応。状態はローカルに永続化

### 🎨 パーソナライゼーション & 多言語

- **I18N 国際化**：中 / 英 / 繁体字 / 日 / 露など **7 言語**対応。「システムに従う」オプションあり、実行時の即時切り替えに対応
- カスタム UI フォント（システムフォントの列挙、リアルタイムプレビュー）
- 内蔵 / カスタム背景、テーマカラーなどの UI パーソナライズオプション

## 🔗 依存関係 & 関連プロジェクト

QML のコア機能は以下の **Rust サブモジュール**が担っています（リポジトリルートの git サブモジュール、`git submodule update --recursive` で取得）：

- [qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust) — コアライブラリ（GameCore ゲームコア、インスタンス / アカウント / Java / ダウンロードなどのビジネスロジック）
- [qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust) — 統合高速ダウンローダー
- [qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust) — マルチプレイ / SCF プロトコルライブラリ（EasyTier4QML フォークに依存）
- [Qomicex.Tauri.i18n](https://github.com/Qomicex-Public/Qomicex.Tauri.i18n) — フロントエンド多言語リソースリポジトリ

**提携 / 関連コミュニティプロジェクト**：

- [EuoraCraft-Launcher（ECLteam）](https://github.com/ECLteam/EuoraCraft-Launcher) — ECLteam が開発した Python + Tauri 製サードパーティ Minecraft ランチャー。QML と**マルチプレイノードを共有**し、**SCF 拡張プロトコル互換**で相互接続できます

## 🔗 リンク

| リンク | URL |
|:--|:--|
| 公式サイト | <https://www.qomicex.top> |
| プロジェクトリポジトリ | <https://github.com/Qomicex-Public/Qomicex.Tauri> |
| リリースダウンロード | <https://github.com/Qomicex-Public/Qomicex.Tauri/releases> |
| 問題報告 | <https://github.com/Qomicex-Public/Qomicex.Tauri/issues> |
| 多言語リポジトリ | <https://github.com/Qomicex-Public/Qomicex.Tauri.i18n> |
| テストフィードバックグループ | [623362446](https://qm.qq.com/q/rKiwzrkg8w) |

## 🎯 適した用途

QML はこんな使い方に向いています：

- 日常的に Minecraft を起動し、複数のバージョンと Modpack を管理
- 友人とのマルチプレイ（グローバル IP 不要、内蔵ネットワーキング）
- Modpack をドラッグ＆ドロップで素早くインストール / ワンクリックエクスポートして共有
- Mod・リソースパック・シェーダーパック・セーブデータの管理
- インスタンスごとの Java とメモリの設定
- 起動失敗やクラッシュログの調査
- パーソナライズ可能な UI と多言語対応の軽量ランチャーをお探しの方

## ℹ️ 発音ガイド

Qomicex
/kˈɑːmaɪsˌɛks/
≈ q·om·ic·ex

## 🖥️ 対応プラットフォーム

> 現在サポートされているプラットフォーム、最低システム要件、テスト状況：

| プラットフォーム | アーキテクチャ | 最低 OS バージョン | 状態 | パッケージ |
|:---|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 1809+ | ✅ 安定 | `.exe`（NSIS インストーラー） |
| **macOS** | `x64`（Intel）、`ARM64`（Apple Silicon） | macOS 10.15+ | ✅ 安定 | `.dmg` / `.app` |
| **Linux** | `x64`, `ARM64`, `LoongArch64`（理論上動作）、`RISC-V 64`（実験的） | Ubuntu 20.04+ / Fedora 34+ / glibc 2.28+ | ✅ 安定 | `.deb` / `.rpm` / AppImage |

![Windows](https://img.shields.io/badge/Windows-10%2B-blue?logo=windows)
![macOS](https://img.shields.io/badge/macOS-10.15%2B-black?logo=apple)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2020.04%2B-yellow?logo=linux)

## 🔧 開発・デバッグ・ビルド

> 技術スタック：**Rust**（axum バックエンド + Tauri v2）+ **React 19 / Vite / TypeScript**（フロントエンド）+ **pnpm**（ワークスペースで `@qomicex/plugin-ui` を管理）。コアライブラリと多言語リソースは git サブモジュールで取り込みます。

### 必要環境

- Rust ツールチェーン（stable）+ `cargo`；`rust-analyzer`（エディタ補完）と `codelldb`（デバッグ、`.vscode/launch.json` を参照）を推奨
- Node.js + pnpm（ワークスペース管理）
- Windows のマルチプレイビルドには npcap（`Packet.dll`）などのランタイム依存が必要。詳細は `AGENTS.md` と CI の `setup-connector-build` を参照

### 初期化（新規チェックアウト）

```bash
git submodule update --recursive
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # plugin-ui の dist/ は gitignore 対象。フロントエンドはこの成果物に依存
```

### バックエンド開発（Rust API）

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
```

デフォルトで `127.0.0.1:5000` をリッスン。`QOMICEX_PORT` 環境変数で上書き可能。開発時は VS Code の `codelldb` でデバッグできます。

### フロントエンド開発（Vite）

```bash
pnpm run dev        # http://localhost:1420、/api は :5000 にプロキシ
```

### デスクトップ開発（Tauri、ウィンドウ + バックエンド統合）

```bash
pnpm run tauri dev
```

### テスト

```bash
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml   # バックエンドユニットテスト
cd src-tauri && cargo test --lib plugin_gateway                      # Tauri WASM プラグインゲートウェイのテスト
pnpm exec tsc --noEmit                                                # フロントエンド + i18n 型チェック
bash scripts/test-api-filters.sh    # または .ps1。:5000 への動作検証
```

### ビルド & フォーマット

```bash
pnpm run build    # tsc → vite build の順。型エラーがあるとビルドが中断
cargo fmt         # Rust 変更後は必須。CI がフォーマットを検査
```

> `packages/plugin-ui/src/` を編集したら plugin-ui パッケージの再ビルドが必要；i18n の変更は `qomicex-tauri-i18n` サブモジュール内で別途コミット・プッシュしてください。

---

## ⭐ スター履歴

<a href="https://www.star-history.com/?repos=Qomicex-Public%2FQomicex.Tauri&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&theme=dark&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
 </picture>
</a>

## 📄 ライセンス

[GPLv3](LICENSE)

## ❤️ コントリビューター

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
