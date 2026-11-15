# WorldCraft v1.3.0 阶段记录：六项后续建议的落实情况

> 本文记录 2026-11-15 这一轮「继续完善」实际做了什么、**没**做什么，以及为什么。
> 刻意区分「已实现并可测」「评估 + 索引层」「需要长期工程投入」三类，避免把半成品说成完成。

## 0. 基线（改造前，实测）

| 项 | 值 |
| --- | --- |
| 依赖 | 未安装 → `npm install` 后复现 |
| 测试 | `npm test` 12 文件 / 93 用例全绿 |
| 构建 | `npm run build`（`tsc --noEmit` + Vite）通过 |
| 源码 | 7,754 行 TS/TSX；文档 1,577 行 |
| 指纹 | 文档中的历史基线 `381A0250`（**测试里没有硬编码指纹**，所以新增能力不会靠改断言蒙混过关） |

## 1. 六项建议的实际状态

| # | 建议 | 状态 | 交付位置 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | 自由节点图编辑 / 可插拔模块 | **部分**（描述层已完成，自由编辑未做） | `core/pipeline/registry.ts`、`pipeline/index.ts` | `registry.test.ts` 8 例；`exportNodeGraph()` 输出节点图 JSON |
| 2 | E1 水系 / E2 地形要素 | **已实现** | `stages.ts` E1/E2、`validate.ts` §7/§8、`CityScene.tsx` | `extensions.test.ts` 9 例；开启后空间校验 PASS |
| 3 | 多边形布尔运算升级 | **已实现** | `geom/boolean.ts`（polygon-clipping / Martinez 系） | `boolean.test.ts` 12 例；共边快速路径 + 布尔兜底 |
| 4 | 分区谓词可配置 | **已实现** | `core/regions.ts`、`commands.ts`、`schema.ts`、`stages.ts` | `regions.test.ts` 14 例；空层恒等 / 带外逐位不变 |
| 5 | LOD / 分块生成 | **评估 + 索引层**，生成侧分块**未实现** | `scripts/bench.ts`、`pipeline/tiles.ts` | `tiles.test.ts` 8 例；实测数据见 §3 |
| 6 | LLM 后端代理 + 结构化输出 | **已实现（含可运行服务端）** | `core/llm.ts`、`server/llm-proxy.mjs`、`vite.config.ts` | 命令目录编译期穷尽；代理可 `npm run proxy` 启动 |

**没有做的两件事，明确说清：**

- **自由节点图拖拽编辑**：registry 支持注册 / 移除自定义阶段、导出与 Blender GN / Unreal PCG 对齐的节点图描述，但阶段的内部算法仍是代码，不是可视化节点网络。做真正的自由编辑需要一套 `Port → Node → Link` 的运行时解释器 + 参数连线 UI，属于独立产品，不是一次重构能带出来的。
- **生成侧按瓦片分块**：当前 `generateScene(doc)` 是全量纯函数，这是确定性契约的地基。按瓦片生成必须先把管线拆成「全局拓扑（道路图 + 闭合面提取）」与「局部几何（逐瓦片）」两阶段，并处理跨瓦片道路与地块的边界归属。本轮只交付可复用的瓦片索引与裁剪层，不假装做了生成器。

## 2. 关键设计判断

**空叠加层是恒等元。** `regions` 为空时，`evaluateRegions()` 恒返回 `density=1 / height=1`，且不进入 `documentFingerprint()` 与 `stageAssembly` 的指纹载荷。因此 v1.2.0 存档迁移后几何结果不变；只有真正新增叠加层才改变指纹。这条不变量比「区域选择器能跑」更重要，由 `regions.test.ts` 逐对象断言。

**布尔运算走双路径。** `polygon.ts::mergePolygons`（共边消除）保留为快速路径，保证既有场景逐位一致；只有它失败才交给 `mergePolygonsRobust()`。带内环（洞）的结果一律拒绝，因为地块系统不支持内环 —— 宁可跳过，也不生成非法地块。**注意**：只有 `stageParcels` 的用户合并命令与中央公园合并走兜底，`stageParks` 的公园合并仍走严格共边；开发中曾把公园合并也换成鲁棒版，结果在「细分 3×3」参数下合并出越界公园，触发 `PARK_BUILT_PARCEL_OVERLAP`，已回退。

**命令目录用编译期穷尽检查消除漂移。** v1.2.0 的 `llm.ts::COMMAND_DOC` 硬编码 9 类命令，而 `Command` 联合类型当时已有 21 个 op —— v1.2.0 新增的全部 `graph.*` / `parcel.*` 对 LLM 不可见，文档却声称「三者不可能漂移」。现在 `COMMAND_DOCS` 用 `satisfies Record<Command['op'], CommandDoc>`：新增 op 不补文档，`tsc` 直接报错。当前 25 个 op 全部有文档、示例与 tool schema enum。

**E1 的水面／道路协调是已知边界，不是假装解决。** 项目的地块红线口径本身压在道路带内（`pipeline.parcels.gap` 只是地块间缝隙），建筑靠 `edgeBuffersOf()` 额外做临路退界避让。E1 沿用同一红线口径，真实不变量是「退界后的水面 ⊆ 原始红线」（`WATER_OUTSIDE_SHORELINE`）。把临路退界也做进水面岸线，属于 E1 二期。开发中曾加过「水面 vs 道路带矩形相交」校验，结果在既有参数组合下大面积误报，已移除并在 `validate.ts` 注释写明口径原因。

## 3. 2 km 场地实测（`npm run bench`）

```
 400 m | 建筑   150 | 地块   241 | 乔木  777 | 节点  81 | 平均  116 ms | PASS
 800 m | 建筑   680 | 地块  1009 | 乔木 1600 | 节点 289 | 平均  890 ms | PASS
1200 m | 建筑  1438 | 地块  2269 | 乔木 1600 | 节点 289 | 平均 1959 ms | PASS
2000 m | 建筑  2515 | 地块  4033 | 乔木 1600 | 节点 289 | 平均 6579 ms | PASS
```

两个改变判断的发现：

1. **2 km 单次生成 6.6 s，交互不可用**，且增长接近线性偏超线性（地块细分 + 建筑候选网格）。
2. **路网节点在 1200/2000 m 都停在 289，乔木被 `maxTrees=1600` 截断**。也就是说当前「扩大场地」实际是把格子放大，不是提高路网密度；单纯加 LOD 掩盖不了生成侧的规模问题，先要决定 2 km 场景到底需要多密的路网。

`pipeline/tiles.ts` 提供 `buildTileIndex / queryTiles / visibleBuildings / visibleTrees / cullingReport`，对象按中心入桶、查询时外扩一圈候选瓦片再用 bounds 精确过滤，保证跨界对象不漏（`tiles.test.ts` 与暴力全量过滤结果逐 id 比对）。**该模块目前尚未接入 CityScene 的渲染循环**：R3F 的 `InstancedMesh` 不做 per-instance 视锥剔除，接入需要按瓦片拆成多个 InstancedMesh 或改用 `BatchedMesh`，会改变现有「7 类各 1 个 draw call」的渲染约束。

### 3.1 结案（2026-11-15，用户确认「800–1200 m 是够用了」）

**2 km 高密度场景判定为非目标，生成侧分块与渲染侧视锥剔除不投入工程。** 依据：

- `terrain.width / depth` 的字段上限本来就是 1200 m（`fields.ts`），2000 m 只出现在压测脚本里，UI 调不到；目标范围与实现范围一致，无需改上限。
- 重跑 `npm run bench` 复核（机器负载不同，数值略高于首次）：`400 m 235 ms / 800 m 1478 ms / 1200 m 3838 ms / 2000 m 8871 ms`；节点数 800 m 起封顶 289、乔木封顶 1600，结论不变 —— 「扩大场地」是放大格子而非加密路网。
- 若把 2 km 当真目标，需同时改 `sample()` 稳定序号语义、管线瓦片化、校验器分区、渲染按瓦片拆 mesh、细节与流动按视口配额分级，约 4–8 周且会让已验收的确定性契约全部重验；在目标范围 1200 m 内，这些成本没有对应收益。
- `tiles.ts` 与 `tiles.test.ts` **保留为评估证据**，不接生产路径，避免留下一个没人用的半成品抽象。
- 更符合真实规划生产口径的下一步是 **GeoJSON / DXF 红线导入 + 按红线分区**（1–2 周量级），而不是把程序化网格加密到 2 km；这与架构审查中「结果无法进 CAD、无法交给甲方」是同一个缺口。

本轮同步把用户确认的 800 × 800 m 场景固化为默认预设（见 `src/core/preset.ts`），实测 752 建筑 / 1009 地块 / 13,266 件构件 / 零截断 / 生成 1.19 s / 空间校验 PASS。

## 4. 版本与兼容性

- `SCHEMA_VERSION`：`1.2.0` → `1.3.0`；`MIGRATABLE_VERSIONS` 增加 `1.2.0`。
- 新增顶层字段 `regions?: RegionLayer[]`（缺省 `[]`）、`pipeline.extensions` 新增 4 个 E1/E2 参数，旧存档加载时自动补默认值并做严格白名单校验。
- 新增依赖 `polygon-clipping@0.15.7`（自带 TS 类型，无需 `@types`）。`npm audit` 报的 6 项来自既有 dev 依赖（vite / vitest / esbuild），与新依赖无关。
- **默认场景指纹会变**（`rules` 里多了 4 个 E1/E2 参数）。文档中的 `381A0250` 等是 v1.2.0 历史基线，保留作为历史证据，不改写。本轮所有既有 93 个用例（版本号、占位行为两条断言随版本更新）仍全绿。

## 5. 新增文件

```
src/core/regions.ts                  区域选择器 + 叠加层 + 严格校验
src/core/geom/boolean.ts             布尔并/交/差、稳健合并、多边形内缩
src/core/pipeline/registry.ts        可插拔阶段注册表 + 节点图导出
src/core/pipeline/tiles.ts           瓦片索引与视口裁剪
src/core/pipeline/index.ts           改为从 registry 取 graph/runner（重写）
src/core/llm.ts                      命令目录 + tool calling + 代理模式（重写）
server/llm-proxy.mjs                 零依赖 Node 代理（密钥只在服务端）
scripts/bench.ts                     场地规模性能基准
src/__tests__/{regions,boolean,registry,extensions,tiles}.test.ts
```

## 6. 下一阶段（按依赖排序，不是按愿望排序）

1. ~~**先决定 2 km 场景是否真是目标**~~ → **已决断（§3.1）：不是目标，目标范围 800–1200 m**。`tiles.ts` 只作为评估证据保留，不投入渲染侧改造；生成侧分块、视锥剔除、`sample()` 盐键重写一律不启动。
2. ~~若确定要做：…4–8 周工程路径~~ → **已取消**。更符合真实规划生产口径的后续项是 GeoJSON / DXF 红线导入 + 按红线分区，见 §3.1。
3. E1 二期：临路退界、水系拓扑连通约束、与 E2 高程场的竖向协调。
4. E2 二期：把 `heightfield` 回填到建筑基础标高与道路纵断的 Y 坐标（当前高程场是数据图层，渲染层仍是平涂示意）。
5. 区域叠加层的 Inspector 可视化编辑（当前通过结构化命令预设操作，见命令面板「区域：…」）。
6. 自由节点图编辑：需要独立的节点运行时 + 连线 UI，建议先做原型验证「设计院用户是否真的要拖节点」。

## 7. 启动方式

```bash
npm install
npm run dev            # http://127.0.0.1:5190
npm test               # 全量测试
npm run build          # tsc --noEmit + vite build
npm run bench          # 场地规模性能基准
# 可选：启用 LLM 后端代理（另开一个终端）
OPENAI_API_KEY=sk-... npm run proxy     # http://127.0.0.1:5191/health
```

## 8. 同日追加：回到规则层（不是继续加功能）

使用者指出「广场和绿地压在道路上」「城市是一个整体，是会互相影响的」，因此暂停后续功能推进，转为规则审查。

- **审查**：`scripts/diagnose-spatial.ts` 实测修复前 57/57 个公园与道路带重叠 28.3%，空间校验却 PASS。详见 [CITY_RELATIONS.md](CITY_RELATIONS.md)。
- **关系契约**：`src/core/spatialRules.ts` 的 `RELATION_MATRIX`（22 条）成为单一事实来源；`clearanceFor / bandPolygon / setbackFromRoads` 统一生成侧与校验侧口径。公园/广场/水面全部从道路带退让，重叠归零。
- **人流车流**：`src/core/mobility.ts` 确定性生成车辆回路、双侧步道、公园环线；配额由道路等级/建筑密度/公园面积驱动。`flowWarnings` 与 `spatial.issues` 分层。
- **通行廊道规则（口径由使用者拍板：判违规并给出提示）**：新增 `ROAD_CORRIDOR_NARROW`，阈值 `2 × 步道通行带`（默认 4.4 m，由 `sidewalkWidth` 派生），交叉口与共享端点豁免。违规写入 `spatial.issues`，附 `advice`；Inspector「关系」tab、视口 HUD、顶栏状态条三处提示。受影响的 2 个既有编辑测试改为「除廊道违规外其余不变量全 PASS，且每条违规都带提示」，没有改编辑数据回避。
- 新增 `corridor.test.ts` / `relations.test.ts` / `mobility.test.ts`；Inspector 新增「关系」tab。

> 这一轮的取舍：宁可让部分既有图形编辑场景变为「不合法」并说清怎么修，也不让静态规则继续留缺口。
