# 可编辑道路图与多边形地块系统（v1.2.0）

本文说明把 v1.1.0 的「规则化正交路网 + 矩形地块」升级为**可编辑平面图系统**的设计、数据结构、一致性契约与验证结果。

---

## 1. 目标与关键判断

| 目标 | 实现 |
| --- | --- |
| 增删道路节点与路段、改走向与连通关系 | `RoadGraph` 作为**持久化实体**，配套 `graph.*` 命令 |
| 生成 / 拆分 / 合并 / 修改非矩形、多边形、凹凸边界地块 | 从平面图提取闭合面 + 空间操作序列 `parcelEdits` |
| 道路与地块边界闭合、无重叠、关系一致 | 半边面提取 + 交点自动切分 + 面积守恒校验 |
| 编辑后建筑 / 公园 / 树自动重适配复杂地块 | 旋转内接矩形族、多边形公园三角化、多边形内净距采样 |
| 多次编辑仍一致、可运行 | 纯函数管线 + 文档快照撤销 + 确定性哈希 |

**核心判断**：地块不应是"网格里被排除道路后的矩形"，而应是**道路图围合出的平面有界面**。这样：
- 改一条斜向边，相邻地块自动变梯形/三角形，无需为每种形状写特例；
- 删两条相邻边，三个面自然合并成 L 形**凹多边形**；
- 道路与地块共享同一条边（同一对节点），闭合与一致性来自拓扑而非事后修补。

**编辑结果必须持久化**：道路图是 `SceneDocument.graph`，不是从规则派生的中间量。只改规则参数不会偷偷重建图；需要 `graph.regenerate` 显式重建。地块编辑是**空间操作序列**（切割线、合并锚点、顶点位移），每次生成按空间位置重放，因此改道路后编辑仍附着于正确位置。

---

## 2. 关键数据结构

```ts
interface GraphNode { id: string; x: number; z: number }
interface GraphEdge { id: string; from: string; to: string; cls: 'arterial'|'local'; width: number }
interface RoadGraph { nodes: GraphNode[]; edges: GraphEdge[] }

type ParcelEdit =
  | { id; kind:'split';  a: Point2; b: Point2 }   // 切割线
  | { id; kind:'merge';  a: Point2; b: Point2 }   // 两个地块内的锚点
  | { id; kind:'vertex'; at: Point2; to: Point2 } // 顶点位移

interface SceneDocument {
  schemaVersion: '1.2.0';       // v1.0.0 / v1.1.0 自动迁移
  rules: SceneRules;            // 含 pipeline 30 项参数
  graph: RoadGraph;             // 可编辑道路图
  parcelEdits: ParcelEdit[];    // 空间操作序列
  overrides: Record<string, ObjectOverride>;
  seed, revision, id, name, createdAt, updatedAt
}
```

生成结果侧的关键对象：

| 对象 | 新增字段 | 用途 |
| --- | --- | --- |
| `ParcelObject` | `polygon: Polygon2`、`isConcave`、`sourceFaceKey`、`editDepth` | 地块红线（可凹），阶段追溯 |
| `BuildingObject` | `orientation`、`footprint: Point2[]` | 旋转足迹，贴合斜边 |
| `ParkObject` | `polygon: Polygon2`、`shape: 'circle'|'rect'|'polygon'` | 公园范围直接取地块多边形 |
| `RoadBand/RoadSegment` | `a/b/length/angle/boundary` | 任意走向道路段 |
| `GeneratedScene` | `graphNodes`、`roadEdges`、`skippedEdits`、`faceIssues`、`spatial` | 编辑状态与校验报告 |

`Point2 = {x,z}`，`Polygon2 = Point2[]`（环序、不重复首点、允许凹）。几何内核位于 `src/core/geom/polygon.ts`（面积、点包含、逐边距离、半平面裁剪、直线切分、共边合并、自交检测）与 `planar.ts`（平面图面提取）。

---

## 3. 平面图面提取（S1）

```
RoadGraph + 场地四角/四边
  ↓ ① 收集落在边界上的节点，自动生成分段边界边（斜向路端点因此接入外轮廓）
  ↓ ② 两两求边的严格内部交点，在交点处切分边并插入节点 → 保证输入一定是平面图
  ↓ ③ 每条无向边生成两条半边；每个顶点的出半边按 atan2(dz,dx) 排序
  ↓ ④ 环遍历：next(h) = twin(h) 在目标顶点出边表中的前一条
  ↓ ⑤ 按有向面积符号剔除无界面；按质心稳定排序编号
  → Face[]（闭合、互不重叠、面积和 = 场地面积）
```

实测初始 8×8 网格图：77 节点 / 112 边 → 解析后 81 节点 / 144 边 → **64 个闭合简单面，面积和精确 160000 m²**。

用户斜向连路时，交叉处会自动插入节点并切分两条边，不会产生"交叉但未连通"的非法拓扑；删边后相邻面自然合并。

---

## 4. 空间一致性契约

生成侧的结构性保证（比事后校验更重要）：

1. **边界闭合**：所有面共享同一对节点坐标；面是闭合环。
2. **面积守恒**：`Σ face.area = Σ parcel.area = site.area`（拆分/合并/顶点编辑均保持）。
3. **地块简单**：`isSimple()` 检查非相邻边严格不相交；退化面被丢弃并记入 `skippedEdits`。
4. **逐边净距**：建筑足迹到**每条**地块边分别满足该边净距（临主干路 `width/2+0.5`、临支路 `width/2+0.5`、内部边界 `parcels.setback`）。
5. **旋转内接矩形**：候选中心 = 加密网格 + 质心，角度候选 = 0/90° + 地块最长边方向，尺寸按 `targetSize` 与 `\`min(bw,bd) - 2·buffer\` ` 收敛；角点 + 中心必须落在多边形内并满足逐边净距，贪心选互不重叠的槽位。
6. **公园贴合**：公园多边形 = 所属地块多边形的共边合并结果（可凹）；若合并失败/越界则退回"每地块一个公园对象"，绝不穿插。
7. **树木协调**：行道树沿地块边向多边形内侧按株距布点；公园树在公园多边形内网格采样；统一过滤「路缘净距、边界净距、最小株距、不得落在可建区/建筑足迹内」。
8. **顶点编辑一致性**：顶点若匹配道路图节点 → **同步移动节点**（道路与所有关联地块边界一起变）；顶点落在道路段上但不匹配节点 → **拒绝编辑**并给出明确原因；仅地块间内部顶点才局部重放。

`validateSpatialLayout()` 检查 14 类冲突：`FACE_AREA_MISMATCH / FACE_ISSUE / GRAPH_BAD_ENDPOINT / PARCEL_AREA_MISMATCH / PARCEL_NOT_SIMPLE / PARCEL_OVERLAP / BUILDING_OUTSIDE_POLYGON / BUILDING_ROAD_OVERLAP / BUILDING_FOOTPRINT_OVERLAP / PARK_OUTSIDE_POLYGON / PARK_BUILT_PARCEL_OVERLAP / PARK_NOT_SIMPLE / TREE_* / WATER_OUT_OF_SITE`。报告随场景返回，HUD 与「图形编辑」面板实时显示 PASS / 冲突数。

> 净距口径为**对象中心/足迹角点到边界**的距离，不含树冠半径；共边/共顶点不算重叠（用严格多边形相交判定，规避射线法边界误报）。

---

## 5. 阶段依赖变化

```
S0 场地 → S1 道路网络（可编辑图 → 闭合面）
        → S2 地块划分（面细分 → 多边形 → 重放 parcelEdits）
        → S3 功能分配
        → S4a 建筑（deps 增加 roads，需逐边道路宽度）
          S4b 公园 / E1 水系 / E2 地形（同层）
        → S5 树木 → S6 汇总校验
```

`StageContext.upstream()` 运行时守卫未声明依赖；重构过程中这道守卫实际抓到 `buildings→roads`、`terrainFeatures→landuse`、`assembly→terrain` 三处遗漏。

S2 的细分强度由 `pipeline.parcels.maxSplit` 与 `targetSize` 共同决定；细分使用与用户拆分相同的直线切分内核，因此对非矩形/凹面同样适用。

---

## 6. 命令清单（均经白名单校验）

| 命令 | 作用 |
| --- | --- |
| `graph.regenerate` | 按当前规则重建正交道路图 |
| `graph.node.add {x,z}` / `graph.node.move {id,x,z}` / `graph.node.remove {id}` | 增删/移动道路节点；删除时同时移除关联边 |
| `graph.edge.add {from,to,cls?,width?}` / `graph.edge.remove {id}` / `graph.edge.update {id,cls?,width?}` | 增删路段、改连通关系与等级宽度 |
| `parcel.split {a,b}` | 用直线 A→B 切分所有被穿过的地块（取最长内部弦） |
| `parcel.merge {a,b}` | 合并两点所在、真正共边的两个地块（支持凹结果） |
| `parcel.vertex {at,to}` | 移动共享顶点；道路图节点同步移动；道路段上的孤立顶点被拒绝 |
| `parcel.edits.clear` | 清空地块编辑序列 |

场地尺寸 `terrain.width/depth` 变化时，命令层**按比例缩放全部图节点**，保证面面积仍守恒。

参数（全部注册在 `RULE_FIELDS`，Inspector / 命令校验 / LLM 工具目录同源）：`pipeline.roads.arterialPeriod/localWidth/arterialWidth/suppressParkInterior`、`pipeline.parcels.targetSize/maxSplit/gap/setback/splitJitter`、`pipeline.buildings.maxPerParcel/spacing/archetypeJitter`、`pipeline.parks.inset/pocketMaxArea/...`、`pipeline.trees.streetInterval/parkSpacing/roadSetback/boundarySetback/minSpacing/jitter/maxTrees`。

UI 入口：PCG Inspector →「图形编辑」（节点坐标、路段连通、拆分/合并/顶点表单、编辑序列、重建路网）；3D Viewport →「节点编辑」显示橙色节点手柄，可拖拽改变道路走向；AI Command 面板提供 6 个图形编辑结构化命令预设。

---

## 7. 验证结果

### 单元测试（12 文件 / 93 用例全绿）

| 文件 | 覆盖 |
| --- | --- |
| `editable.test.ts` (15) | 面提取守恒；斜向路段；增节点+连边；移动节点造斜路；删路段；删节点；**L 形凹地块**；拆分；合并；顶点；编辑重放与清空；**连续 12 步编辑逐步校验**；确定性/JSON 往返；撤销恢复；终态重适配 |
| `spatial.test.ts` (24) | 多边形包含/重叠/净距/面积守恒；14 组参数组合全 PASS |
| `chain.test.ts` (4) | 全链路可回溯、局部编辑逐位不变、参数阶段隔离 |
| `pipeline.test.ts` (10) | 阶段 DAG、依赖守卫、确定性、旧版本迁移、扩展点 |
| 其余 8 文件 (40) | 确定性、局部编辑、NL 解析、命令校验、schema、分区、历史、diff |

每条编辑场景的 `assertCoherent()` 都显式断言：面面积 = 地块面积和 = 场地面积、`spatial.ok`、建筑足迹四角 ⊂ 地块多边形、树心 ⊂ owner 多边形且不在建筑内、公园多边形 ⊂ 所属地块。

### 浏览器端实测（Chrome / WebGL 2.0，控制台零错误）

| 步骤 | 建筑 | 地块 | 凹形 | 公园 | 乔木 | 路段 | 指纹 | 空间校验 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 初始 | 150 | 241 | 0 | 57 | 777 | 108 | `381A0250` | PASS |
| 加斜向路段 | 147 | 243 | 0 | 57 | 771 | 109 | `74404967` | PASS |
| 斜切多个地块 | 152 | 255 | 0 | 55 | 768 | 109 | `C09FF106` | PASS |
| 删两条相邻路段 → L 形凹地块 | 152 | 255 | **1** | 55 | 776 | 107 | `B2FBF375` | PASS |
| 运行验收演示（6 步） | 142 | 241 | 0 | 57 | 777 | 108 | `BE29C1BA` | PASS |

保存/加载一致性：`savedFingerprint = BE29C1BA`，重载后 HUD 指纹一致，`graph`（77 节点）、`parcelEdits`、schema `v1.2.0` 均完整往返。

---

## 8. 已知边界（不掩饰）

- 孤立道路节点是合法编辑中间态（用户可能稍后连边），校验器只统计不报错。
- 落在道路段上、但未对应图节点的顶点移动被**明确拒绝**，以避免边界偏离道路；需先 `graph.node.add` 或改移动图节点。
- 连续两次 `parcel.merge` 若第一次合并产生长边、第二次邻居是短边，可能因端点不匹配被跳过并记入 `skippedEdits`；此时用「删两条相邻路段」是更可靠的凹形生成路径。
- `pipeline.parcels.inset` 只作用于公园树木净距；不对凹多边形做几何 offset（半平面裁剪在凹形上会产生越界桥接）。
- 建筑轮廓用「旋转内接矩形族」表达，不是任意多边形挤出；凹形地块会拆成多个沿臂分布的体量。
- 默认 `density.base = 0.82` 仍留约 18% 未开发地块（可通过参数调整）；这是密度参数，不是几何失败。
