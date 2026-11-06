# WorldCraft 分阶段 PCG 管线设计与验证

本文是「道路 → 地块 → 功能 → 建筑/公园 → 树木」统一可配置生成流程的规范性说明。
实现位置：`src/core/pipeline/`；`src/core/pcg.ts` 保留 `generateScene(doc)` 作为兼容入口。

> **v1.2.0 更新**：S1 已从「规则网格 + 街区」升级为**可编辑道路图 → 平面闭合面提取**，S2 输出**多边形地块**（可非矩形、可凹）并重放空间编辑序列，S4a/S4b/S5 相应改为旋转内接矩形、多边形公园与多边形内净距采样；`SceneDocument` 新增持久化的 `graph` 与 `parcelEdits`。本文第 1–3 节的阶段表与参数表仍然有效，S1/S2 的内部实现以 [EDITABLE_GEOMETRY.md](EDITABLE_GEOMETRY.md) 为准。

---

## 1. 阶段依赖定义

### 1.1 DAG（`STAGE_GRAPH`，声明即约束）

| 阶段 | ID | deps | 类型 | 职责 |
| --- | --- | --- | --- | --- |
| S0 场地基底 | `terrain` | — | core | 场地 AABB、网格行列、地面标高基准 |
| S1 道路网络确定 | `roads` | `terrain` | core | 道路中心线分级、道路带裁剪、内部道路抑制、街区围合 |
| S2 地块划分 | `parcels` | `roads` | core | 街区细分、地块红线 `bounds`、可建范围 `buildable`、临路面 |
| S3 地块功能分配 | `landuse` | `parcels` | core | 功能权重抽样、公园扩张与聚类、水系/地形预留登记 |
| S4a 多类型建筑 | `buildings` | `landuse, parcels` | core | 5 种原型、槽位划分、占地/高度/材质、人工覆写 |
| S4b 多尺寸公园 | `parks` | `landuse, parcels, roads` | core | 口袋/社区/中央三档公园、圆形内切、风格 |
| S5 树木分布 | `trees` | `roads, parcels, landuse, parks` | core | 行道树 + 公园树、路缘/边界净距、最小株距 |
| E1 水系 | `water` | `landuse, parcels, parks` | extension | 消费 `waterReserved` 地块，输出水面（占位） |
| E2 地形要素 | `terrainFeatures` | `roads, parcels, landuse` | extension | 消费 `terrainReserved` 地块，输出台地/坡地（占位） |
| S6 汇总与校验 | `assembly` | 全部 9 个阶段 | assembly | 统计、空间无重叠校验、确定性指纹 |

**拓扑层级（实测 7 层）**：

```
L0  terrain
L1  roads
L2  parcels
L3  landuse
L4  buildings | parks | terrainFeatures | water      ← 同层，可并行
L5  trees
L6  assembly
```

两条刻意设计的依赖取舍：

1. **S4a 与 S4b 同层**：都只依赖 `landuse + parcels(+roads)`，互不依赖，可并行。
2. **S5 不依赖 buildings**：树木只与道路网络、地块边界、公园边界协调，并额外硬性排除「可建地块的可建范围」。因此调整 `density.zoneMultipliers.east` 时，树木、公园、地块、道路全部逐位不变 —— 局部编辑不变量贯穿整条链路。

### 1.2 运行时依赖守卫

`StageContext.upstream(id)` 在执行期检查：**当前阶段只能读取自己 `deps` 中声明过的上游**，越界读取立即抛 `阶段依赖违规`。执行器用 Kahn 拓扑排序保证所有 deps 先产出。这条守卫在开发过程中实际抓到过 3 处遗漏声明（`assembly→terrain`、`terrainFeatures→landuse` 等），说明它不是摆设。

扩展阶段**始终运行**但可标记为「预留」：关闭时只统计预留地块、不生成几何，因此预留数量不会丢失。

---

## 2. 关键数据结构

### 2.1 空间基元

```ts
interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
```

所有空间对象统一携带 AABB。`geometry.ts` 提供 `inset / containsRect / intersects / unionRect / circleInRect / distanceToRect` 与 `SpatialGrid<T>`（均匀格网邻域索引，桶键排序保证遍历确定性）。

### 2.2 阶段输出层（均派生，不持久化）

| 层 | 主要字段 |
| --- | --- |
| `TerrainLayer` | `cols, rows, cellSize, site, groundLevel` |
| `RoadLayer` | `linesX/Z`（中心线，含 `cls: arterial/local`）、`bands`（含 `suppressed`）、`segments`、`blocks`、`centralBounds`、`suppressedIds` |
| `BlockObject` | `id, serial, gx/gz, bounds, isCentralPark` |
| `ParcelObject` | `id, serial, blockId, bounds, buildable, area, zone, frontage[], isCentralPark` |
| `LandUseLayer` | `uses: ParcelUse[]`（`use / clusterId / sizeClass`）、`clusters: ParkCluster[]`、`counts` |
| `BuildingObject` | 既有字段 + `bounds, parcelId, archetype, landUse, setback, trace[]` |
| `ParkObject` | `bounds, shape, x/z, radius, width/depth, style, sizeClass, area, parcelIds[]` |
| `TreeObject` | `x/z, scale, context: street\|park, ownerId, roadClearance, boundaryClearance` |
| `WaterSurface` / `TerrainFeature` | `bounds, parcelIds, placeholder` |
| `AssemblyLayer` | `stats, spatial: SpatialReport, fingerprint` |

`GeneratedScene` 汇总全部图层，并额外提供 `stages: StageRunInfo[]`（阶段、依赖、启用状态、产出数、耗时）与 `spatial: SpatialReport`（`ok / issues[] / checks / minTreeSpacing / minRoadClearance`）。

### 2.3 Scene Schema 变更

- 版本 `1.0.0 → 1.1.0`，`SceneRules` 新增 `pipeline: PipelineRules`。
- `parseSceneDocument()` 对 v1.0.0 存档自动补齐 `defaultPipelineRules()`；其余规则原样保留。
- 新增分组键白名单与子键白名单，未注册字段仍一律拒绝。
- 存档仍只含规则 + 种子 + 人工覆写；几何全部由 `generateScene()` 推导。

---

## 3. 参数项（全部注册在 `RULE_FIELDS`）

参数注册表是单一事实来源：同一份声明驱动 Inspector 控件、`rule.set` 白名单校验、LLM 工具目录。默认值见 `schema.ts::defaultPipelineRules()`。

### S1 道路网络

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.roads.arterialPeriod` | 3 | 1–8 条 | 每隔 N 条道路线升为主干路 |
| `pipeline.roads.localWidth` | 7 | 3–16 m | 支路宽度 |
| `pipeline.roads.arterialWidth` | 11 | 4–24 m | 主干路宽度 |
| `pipeline.roads.suppressParkInterior` | true | bool | 抑制中央公园内部道路；关闭时中央绿地按街区切分为多个公园 |

### S2 地块划分

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.parcels.targetSize` | 20 | 8–60 m | 目标地块边长 |
| `pipeline.parcels.maxSplit` | 2 | 1–4 | 每方向最大细分 |
| `pipeline.parcels.gap` | 1 | 0–6 m | 地块红线缝隙 |
| `pipeline.parcels.setback` | 3 | 1–12 m | 建筑退界（同时形成行道树绿带） |
| `pipeline.parcels.splitJitter` | 0.25 | 0–1 | 细分扰动概率（高级） |

> 实际退界为 `min(setback, min(边长) × 0.18)`，避免小地块被固定退界吃光。

### S3 功能分配

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.landUse.mixPreset` | balanced | balanced/office/research/green | 四类可建功能权重表 |
| `pipeline.landUse.parkRatio` | 0.12 | 0–0.5 | 分散公园比例 |
| `pipeline.landUse.clusterBias` | 0.45 | 0–1 | 公园向相邻地块扩张的概率（形成社区级公园） |
| `pipeline.landUse.plazaRatio` | 0.035 | 0–0.3 | 硬质广场比例 |
| `pipeline.landUse.waterReserveRatio` | 0.02 | 0–0.3 | 水系扩展点预留比例 |
| `pipeline.landUse.terrainReserveRatio` | 0.02 | 0–0.3 | 地形扩展点预留比例 |

### S4a 建筑原型

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.buildings.archetypeJitter` | 0.12 | 0–1 | 脱离功能权重自由抽选原型的概率 |
| `pipeline.buildings.maxPerParcel` | 3 | 1–4 栋 | 单地块建筑槽位上限 |
| `pipeline.buildings.spacing` | 1 | 0–8 m | 同地块槽位净距 |

5 种预制原型（`stages.ts::ARCHETYPES`）：`tower / slab / podium / research / incubator`，各自定义占地率、长宽比、高度系数、退台偏好、槽位数。核心区塔楼权重 ×2.4、外围 ×0.6，与 `centerHigh` 高度剖面共同形成中心高外围低的天际线。

### S4b 公园

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.parks.centralBlocks` | 2 | 1–4 街区 | 中央公园占 N×N 连续街区 |
| `pipeline.parks.inset` | 1.5 | 0–8 m | 公园相对地块并集内缩 |
| `pipeline.parks.pocketMaxArea` | 600 | 200–3000 m² | 口袋公园面积上限 |
| `pipeline.parks.neighborhoodMaxArea` | 5000 | 1000–15000 m² | 社区公园面积上限 |
| `pipeline.parks.styleJitter` | 0.2 | 0–1 | 分散公园改硬质广场的概率 |

### S5 树木分布

| 路径 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `pipeline.trees.streetInterval` | 9 | 4–30 m | 行道树株距 |
| `pipeline.trees.parkSpacing` | 7 | 3–20 m | 公园候选网格间距 |
| `pipeline.trees.roadSetback` | 2 | 0–8 m | 树心距路缘最小净距 |
| `pipeline.trees.boundarySetback` | 1 | 0–8 m | 树心距地块/公园边界最小净距 |
| `pipeline.trees.minSpacing` | 3.5 | 1–12 m | 任意两株最小中心距 |
| `pipeline.trees.jitter` | 0.5 | 0–3 m | 确定性位置扰动 |
| `pipeline.trees.maxTrees` | 1600 | 100–4000 株 | 性能上限 |

### 扩展点

| 路径 | 默认 | 作用 |
| --- | --- | --- |
| `pipeline.extensions.water` | false | 启用后为 `waterReserved` 地块生成占位水面 |
| `pipeline.extensions.terrain` | false | 启用后为 `terrainReserved` 地块生成占位地形要素 |

---

## 4. 空间无重叠契约

生成侧的结构性保证（比事后校验更重要）：

1. **路网**：道路带裁剪到场地 AABB；街区 `bounds` 严格取相邻两条道路带边缘之间，天然不压路。
2. **中央公园**：占整数个街区；其内部道路带从路网中移除，公园 `bounds = inset(街区并集, inset)`。关闭抑制时改为「每个中央街区一个公园」，同样不压路。
3. **地块**：`buildable = inset(bounds, 有效退界)`；建筑 AABB 由 `buildable` 内槽位再内缩得到，故 `建筑 ⊂ buildable ⊂ bounds ⊂ 街区 ⊂ 场地`。
4. **公园聚类**：外接矩形若罩住同街区内未划入公园的地块（L 形聚类），会被拆成单地块公园；聚类不跨 `blockId`，即不跨道路。
5. **圆形公园**：半径取 `min(openSpace.radius, 外接矩形短边 / 2)`，保证内切。
6. **行道树**：沿地块临路面、落在 `bounds − buildable` 的退界绿带内。可行性条件
   `max(boundarySetback, roadSetback − gap/2) ≤ d < 该地块实际退界宽度`；
   窄地块无足够绿带时诚实跳过，不生成冲突树。此时 `距路缘 = gap/2 + d ≥ roadSetback`，`距边界 = d ≥ boundarySetback`。
7. **公园树**：候选限制在公园边界内缩 `boundarySetback`，圆形公园额外限制在内切圆内。
8. **统一硬过滤**：任何树心不得落在「可建地块的 `buildable`」内，也不得落在任何建筑 AABB 内；用 `SpatialGrid` 保证最小株距。
9. **净距定义**：所有净距均为**树心到边界**的距离（非树冠外缘），在 Inspector 与校验器中口径一致。

`validateSpatialLayout()` 检查 14 类冲突：`BUILDING_OUTSIDE_PARCEL / BUILDING_ROAD_OVERLAP / BUILDING_BUILDING_OVERLAP / PARK_OUTSIDE_PARCEL / PARK_CIRCLE_OVERFLOW / PARK_ROAD_OVERLAP / PARK_BUILT_PARCEL_OVERLAP / PARK_PARK_OVERLAP / TREE_ROAD_CLEARANCE / TREE_BOUNDARY_CLEARANCE / TREE_INSIDE_BUILDING / TREE_SPACING / WATER_ROAD_OVERLAP / OUT_OF_SITE / ROAD_OUT_OF_SITE`。报告随 `GeneratedScene` 返回，HUD 与「生成管线」面板实时显示 PASS / 冲突数。

---

## 5. 确定性

- 所有随机值仍是 `sample(seed, 属性盐, 稳定序号...)`，无全局 RNG 流。新增阶段、新增属性盐都不会扰动既有结果。
- 对象 ID 由阶段内稳定序号派生：`bld.<地块序号>.<槽位>`、`prc.<n>`、`park.<cluster>`、`tree.street|park.<...>`。
- `applyCommands` 与 `runPipeline` 都是纯函数；相同 `SceneDocument` → 相同全部图层与相同指纹。
- 指纹涵盖种子、全部规则、覆写、道路带、地块、功能、建筑、公园、树木、水面与地形占位；不含时间戳、名称与阶段耗时。

---

## 6. 验证结果

### 6.1 单元测试（`npm test`，11 个文件 / 77 个用例全绿）

| 文件 | 覆盖 |
| --- | --- |
| `pipeline.test.ts` (10) | DAG 静态校验、拓扑序、并行层级、运行时依赖守卫、路径→阶段映射、全链路确定性、v1.0.0 迁移、扩展点开关、阶段执行记录 |
| `spatial.test.ts` (24) | 默认零冲突；建筑⊂地块/互不重叠/不压路；公园⊂地块/不压路/不压可建地块/互不重叠；圆形内切；树木净距与株距；中央公园内部道路抑制；三档公园 + 五种原型；**14 组参数组合**均 PASS；校验器能主动发现人为注入冲突 |
| `chain.test.ts` (4) | 全链路可回溯（建筑→地块→功能、公园→地块、树→owner）；局部密度编辑时道路/街区/地块/功能/公园/树木/水系逐位不变；各阶段参数只影响声明阶段及下游；参数经命令写入后 diff 可追溯、保存重载一致 |
| 其余 8 个文件 (39) | 原有确定性、局部编辑、NL 解析、命令白名单、schema、分区、撤销重做、diff |

### 6.2 默认场景实测（seed 20261106，400×400 m）

| 指标 | 值 |
| --- | --- |
| 道路带 / 有效道路段 | 18 / 16（主干 6、支路 10、抑制 2） |
| 道路总长 | 6400 m |
| 街区 / 地块 | 64 / 241 |
| 建筑 | 180（塔楼 10 / 板楼 61 / 裙房 29 / 研发 26 / 孵化 54） |
| 公园 | 48（口袋 42 / 社区 5 / 中央 1），总面积 17,499 m² |
| 功能分配 | 办公 50 / 居住 48 / 研发 42 / 商业 35 / 公园 45 / 广场 8 / 水系预留 6 / 地形预留 7 |
| 树木 | 457（行道 277 / 公园 180） |
| 空间校验 | **PASS**，0 冲突；最小株距 3.52 m（要求 ≥3.5）；最小路缘净距 2 m（要求 ≥2） |
| 指纹 | `6306E0CA` |

### 6.3 浏览器端实测（Chrome / WebGL 2.0，控制台零错误）

| 步骤 | 结果 |
| --- | --- |
| 初始加载 | HUD 显示 `建筑 180 / 地块 241 / 公园 48 / 乔木 457 / 空间校验 PASS / v1.1.0` |
| 运行验收演示（6 步） | 生成城市 → 东侧密度 -30% → 撤销 → 重做 → 保存 → 加载，日志 6 条；建筑 180→174，指纹 `6306E0CA → A74CBFE6`，空间校验仍 PASS |
| 保存/加载一致性 | `savedFingerprint = A74CBFE6`，重载后 HUD 指纹一致，`match: true` |
| 「生成管线」面板 | 显示 7 层 DAG、各阶段依赖与产出、扩展点契约、空间校验明细 |
| 结构化命令调参 | `pipeline.landUse.parkRatio = 0.2` → 建筑 174→145、公园 48→63、树木 457→480、指纹 `5E4CEAB5`、空间校验 PASS |
| 「地块/功能」顶视 | 可见规则路网、地块边界线、功能着色、中央圆形公园与多处分散公园 |

### 6.4 已知边界

- 树冠视觉半径未参与净距判定，口径为树心到边界；若需树冠级净距，应把 `minSpacing / roadSetback` 按最大树冠半径上调。
- `suppressParkInterior = false` 时中央绿地被道路切分，不再有 `central` 尺寸等级的单一公园 —— 这是刻意的语义。
- E1/E2 当前只生成占位几何，未实现水系拓扑连通、坡度/高程回填；接口契约已声明在 `STAGE_GRAPH[].contract`。
- 参数组合若把 `boundarySetback` 设得大于 `parcels.setback`，行道树会因绿带不足被跳过（不会生成冲突树），校验仍为 PASS。
