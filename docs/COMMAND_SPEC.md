# 命令与规则字段规范（Scene Schema v1.2.0）

所有外部输入最终都必须变成下面这份封闭命令集，并通过 `validateCommands()` 才能执行。
v1.1.0 新增 `pipeline` 规则分组（30 项阶段参数）；v1.2.0 新增可编辑道路图与多边形地块的 `graph.*` / `parcel.*` 命令族。这些字段与命令同样受本规范的路径白名单与取值夹紧约束；完整参数表见 [PCG_PIPELINE.md](PCG_PIPELINE.md)，图形编辑规范见 [EDITABLE_GEOMETRY.md](EDITABLE_GEOMETRY.md)。

## 1. Command 联合类型

| op | 字段 | 语义 | 示例 |
| --- | --- | --- | --- |
| `scene.create` | `width?` `depth?` `seed?` `name?` | 重建场景：规则恢复默认、清空人工覆写 | `{"op":"scene.create","width":400,"depth":400}` |
| `scene.reset` | — | 恢复默认规则（保留当前种子） | `{"op":"scene.reset"}` |
| `seed.set` | `value: number` | 设置随机种子（取整） | `{"op":"seed.set","value":12345}` |
| `rule.set` | `path: string` `value: number\|string\|boolean` | 写单条已注册规则，取值自动夹紧 | `{"op":"rule.set","path":"height.max","value":200}` |
| `density.adjust` | `zone` `mode` `delta?` `value?` | 调整密度倍率 | `{"op":"density.adjust","zone":"east","mode":"relative","delta":-0.3}` |
| `height.adjust` | `zone` `mode` `delta?` `value?` | 调整高度倍率 | `{"op":"height.adjust","zone":"west","mode":"relative","delta":0.2}` |
| `object.override` | `id` `patch` | 单体表现层覆写 | `{"op":"object.override","id":"bld.31.18","patch":{"height":80}}` |
| `object.delete` | `id` | 标记删除（可恢复） | `{"op":"object.delete","id":"bld.31.18"}` |
| `object.restore` | `id` | 恢复已删除对象 | `{"op":"object.restore","id":"bld.31.18"}` |
| `camera.set` | `preset: iso\|top\|front\|ne35` | 切换相机，不改变文档 | `{"op":"camera.set","preset":"ne35"}` |

### 可编辑道路图与多边形地块命令（v1.2.0）

| op | 字段 | 语义 |
| --- | --- | --- |
| `graph.regenerate` | — | 按当前规则重建正交道路图 |
| `graph.node.add` | `x` `z` `id?` | 新增道路节点（坐标夹紧到场地） |
| `graph.node.move` | `id` `x` `z` | 移动节点，改变道路走向；所有关联地块与下游自动重适配 |
| `graph.node.remove` | `id` | 删除节点并同时移除关联路段 |
| `graph.edge.add` | `from` `to` `cls?` `width?` `id?` | 新增路段（改变连通关系）；交叉处自动插入节点 |
| `graph.edge.remove` | `id` | 删除路段，相邻闭合面自动合并 |
| `graph.edge.update` | `id` `cls?` `width?` | 修改道路等级 / 宽度 |
| `parcel.split` | `a` `b` | 用直线 A→B 切分被穿过的所有地块（取最长内部弦） |
| `parcel.merge` | `a` `b` | 合并两点所在、真正共边的两个地块 |
| `parcel.vertex` | `at` `to` | 移动共享顶点；图节点同步移动，道路段上的孤立顶点被拒绝 |
| `parcel.edits.clear` | — | 清空地块编辑序列 |

所有坐标点格式为 `{"x":number,"z":number}`；节点/路段 ID 需匹配 `[A-Za-z0-9_.-]{1,40}`；`graph.edge.add` 要求两端为不同且存在的节点。`terrain.width/depth` 变化时命令层会按比例缩放全部图节点以保持面积守恒。

图形编辑的结构化命令示例见 [EDITABLE_GEOMETRY.md](EDITABLE_GEOMETRY.md) 第 6 节与 AI Command 面板的「图形：…」预设。

### 约束

- `zone` 属于 `all | core | east | west | north | south`。
- `mode: relative` 必须给 `delta`（比例，`-0.3` = 降低 30%），对当前值做乘法：`new = old × (1 + delta)`。
- `mode: absolute` 必须给 `value`：分区倍率直接设为该值；`zone=all` 时表示把 `density.base`（或 `height.base/max`）设/缩放到该值。
- 倍率被夹紧在 `[0, 2]`（高度 `[0.2, 2]`），`delta` 夹紧在 `[-0.95, 5]`。
- `object.*` 的 `id` 必须匹配 `^bld\.-?\d+\.-?\d+$`；`patch.color` 必须是 `#RRGGBB`。
- 单次命令数组上限 32 条；空数组被拒绝。
- 未知 `op`、未注册 `path`、非法取值一律拒绝，并在 UI 显示错误。

### 变更记录

执行器产出 `RuleChange[]`：`{ path, label, before, after, scope, source, note }`。`source` ∈ `nl | llm | inspector | structured | system`。系统类操作（撤销/重做/加载/导入/重置）用 `diffDocuments()` 比较前后文档生成同样的记录，写入规则变化时间线。

---

## 2. 规则字段注册表（64 项）

`RULE_FIELDS` 位于 `src/core/fields.ts`。`rule.set` 只能写这里的路径。

### 地形与路网

| 路径 | 说明 | 范围 / 单位 |
| --- | --- | --- |
| `terrain.width` | 场地东西向尺寸 | 80–1200 m |
| `terrain.depth` | 场地南北向尺寸 | 80–1200 m |
| `terrain.cellSize` | 地块网格边长（高级） | 4–24 m |
| `terrain.blockPeriod` | 每隔多少格一条街道（高级） | 3–16 格 |
| `terrain.streetWidth` | 街道视觉宽度（高级） | 3–20 m |

### 建筑高度

| 路径 | 说明 | 范围 |
| --- | --- | --- |
| `height.base` | 外围基准高度 | 6–120 m |
| `height.max` | 中心峰值高度 | 20–400 m |
| `height.taper` | 中心向外衰减指数（高级） | 0.2–4 |
| `height.jitter` | 高度扰动（高级） | 0–0.8 |
| `height.profile` | `centerHigh` / `uniform` / `random` | 枚举 |
| `height.zoneMultipliers.{core,east,west,north,south}` | 分区高度倍率（高级） | 0.2–2 × |

### 分布密度

| 路径 | 说明 | 范围 |
| --- | --- | --- |
| `density.base` | 全局基础占地概率 | 0.05–1 |
| `density.zoneMultipliers.{core,east,west,north,south}` | 分区密度倍率 | 0–2 × |

### 中央开放空间

| 路径 | 说明 | 范围 |
| --- | --- | --- |
| `openSpace.enabled` | 是否保留禁建区 | 布尔（以 `"true"/"false"` 枚举传入） |
| `openSpace.shape` | `circle` / `rect` | 枚举 |
| `openSpace.radius` | 圆形半径 | 10–160 m |
| `openSpace.width` / `openSpace.depth` | 矩形宽/深（高级） | 20–300 m |
| `openSpace.style` | `park` / `plaza` / `water` | 枚举 |
| `openSpace.treeCount` | 乔木数量（高级） | 0–240 株 |
| `openSpace.offsetX` / `offsetZ` | 相对中心偏移（高级） | −150–150 m |

### 材质与表现

| 路径 | 说明 | 范围 |
| --- | --- | --- |
| `material.palette` | `future` / `concrete` / `warm` / `mono` | 枚举 |
| `material.glassRatio` | 玻璃幕墙占比（高级） | 0–1 |
| `material.roofStyle` | `flat` / `stepped` / `mixed`（高级） | 枚举 |
| `material.emissive` | 夜景自发光（高级） | 0–1 |

> 所有数值都是**用户可调的默认参数**，不是规划规范指标；`groundLevel` 为保留字段，V0.1 地形为平面，不生成起伏。

### 分阶段 PCG 管线参数（30 项，v1.1.0 新增）

| 分组 | 路径 | 默认 | 范围 |
| --- | --- | --- | --- |
| S1 道路 | `pipeline.roads.arterialPeriod` | 3 | 1–8 条 |
| | `pipeline.roads.localWidth` | 7 | 3–16 m |
| | `pipeline.roads.arterialWidth` | 11 | 4–24 m |
| | `pipeline.roads.suppressParkInterior` | true | bool |
| S2 地块 | `pipeline.parcels.targetSize` | 20 | 8–60 m |
| | `pipeline.parcels.maxSplit` | 2 | 1–4 |
| | `pipeline.parcels.gap` | 1 | 0–6 m |
| | `pipeline.parcels.setback` | 3 | 1–12 m |
| | `pipeline.parcels.splitJitter` | 0.25 | 0–1 |
| S3 功能 | `pipeline.landUse.mixPreset` | balanced | balanced/office/research/green |
| | `pipeline.landUse.parkRatio` | 0.12 | 0–0.5 |
| | `pipeline.landUse.clusterBias` | 0.45 | 0–1 |
| | `pipeline.landUse.plazaRatio` | 0.035 | 0–0.3 |
| | `pipeline.landUse.waterReserveRatio` | 0.02 | 0–0.3 |
| | `pipeline.landUse.terrainReserveRatio` | 0.02 | 0–0.3 |
| S4a 建筑 | `pipeline.buildings.archetypeJitter` | 0.12 | 0–1 |
| | `pipeline.buildings.maxPerParcel` | 3 | 1–4 栋 |
| | `pipeline.buildings.spacing` | 1 | 0–8 m |
| S4b 公园 | `pipeline.parks.centralBlocks` | 2 | 1–4 街区 |
| | `pipeline.parks.inset` | 1.5 | 0–8 m |
| | `pipeline.parks.pocketMaxArea` | 600 | 200–3000 m² |
| | `pipeline.parks.neighborhoodMaxArea` | 5000 | 1000–15000 m² |
| | `pipeline.parks.styleJitter` | 0.2 | 0–1 |
| S5 树木 | `pipeline.trees.streetInterval` | 9 | 4–30 m |
| | `pipeline.trees.parkSpacing` | 7 | 3–20 m |
| | `pipeline.trees.roadSetback` | 2 | 0–8 m |
| | `pipeline.trees.boundarySetback` | 1 | 0–8 m |
| | `pipeline.trees.minSpacing` | 3.5 | 1–12 m |
| | `pipeline.trees.jitter` | 0.5 | 0–3 m |
| | `pipeline.trees.maxTrees` | 1600 | 100–4000 株 |
| 扩展点 | `pipeline.extensions.water` | false | bool |
| | `pipeline.extensions.terrain` | false | bool |

布尔型字段以 `"true"/"false"` 枚举形式注册，`validateRuleValue()` 会把字符串或布尔值统一收敛为布尔。

**阶段影响关系**（参数改动会波及哪些下游，由 `stageForPath()` 与 `downstreamOf()` 计算）：

| 参数前缀 | 首影响阶段 | 下游 |
| --- | --- | --- |
| `pipeline.roads.*` | `roads` | parcels → landuse → buildings/parks → trees → assembly |
| `pipeline.parcels.*` | `parcels` | landuse → buildings/parks → trees → assembly |
| `pipeline.landUse.*` / `openSpace.*` | `landuse` / `parks` | buildings/parks → trees → assembly |
| `pipeline.buildings.*` / `density.*` / `height.*` | `buildings` | assembly（**不影响 trees**） |
| `pipeline.trees.*` | `trees` | assembly |
| `pipeline.extensions.water` | `water` | assembly |

---

## 3. 本地中文解析器覆盖的句式

`parseNaturalLanguage(input, { seed, selectedId })` 返回 `{ commands, uiActions, matched, confidence, explanation }`。

| 类别 | 例句 | 产物 |
| --- | --- | --- |
| 生成场景 | 生成一座 400m × 400m 的未来城市，中央建筑较高，外围建筑较低，保留一片中央公共开放空间。 | `scene.create(400,400)` + `rule.set` ×若干 |
| 尺寸 | 400 米见方 / 600 × 800 m | `scene.create.width/depth` |
| 密度相对调整 | 将东侧建筑密度降低 30%，其他区域不变。 | `density.adjust east relative -0.3` |
| 密度绝对值 | 将西侧建筑密度设为 45% | `density.adjust west absolute 0.45` |
| 高度调整 | 降低东侧建筑高度 30% | `height.adjust east relative -0.3` |
| 种子 | 种子改为 12345 / 换一批 | `seed.set` |
| 开放空间 | 取消中央开放空间 / 开放空间半径扩大到 60 米 | `rule.set` |
| 材质 | 改成暖色陶板 / 未来感 | `material.palette` |
| 视角 | 顶视 / 东北 35 度视角 / 等轴测 | `camera.set` |
| 工作台动作 | 撤销 / 重做 / 保存 / 加载 / 导出 / 删除选中 / 查看规则变化 | `uiActions[]` |
| 范围约束 | 其他区域不变 / 其余不变 / 仅该区域 | 仅写入说明，**不产生命令**（由架构保证） |

分区词表按长度降序匹配：东侧/东边/东部/东区/东面/东片区、西/北/南同理、核心区/中心区/中央区/中心/中央、全局/整体/全部/所有/整个城市。

**识别失败时**：`commands=[]`、`confidence=0`、`explanation` 明确说明 V0.1 只支持已注册规则可表达的操作，并引导改用示例语句、参数面板或结构化命令 JSON。不会静默执行、不会猜测。

---

## 4. 可选 LLM 适配器契约

配置位置：AI Command → 「AI 接口设置」。`enabled / baseUrl / model / apiKey` 存于 `localStorage['worldcraft.llm.v1']`，**不写入源码、不进 git**。

请求：`POST {baseUrl}/chat/completions`，`temperature: 0`，`response_format: {type:'json_object'}`，消息为：

- **system**：由 `buildSystemPrompt()` 生成，内嵌 `llmFieldCatalog()` 的全部已注册路径（含范围与枚举）+ 完整命令文档 + 当前规则摘要与种子。
- **user**：用户原始输入。

期望响应：

```json
{ "commands": [ { "op": "density.adjust", "zone": "east", "mode": "relative", "delta": -0.3 } ],
  "explanation": "东侧密度倍率由 1 调整为 0.7，其余分区不变" }
```

**执行链**：`choices[0].message.content` → 去 Markdown 代码块 → `JSON.parse` → `validateCommands()` → `applyCommands()`。任何一步失败都记录原因并回退本地解析器；LLM 输出永远不会直接触达 Three.js。

生产建议：浏览器直连会在本机请求中携带密钥，应改为自有后端代理，并把工具调用改成结构化 function calling / JSON Schema 约束。

---

## 5. 无 AI 时的三条验证路径

1. **本地解析器**：输入中文 → 查看命令 JSON 预览 → 「校验并执行」。
2. **手工结构化命令**：直接编辑命令 JSON 文本框 → 「校验并执行」。例如粘贴：
   ```json
   [
     {"op":"scene.create","width":400,"depth":400},
     {"op":"rule.set","path":"height.profile","value":"centerHigh"},
     {"op":"rule.set","path":"openSpace.enabled","value":true},
     {"op":"density.adjust","zone":"east","mode":"relative","delta":-0.3}
   ]
   ```
3. **PCG Inspector**：直接拖参数滑块 / 改种子 / 改分区倍率，走同一执行器与同一变更记录。
4. **管线参数预设**：命令面板提供「主干路加密 / 公园比例 20% / 地块细分 3×3 / 行道树株距 6m / 启用水系预留」等结构化命令芯片，点击后 JSON 可直接编辑再「校验并执行」。

三条路径产生的 `Command[]` 与规则变化记录完全一致，可交叉核对。

管线参数的结构化命令示例：

```json
[
  {"op":"rule.set","path":"pipeline.roads.arterialPeriod","value":2},
  {"op":"rule.set","path":"pipeline.landUse.parkRatio","value":0.2},
  {"op":"rule.set","path":"pipeline.parcels.maxSplit","value":3},
  {"op":"rule.set","path":"pipeline.trees.streetInterval","value":6},
  {"op":"rule.set","path":"pipeline.extensions.water","value":true}
]
```

每条都会经 `validateRuleValue()` 夹紧到注册表范围，并在「规则变化」时间线留下 `before → after`。执行后 `GeneratedScene.spatial.ok` 必须仍为 `true`（14 组参数组合已由 `spatial.test.ts` 覆盖）。
