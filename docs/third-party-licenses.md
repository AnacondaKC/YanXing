# 第三方许可证说明（v0.1.0 源码发行）

本文档对应研行 **v0.1.0 仅源码** 的 GitHub 发行：随附 `Dockerfile` / `compose.yaml` 及构建说明，**不**分发预构建容器镜像、`node_modules/`、`.next/` 或 `storage/` 运行时数据。

本文是基于仓库内 `LICENSE`、`package.json`、`pnpm-lock.yaml` 以及检查时本地已安装包的 `package.json` / `LICENSE`（或等价文件）所作的**证据摘录**，不是法律意见，也不构成对兼容性或再分发合规的概括保证。

## 1. 本仓库许可

- 项目声明：`package.json` `"license": "Apache-2.0"`，版本 `0.1.0`。
- 许可证全文：根目录 [`LICENSE`](../LICENSE)（Apache License 2.0）。附录版权声明为：`Copyright 2026 研行产业政策研究团队 (YanXing Industrial Policy Research Team)`。
- 当前源码树没有项目级 `NOTICE`，也未发现已复制入源码树、需要另行保留的第三方 NOTICE。Apache 2.0 §4(d) 适用于作品随附 NOTICE 的情况；没有项目级 NOTICE 不代表可以删除实际再分发组件中的归属声明。

## 2. 源码发行里有什么、没有什么

**随源码归档一并分发的，是本仓库受版本管理的文件**，主要包括：研行源代码、`LICENSE`、`package.json`、`pnpm-lock.yaml`、Docker 构建配置、`public/` 品牌矢量图、`docs/screenshots/` 界面截图。

**明确不在源码发行中的**（亦被 `.gitignore` 排除）：

| 路径 | 证据 |
| --- | --- |
| `node_modules/` | `.gitignore` 第 1 行 |
| `.next/` | `.gitignore` 第 2 行 |
| `storage/` | `.gitignore` 第 8 行 |

因此：`pnpm-lock.yaml` 锁定的 npm 包、可选原生二进制、以及安装后才出现的第三方 `LICENSE`，在本发行形态下是**依赖引用**（声明 + 锁文件），**不是**已经打进源码包的再分发拷贝。下游 `pnpm install --frozen-lockfile` 或 `docker compose build` 会从注册表/基础镜像另行拉取，那些产物须按**当时最终制品**再核验。

## 3. 品牌与截图（维护者确认，非独立视觉审查）

源码中随附：

- `public/研行LOGO-完整矢量平滑版.svg`：SVG `<title>` / `<desc>` 标明为研行品牌标志的矢量描摹，无嵌入位图。
- `docs/screenshots/*.png`：README 所用工作台界面截图（已纳入版本管理）。

**发布授权**：维护者已确认上述仓库内品牌材料与截图可以随 v0.1.0 源码公开发布。此项记录的是**维护者对其素材权利的确认**，**不是**对截图画面中可能出现的第三方商标、字体渲染或界面元素所作的独立视觉/商标审查。

Apache 2.0 **不**授予研行或任何第三方商标使用权（见 `LICENSE` §6），合理描述项目来源除外。

## 4. 直接依赖（运行时）

版本取自 `pnpm-lock.yaml` 根 importer 的解析结果；许可证与上游仓库取自本地包 `package.json`（及其中 LICENSE 文件）。链接按 metadata 中的 `repository` / GitHub 路径还原。

| 包 | 锁定版本 | 许可证（本地 metadata） | 上游 |
| --- | --- | --- | --- |
| `next` | 16.3.2 | MIT（`license.md`：Copyright (c) 2025 Vercel, Inc.） | https://github.com/vercel/next.js |
| `@next/env` | 16.3.2 | MIT（包内无独立 LICENSE 文件，`package.json` 声明 MIT） | https://github.com/vercel/next.js |
| `react` | 19.2.0 | MIT（Meta Platforms, Inc. and affiliates） | https://github.com/facebook/react |
| `react-dom` | 19.2.0 | MIT | https://github.com/facebook/react |
| `@visx/heatmap` | 4.0.0 | MIT（Harrison Shoff） | https://github.com/airbnb/visx |
| `@visx/hierarchy` | 4.0.0 | MIT | https://github.com/airbnb/visx |
| `@visx/wordcloud` | 4.0.0 | MIT | https://github.com/airbnb/visx |
| `docx-preview` | 0.4.0 | Apache-2.0 | https://github.com/VolodymyrBaydalka/docxjs |
| `mammoth` | 1.12.0 | BSD-2-Clause（Michael Williamson） | https://github.com/mwilliamson/mammoth.js |
| `pdf-parse` | 2.4.5 | Apache-2.0 | https://github.com/mehmet-kozan/pdf-parse |
| `lucide-react` | 0.468.0 | ISC。LICENSE 另声明：部分版权属 Cole Bemis 2013–2022（Feather，MIT），其余属 Lucide Contributors 2022 | https://github.com/lucide-icons/lucide |
| `tsx` | 4.23.1 | MIT（Hiroki Osame） | https://github.com/privatenumber/tsx |
| `tw-animate-css` | 1.3.3 | MIT（Wombosvideo） | https://github.com/Wombosvideo/tw-animate-css |
| `typebox` | 1.3.7 | MIT（`license` 文件：Haydn Paterson） | https://github.com/sinclairzx81/typebox |

若另行再分发上述包的文件或打包后的代码，应保留适用的版权与许可声明。本源码发行未附带这些依赖包；许可证全文应从对应版本的包或上游来源获取。

## 5. 直接依赖（开发 / 构建工具）

| 包 | 锁定版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| `@tailwindcss/postcss` | 4.3.3 | MIT（Tailwind Labs, Inc.） | https://github.com/tailwindlabs/tailwindcss |
| `tailwindcss` | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| `postcss` | 8.5.25 | MIT（Andrey Sitnik） | https://github.com/postcss/postcss |
| `typescript` | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `esbuild` | 0.28.1 | MIT（Evan Wallace） | https://github.com/evanw/esbuild |
| `@types/react` | 19.2.18 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/react-dom` | 19.2.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/node` | 24.13.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

`@types/node` 的声明范围为 `^24.0.0`，与其它依赖一样由 `pnpm-lock.yaml` 固定具体解析版本。升级依赖后应同步核对本表。

`packageManager` 为 `pnpm@11.18.0`，属于安装工具约束，不是应用运行时依赖，亦不随源码包再分发 pnpm 本体。

## 6. 值得注意的传递依赖（copyleft / 署名 / 双许可）

下列包**出现在锁文件与本地安装树中**，但 **v0.1.0 源码归档并不包含其文件**。列出是为了说明：安装或构建镜像之后，义务可能变化。

### 6.1 `jszip@3.10.1`（MIT OR GPL-3.0-or-later）— 选择 MIT

- 路径：`mammoth@1.12.0` 与 `docx-preview@0.4.0` 均依赖 `jszip@3.10.1`（锁文件 snapshots）。
- 本地 `package.json`：`"license": "(MIT OR GPL-3.0-or-later)"`；`LICENSE.markdown` 写明可任选 MIT **或** GPLv3。
- **本项目选择 MIT 条款使用 jszip。** 双许可中的 GPL 选项**不会**仅因锁文件出现该包，就把研行自动切换为 GPL。选择 MIT 后，须保留 jszip 的版权与许可声明（Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso）。
- 上游：https://github.com/Stuk/jszip

### 6.2 `lightningcss@1.32.0`（MPL-2.0）

- 路径：`@tailwindcss/postcss@4.3.3` → `@tailwindcss/node@4.3.3` → `lightningcss@1.32.0`；可选平台包如 `lightningcss-linux-x64-gnu@1.32.0` 同为 MPL-2.0。
- 本地 LICENSE 为 Mozilla Public License 2.0。MPL 是**文件级** copyleft：再分发其覆盖文件（含可执行形态）时须提供对应源代码并保留声明；**不**因此把 Apache-2.0 的研行源码整体变成 MPL/GPL。
- 上游：https://github.com/parcel-bundler/lightningcss
- 源码发行只引用该依赖；把 lightningcss 原生二进制打进镜像或 `node_modules` 再分发时，需按 MPL 对**该组件**履行源码提供与声明义务。

### 6.3 `caniuse-lite@1.0.30001806`（CC-BY-4.0）

- 路径：`next@16.3.2` 直接依赖（锁文件）。
- 本地 `package.json`：`"license": "CC-BY-4.0"`；LICENSE 为 Creative Commons Attribution 4.0。
- 上游：https://github.com/browserslist/caniuse-lite
- 源码归档不含该数据集；若实际再分发，应按 CC-BY-4.0 保留适用署名、许可证和来源信息，并说明修改情况，不得暗示权利人背书。作者 metadata 为 Ben Briggs，仍须核对该版本随附的完整声明，而非仅以 metadata 替代归属信息。

### 6.4 `@img/sharp-libvips-*`（LGPL-3.0-or-later）与 `sharp`（可选）

- 路径：`next@16.3.2` 的 **optional** 依赖 `sharp@0.35.3`（Apache-2.0，https://github.com/lovell/sharp）；`sharp` 再以 optional 方式拉取 `@img/sharp-libvips-linux-x64@1.3.2` 等平台包。
- 本地 `@img/sharp-libvips-linux-x64@1.3.2`：`"license": "LGPL-3.0-or-later"`，README 写明为 **prebuilt libvips**（`versions.json` 中 `vips` 8.18.3）及其依赖的预编译集合。README 许可表包括：libvips / glib / fribidi / libheif / librsvg / pango / libexif / proxy-libintl 等 **LGPLv3**；cairo 为 **MPL-2.0**；其余多为 MIT/BSD/zlib 等。并写明 LGPLv3 使用经由 LGPLv2/LGPLv2.1 的 “any later version” 条款。
- 上游：https://github.com/lovell/sharp-libvips
- **源码发行不含这些 `.so` / 预编译库。** 若将来对外分发包含它们的制品，应核验适用的许可文本、对应源码获取方式、库替换/重链接及安装信息等义务；具体履行方式取决于实际分发和链接形式，不能只附一个上游首页链接就认定完成。这不自动改变研行自身的 Apache-2.0 许可证。

### 6.5 安装后才会出现、源码中未 vendoring 的其它原生/数据包（供后续制品对照）

以下**均不在源码归档内**，仅在 `pnpm install` 之后存在于 `node_modules`：

- `pdf-parse@2.4.5` → `pdfjs-dist@5.4.296`（Apache-2.0，https://github.com/mozilla/pdf.js）。该 **npm 包内部**另有：Liberation 字体 SIL OFL 1.1、Foxit/PDFium 字体 BSD、Adobe CMap 许可、ICC CC0、OpenJPEG BSD-2-Clause、qcms MIT 等。研行源码**没有**复制这些字体/cmap/wasm。
- `pdf-parse` / `pdfjs-dist` → `@napi-rs/canvas@0.1.80`（MIT；README 称 Google Skia 绑定，含平台原生包）。
- `tsx` → `esbuild@0.28.1`（MIT）及其 `@esbuild/*` 原生可选包。
- `next` 可选 `@next/swc-*`、Tailwind 可选 `@tailwindcss/oxide-*`（包声明 MIT）——均为安装/构建期原生工件。

## 7. 源码引用 vs 再分发二进制：不要混为一谈

| 形态 | 本 v0.1.0 GitHub 源码发行 | `pnpm install` / `docker compose build` 之后 |
| --- | --- | --- |
| 研行源码、`LICENSE`、锁文件、Dockerfile | **再分发** | 仍包含 |
| npm 包源码与 `LICENSE` 全文 | **仅引用**（须按上游条款获取） | 安装在本地；只有随后向他人提供这些文件或包含它们的制品时，才涉及对应再分发要求 |
| libvips / lightningcss / SWC / esbuild / canvas 等原生二进制 | **不含** | 可能进入镜像或部署目录 |
| `.next` 构建产物、打包进客户端的 JS/数据 | **不含** | 可能嵌入 caniuse 等数据，须按最终包再查 |
| Debian/Node 基础镜像（`node:24.20.0-bookworm-slim` 等） | **不含**（Compose/Dockerfile 只写镜像名） | 含大量操作系统包（含 GPL 组件） |
| 运行时数据库、上传文件、密钥 | **不含** | 部署者自己的数据，不要发进发行包 |

**保留声明**：再分发第三方材料时，应保留各包自带的版权、许可与归属文字，不得删除安装树中的 LICENSE。本源码发行通过不附带那些文件、而保留锁文件与本说明，来指向上游义务，而不是代替最终制品里的逐文件声明。

## 8. 本地运行时是否 vendoring？

针对**本仓库源码树**（排除 `node_modules` / `.next` / `.git`）的检查结果：

- **未发现** `NOTICE` 文件、`vendor/` 目录或把 libvips / pdfjs 字体 / caniuse 数据拷入仓库的证据。
- 根目录仅有项目自身 [`LICENSE`](../LICENSE)。
- `public/` 仅有上述品牌 SVG；源码中未使用 `next/font` 或自带 `.woff`/`.ttf`。
- 因此：**就 v0.1.0 源码发行而言，没有已 vendoring 的第三方运行时二进制或 NOTICE 文本需要随本仓库另行复制。** 安装树里的义务（第 6 节）属于依赖包自身，随那些包走，不因源码归档而自动完成或自动免除。

## 9. 为何不会“自动变成 GPL”

- 研行选择 Apache-2.0；`jszip` 为 MIT **或** GPL，本项目**选用 MIT**。
- LGPL（libvips 等）的义务应针对受覆盖的库及实际结合/分发形式核验，不能据依赖关系直接推断链接方整仓必须改为 GPL。
- MPL-2.0（lightningcss）约束**被覆盖的源文件**，不是整仓 copyleft。
- 本源码归档只引用这些依赖，未附带它们的源码或目标代码。若以后复制第三方源码、打包客户端代码或分发镜像，应按具体材料重新核验；不能将“源码发行”当作普遍豁免。

## 10. 以后若分发镜像或预构建二进制

`Dockerfile` 默认 `NODE_IMAGE=node:24.20.0-bookworm-slim`。当前构建将 Next standalone 与预编译 Worker/管理入口追踪到的运行依赖、静态资源和第三方许可文件装入运行阶段，而不是复制完整 `node_modules`。那是**另一类发行物**。

在发布预构建镜像或可执行制品之前，必须另做终态审查，至少包括：

1. 最终 SBOM（npm 生产依赖 + 实际打入的 optional 原生包 + 基础 OS 软件包）；
2. 各组件许可证与 NOTICE/字体/cmap 等附属文本是否随制品保留；
3. LGPL（libvips 等）与 MPL（lightningcss 等，若仍在制品中）适用的对应源码获取、库替换/重链接和安装信息要求；
4. CC-BY 数据（caniuse-lite 等）的署名是否仍适用；
5. Debian/Node 基础镜像中的 GPL/LGPL 系统库。

**本文不对未来镜像作合规背书，也不提供概括法律保证。**

## 11. 方法与范围限制

- 许可证核验依据当前候选源码树、锁文件及本地已安装包的声明与许可证文本，不覆盖旧 Git 历史，也不构成代码原创性或全部素材来源的独立鉴定。安装、测试和构建是否通过，与许可核验属于不同验证事项。
- 传递依赖只展开**与 copyleft、双许可、强制署名或原生二进制相关**的条目，不是完整 SPDX SBOM；大量 MIT/BSD 传递包未逐一列表。
- 可选原生包因平台而异（本机见到 linux-x64 的 libvips/lightningcss 等），不能代表所有目标平台的最终集合。
- 许可证字段以各包当时 `package.json` / LICENSE 为准；上游若更改许可，以新版本为准。
- 维护者授权品牌/截图 ≠ 对第三方外观的鉴定；本文作者未对截图像素做权利检索。

如需完整清单，应在即将发布的**具体制品**上生成 SPDX/SBOM 并对照其实际包含的文件。
