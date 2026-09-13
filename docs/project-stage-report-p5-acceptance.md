# P5 原生发布验收与同模型恢复

> 范围：用户明确选择“先完成隔离验收，暂不切换”。本轮不修改现有实例配置、不重启业务进程、不迁移/清空旧库、不使用现有Docker数据卷、不发布正式GHCR标签。
>
> 状态：**P5隔离发布验收历史快照，正式切换按用户决定暂缓。** 本文保留当时906项回归/15张截图及产物身份；post-v0.1.2修复后的964项/19张截图与新schema证据见docs/post-v0.1.2-remediation-plan.md。不能把任一隔离验收通过等同于正式上线。

## 1. 一致发布单元

同一个候选包含 Next standalone、默认编译Worker、解析器、原生初始化、上传恢复、文件维护、备份恢复命令。包中不带源码编译器、.env、业务storage或测试数据。候选清单记录BUILD_ID、runtime入口SHA-256和聚合身份。

隔离构建使用 .next-p5-qa，不覆盖当前 .next/.next-dev。打包目标必须是新的绝对路径，包含已有空目录也拒绝；不覆盖 .docker-runtime。容器验收只创建带独立owner标签的容器，结束后清理，不操作 yanxing_data 或其他现有卷。

```bash
npm run lint
npm test
node scripts/build-runtime.mjs
YANXING_STANDALONE=1 YANXING_NEXT_DIST_DIR=.next-p5-qa npm run build
node scripts/p5-package.mjs --destination /ABS/NEW-CANDIDATE
node scripts/p5-release-acceptance.mjs --release-root /ABS/NEW-CANDIDATE --with-backup-restore
P5_RELEASE_ROOT=/ABS/NEW-CANDIDATE npm run test:p5:browser
node scripts/p5-package-container.mjs --candidate-root /ABS/NEW-CANDIDATE --image-tag yanxing:UNIQUE-P5-TAG --report-path /ABS/NEW-REPORT.json
npm run test:p5:contention
git diff --check
```

这些命令是隔离验收，不会把候选切到用户访问地址。正式发布仍须明确目录/卷、端口/域名、镜像digest、主密钥保管和停机计划。

## 2. 规则验收覆盖

矩阵是分层证据，不宣称35项全部由单个浏览器脚本完成。

| 规则 | 核心证据 |
| --- | --- |
| AT-01—07 阶段内版本、推进/跳过、已完成阶段补交 | stage-workflow、report-submission-repository、P5浏览器补交/空阶段验证 |
| AT-08—11 准备失败、不回滚提交、幂等及重复键 | report-upload-service / report-submission-repository；P4/P5浏览器丢响应→关闭→重开→同键重试 |
| AT-12—14 并发、实时授权 | P5真多进程confirm；project-owners / submission-workspace-routes；浏览器协作者只读 |
| AT-15—18 旧写入拒绝、完结保护、逻辑删除 | 原生routes / policy / repository；浏览器接替后删除、404与版本不复用 |
| AT-19—24 分析/洞察独立资格及成功历史 | submission-admission / task-repository / executor；发布包真实Worker完成与未完成调用失败 |
| AT-25—30 比较与默认选择 | report-submission-query / workspace UI；早期补交后仍默认最后阶段成果、不把缺分当0 |
| AT-31 长标签、阶段数和版本展示 | 动态标签与UI回归；P5新增实际窄容器卡片宽度断言，不靠viewport xl强行分栏 |
| AT-32—33 进程死亡与回收竞争 | test/p5-fault-acceptance.test.ts：真实SIGKILL、多连接SQLite、挂起HTTP供应商与回收子进程 |
| AT-34 新库/旧库/混合库 | native-bootstrap、schema测试与容器旧库拒绝；拒绝前后旧测试库文件hash不变 |
| AT-35 多入口规则一致 | submission-workspace-routes、job路由、admission；失败任务可按资格手工重试为新代次 |

原生全量测试之外的66项旧纯模块测试使用显式测试夹具，不能作为生产兼容开关；生产无旧模型迁移、双写或替换协议。

## 3. 浏览器与真实Worker

浏览器使用独立数据库、报告根、心跳/ready文件、Chrome profile和随机loopback端口。包括：登录/创建、准备/确认、丢失成功响应的同键重试、当前空阶段、补交与完成时间不变、逻辑删除/版本不复用、计划冻结、DOCX iframe原文、空阶段跳过/补交、协作者读取与403写入拒绝、桌面和移动布局。

浏览器夹具刻意不配置模型渠道，用于观察确认成功不受后台调度失败影响，以及缺分不显示为0；截图中的配置失败/暂无分析是预期状态。分析和洞察成功另由同一候选的真实Worker验收验证，不把浏览器的未计算状态算作成功。

发布包验收不只mock HTTP返回：实际standalone + 编译Worker + 编译PDF/DOCX解析子进程运行；受控Chat Completions端点分别制造请求失败和有效分析/洞察成功，检查真实结果、aiScore和HTML。未完成调用进入AI_CALL_INCOMPLETE，不自动重放；允许按资格手工重试为新代次。Web/Worker均有SIGKILL重启验证。

P5发现并修正的验收问题：
- 冒烟项目的阶段编号必须跨课题唯一；计划更新不能省掉AI准入需要的工作内容/日期。
- 冒烟脚本不自动重放AI_CALL_INCOMPLETE；有资格的用户仍可显式创建新代次重试。
- 可预览DOCX需要完整OPC关系与正确ZIP CRC，浏览器原文位于独立iframe，不能只检查外层innerText。
- 分析卡片改为容器宽度响应布局；“查看最近提交”明确表示全课题最新，不混淆“当前阶段成果”。

## 4. 真实故障与争用测量

P5进程测试验证：
1. confirm事务提交后、发送回执前SIGKILL。新连接使用同一请求重放，report/outbox/quota/receipt保持同一份。
2. 同请求竞争只有一份提交；两个update可串行分配不同序号；两个completion一成功、一STAGE_COMPLETION_CHANGED。
3. 本机供应商挂起，调用意图已持久化后杀Worker。租约恢复后请求计数仍1；任务failed/AI_CALL_INCOMPLETE，保留started调用记录，禁止自动重放；手工重试创建新generation。
4. 真正并发的确认和回收不删formal/tombstone；失败遗留准备文件可被回收。

争用脚本是**SQLite确认事务微基准，不是HTTP/解析/AI吞吐，不是生产SLO**。BEGIN IMMEDIATE单独计时，包含执行和获取写锁的耗时，不冒充内核锁跟踪；不使用“总耗时减无竞争样本”伪造锁等待。

已测共享主机样本：Node24.20.0、Linux、16CPU、4并发进程、20轮共80次update、4次竞争completion、920字节DOCX、WAL、busy_timeout10秒、0次模型请求。update 80成功/0 busy，确认p50 24.53ms/p95 63.76ms、max90.12ms；BEGIN IMMEDIATE p50 18.45ms/p95 53.89ms、max79.50ms。completion 1成功+3冲突。82条报告、82个唯一序号/配额分配、0个进行中阶段、0旧表，状态不变量通过。该次loadavg为3.17/2.87/2.78，原始JSON为out/p5-contention.json；负载/样本不代表目标生产机器容量。

## 5. 原生备份

先停止所有Web、Worker、恢复和维护写入者。工具额外检查活动任务、receiving/parsing/ready/reclaiming准备记录和active预留；有这些状态时返回NOT_QUIESCENT，不能伪造过期时间或跳过检查。已有READY准备应按正常协议确认或等待真实过期回收后再备份。

```bash
# 主密钥由环境/密钥管理系统提供；此处不生成新密钥。
npm run backup:native -- backup   --database /srv/yanxing-native/yanxing.sqlite   --storage-root /srv/yanxing-native/reports   --destination /srv/yanxing-backups/NEW-ARCHIVE
```

发布包中等价入口是 node /RELEASE/.runtime/scripts/native-backup.mjs。路径全部显式绝对路径；不使用默认业务库、不支持force，不接受符号链接、交叠路径或覆盖既有目标。

备份使用SQLite write fence + backup快照，不复制运行中的主DB文件；校验integrity/FK/native身份。保留正式与墓碑原文、知识/品牌文件、正文、结果/审计/任务调用状态和加密配置；正式/墓碑报告与知识文件的hash及大小必须逐项匹配数据库固定身份，缺失或不符会拒绝备份/恢复；不包含tmp、WAL/SHM、运行产物或主密钥。

每文件SHA-256只用于完整性；清单始终用主密钥派生的HMAC认证，不接受去掉MAC的降级。备份和恢复均实际验证配置及冻结任务密文可解密。归档本身仍包含敏感明文，目录0700/文件0600不能替代离线加密和访问管理。

YANXING_SETTINGS_ENCRYPTION_KEY或显式--key-file二选一；没有隐式.settings-key回退。密钥文件必须独立保管，不能放到归档收集目录。key-file按原始字节读取，从环境导出应使用printf避免新增换行。主密钥和匹配的镜像digest另行安全备份。

## 6. 同路径恢复与中断处置

1. 保持所有写入者停止，核对归档、主密钥、镜像版本和绑定绝对路径。
2. 恢复目标必须不存在。原故障目录由操作者在确认后另行隔离保留；工具不负责删除、覆盖或搬迁它。
3. 使用同一绝对数据库/reports路径恢复，不改submission_storage_root或source身份。
4. 验证恢复的文件、结果、存储计数、权限、任务和模型调用状态。备份点后的提交属于RPO范围，不应自动重跑模型调用。
5. 核对账号/会话、供应商可用性与正式入口后再手动启动。恢复命令不会启动服务。

```bash
npm run backup:native -- restore   --archive /srv/yanxing-backups/ARCHIVE   --database /srv/yanxing-native/yanxing.sqlite   --storage-root /srv/yanxing-native/reports
```

发布在离线条件下进行；不得将无覆盖发布误称为整个文件系统的单次事务。恢复中断标记用于阻止半成品启动。异常后保留标记、归档和部分目录，不手工删标记来绕过；保持停机并核对后，由操作者将部分目录及其对应带hash的标记一同移入独立故障保留位置，再从原归档重新完整恢复；不得只移除标记后启动半成品。备份入口也拒绝该标记，不会把半成品再次当作健康数据。

### Docker的不存在目标约束

/app/storage若是卷挂载根，总是已存在，工具会拒绝，即使它为空。可使用**独立维护容器**：将匹配的自包含发布包挂到/tools（只读），新可写恢复父目录挂到/app，将归档挂到/backup（只读）。/app/storage此时尚不存在；工具按原绑定路径创建它。恢复后的宿主机RECOVERY_PARENT/storage才作为未来正式容器的/app/storage绑定目录。维护容器不启动Web/Worker，不接触旧卷。

```bash
# 所有路径须事先核对；RECOVERY_PARENT是新的空父目录，UID1000可写。
# RELEASE对应原备份的原生发布包，BACKUP_PARENT内含ARCHIVE。
docker run --rm --network none --read-only --user 1000:1000   --tmpfs /tmp:rw,noexec,nosuid,size=128m   -e YANXING_SETTINGS_ENCRYPTION_KEY   --mount type=bind,src="$RELEASE",dst=/tools,readonly   --mount type=bind,src="$RECOVERY_PARENT",dst=/app   --mount type=bind,src="$BACKUP_PARENT",dst=/backup,readonly   node:24.20.0-bookworm-slim   node /tools/.runtime/scripts/native-backup.mjs restore   --archive /backup/ARCHIVE   --database /app/storage/yanxing.sqlite --storage-root /app/storage/reports
```

本轮不执行上述生产路径操作。正式恢复是否使用新的bind目录或新的卷，由运维另行确认；禁止在原卷叠加解包。

## 7. 最终证据

### 2026-09-11 最终封包

| 项目 | 验收结果 |
| --- | --- |
| 最终候选 | out/p5-verified-candidate；早期interim/final候选不作为最终封包 |
| BUILD_ID | f7vayVt_XsRpoH9geq7Kp |
| 发布聚合身份 | 8c1a981caf9f2afba1a02a4f1b89b7d232259f635339f5c6f7ca9653b0d6d5fb |
| 原生schema | yanxing-native-p3；checksum 833c06e52c7cfc72f4abc6e258a99a7c6cdb74d13144211790bb959eed8183af |
| 隔离镜像 | yanxing:p5-qa-verified；非latest、未推送正式registry |
| 镜像ID | sha256:a513531f8e76fd9e606f21f494d500808acb76111ec447ecb92ca1af811ef20c |
| 全量回归 | **906通过＝840原生＋66显式离线夹具；0失败、0跳过** |
| 构建/静态检查 | lint、runtime构建、独立Next生产构建、git diff --check通过；QA生成的默认TS配置已还原 |
| 浏览器 | 最终候选实际Web+Worker；15张截图，2次完全相同确认请求只产生1条提交，7次合理登录初始化，0付费模型调用 |
| 桌面/移动 | 分析卡片按实际容器宽度排版；390px已填充报告无横向溢出，底部卡片可达 |
| 容器 | UID1000、只读根、默认Worker/联合健康通过、代码不可写、正常停止exit0 |
| 旧库拒绝 | 旧测试库hash前后相同、Web/Worker未启动、migrate拒绝后exit1/unhealthy |
| 真实恢复 | **使用候选中的编译native-backup.mjs，未回退tsx**；停自有服务→备份→原目录隔离→同路径恢复→重启复核 |
| 恢复后结果 | 5份live报告；PDF/DOCX原文分别644/1754字节，分析snapshot与洞察HTML保留，aiScore80 |
| 任务及模型调用恢复 | 当前探针逐项比较任务身份、代次、状态及调用身份、started/completed状态；无自动模型重放 |
| 故障保护 | 源hash/大小不符、缺文件、错误key、篡改/剥离MAC、覆盖目标、外部知识根、中断恢复均拒绝；18项备份专项测试包含正式与墓碑文件 |

汇总：out/p5-verified-summary.json。原始证据：
- out/p5-verified-release.json、/tmp/p5-verified-release.log：真实Web/Worker、失败/成功与编译版恢复。
- out/p5-verified-container.json：最终镜像、只读/非root、旧库无改写与清理。
- out/p5-contention.json：真实多进程事务/BEGIN IMMEDIATE测量。
- /tmp/yanxing-p5-verified-tests.log：906项全量回归。
- out/p5-verified-browser：已保留15张浏览器截图；原始截图与隔离进程日志在/tmp/yanxing-p5-browser-Keodrt。

发布追踪额外排除旧.next*、out候选树和.settings-key，避免把旧构建依赖递归带入新运行时；最终runtime清单1159条。发布包未包含业务storage、.env或测试数据，未修改根.docker-runtime/.docker-build.json。验收容器及发布演练子进程已清理，候选与非latest测试镜像保留供审阅。

### 仍明确保留的边界

- **正式环境切换未执行。** 目标目录/卷、HTTPS与反向代理、正式密钥、真实供应商及停机/RPO计划须在另行确认后执行。
- 事务微基准不是生产容量、HTTP/AI延迟或SLO；本轮不声称真实供应商/付费调用、大文件极限或所有生产网络故障已经验证。
- 备份为离线同模型同路径恢复，不是热备、迁移、改根或旧模型降级工具；归档不是自动加密的数据保险箱，密钥必须分开保管。
- 正式/墓碑文件仍长期保留；物理保留期限没有被本轮擅自确定。

