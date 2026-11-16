# PROV-INHERIT-001 设计 · 团队模型配置单源化（inheritModelSettings 治本）

日期：2026-11-16 ｜ 状态：待总务核验 ｜ 前置：audit/model-input-0.4.25 (c3d4fbf)

## 1. 病根三腿（盘上读数，0.4.24 码）

| # | 腿 | 位置 | 恶果 |
|---|----|------|------|
| 1 | 建组一次性播种冻结 | lifecycle.js:484-493 `settingsSeeded` 门 + shared.js `cloneModelPatch`（flag wx 存在不更新） | 副本冻在建组当天，母本演进永不见（esp32dev 连 contextWindow 修复都没跟上） |
| 2 | 启动再生字段硬编码 | models.js `ensureInstanceModel`→`writeInstanceModelConfig` :347 重建 models 数组只带 `{id,maxTokens}` | 手改副本下次 startTeam 即被洗（IMG-VISION-001 三轮实锤） |
| 3 | 装载白名单剥字段 | models.js:181 `document.models.map(validateStoredModel)` → shared.js `validateModelInput` 白名单无 input | models.json 声明的 input 模态进不了内存，pi-ai 本地拒图 |

`inheritModelSettings` 现成键消费方（有名有实，语义错）：manager.js:62（默认开）、lifecycle.js:484（seeding 门控）、托管区 production.patch.yml `inheritModelSettings: true`——只管"建组时刻 seed 一次"，非真继承。

## 2. 方案（复用 DSH 原生层，不自造第二套）

DSH 分层语义（dsh/lib/profile-boot，@deepseek-ai/dsh-app-boot merge=后层 entryMap.set 后到胜）：
`bundle 层 < profiles/<p>/cordis.patch.yml < **$DSH_HOME/cordis.patch.yml（home 级 user patch，优先级高于 profile 层）** < --patch overlays（argv 序，后者胜）`

团队进程 DSH_HOME=teams/<id>/home。单源化 = 三文件形制：

1. **teams/<id>/home/cordis.patch.yml = symlink → 母本 profiles/web/cordis.patch.yml**
   模型定义走 DSH 原生 home 级层，母本即改即得（进程起时读盘），drift 物理消灭。
   手写过 home 根真文件 = 用户显式 local override，linkModelPatch 见真文件不动。
2. **teams/<id>/model-selection.patch.yml（ds-headbot 生成，spawn 追加 --patch）**
   只装团队自己的 `agent-default-model` 选择（provider+model 两字段）——overlay 最外层，
   压得住母本携带的 controller 选择。applyTeamModel 改写此件（快照/回滚同件走）。
3. **teams/<id>/model-override.patch.yml（人手置，可选）**
   spawn 检测到即追加为最后一个 --patch = 显式团队 override 压住一切。ds-headbot 不生成不回收。

**team profile 层（home/profiles/web/cordis.patch.yml）不再承载模型段**；ensureInstanceModel 撤
writeInstanceModelConfig(home)，writeInstanceModelConfig 本体保留（controller/母本单源仍由它维护，
input 透传腿=c3d4fbf）。cloneModelPatch 撤销（总务裁"撤或降级"取撤）。

**迁移（升级路径，CHANGELOG 记）**：ensureInstanceModel 每次 start 幂等执行 linkModelPatch——
检测 profile 层旧全量副本（真文件）→ rename `.model-inherited-<ts>.bak`（不静默删）→ 建 home 根
symlink；settingsSeeded=true 的存量队同样吃到（ensure 在 startRoutine :342，先于 spawn）。

## 3. 验收测试矩阵（六案 + 反证）

1. 新建 team 即单源：provisionHome 后 home/cordis.patch.yml 是 symlink→母本；profile 层无 llm-*/agent-default-model 全量段。
2. drift 消灭：母本新增模型条目（带 input）后 startTeam，团队读盘经 link 所见=母本全文（含新条目+input）。
3. 旧副本迁移：预置 profile 层真文件全量副本 → ensure 后其成 .model-inherited-*.bak、home 根 link 在位。
4. 显式 override 案：手置 home/cordis.patch.yml 真文件 → linkModelPatch 返回 false 不动它。
5. **团队选择生效案（总务点名）**：team.modelId≠controller.modelId 时 spawn args 含 model-selection.patch.yml 且其内容=团队选择（agent-default-model.provider/model=团队账）。
6. **override 分层案（总务点名）**：model-override.patch.yml 存在 → spawn args 内其 --patch 位于 model-selection **之后**（后者胜语义成立）。

反证刀：link 换回 copy→案1红；ensure 恢复 writeInstanceModelConfig(home)→案3红；spawn 撤 overlay 注入→案5/6红。

## 4. 风险与对策

- 母本 patch 写坏=全队模型面同坏（单源代价）：母本写腿 writeInstanceModelConfig 有 captureFiles 快照回滚先例（controllerModelFiles 域），且读方 DSH 对坏 YAML 有 fail-loud 面。
- 旧副本 .bak 后用户旧手改不自动复活：override 文件即复活通道，CHANGELOG 写明。
- bot/state.json 的 bot.model ref 优先级高于 patch 选择（ds-bot 层既有形制），writeBotModelState 保留为账面同步。
