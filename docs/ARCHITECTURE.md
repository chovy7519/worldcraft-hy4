# WorldCraft 架构说明（v1.2.0）

> 分阶段 PCG 管线的完整规范见 [PCG_PIPELINE.md](PCG_PIPELINE.md)；
> 可编辑道路图与多边形地块系统见 [EDITABLE_GEOMETRY.md](EDITABLE_GEOMETRY.md)。
> 本文聚焦整体架构、确定性证明与关键取舍。

## 0. 一句话架构

```
中文 / LLM / 参数面板 / 手工 JSON
        ↓  编译为封闭 Command[]
   validateCommands()  ← 字段注册表白名单
        ↓
   applyCommands(doc, cmds) → SceneDocument（规则 + 种子 + 覆写）
        ↓
   runPipeline(doc) → 阶段 DAG（S0…S6 + E1/E2）→ GeneratedScene
        ↓
   React Three Fiber（InstancedMesh）
```

**SceneDocument 是唯一事实来源**；三维几何是它的派生缓存，不落盘、不进历史、不进存档。这条约束同时解决了确定性、撤销/重做、保存/加载三件事。

---

## 1. 为什么必须放弃全局 RNG 流（本项目的关键设计判断）

### 朴素做法及其失败模式

```ts
const rnd = mulberry32(seed);
for (const cell of cells) {
  if (rnd() < densityOf(cell)) {          // 抽样 1
    h = base + (max - base) * rnd();      // 抽样 2
    color = palette[Math.floor(rnd() * n)]; // 抽样 3
  }
}
```

改「东侧密度 -30%」后，东侧被接受的地块数减少，循环内 `rnd()` 的调用次数随之变化，**后续所有地块的抽样序列整体错位**：西侧、北侧、南侧的建筑高度、颜色、屋顶、甚至是否存在都会变。验收要求「其他区域不变」直接失败，且这类 bug 在视觉上很难定位。

### 本项目的做法：按 (种子, 属性盐, 稳定序号) 独立哈希

```ts
sample(seed, 'occupy', parcelSerial, slot)   // 是否占地
sample(seed, 'hjitter', parcelSerial, slot)  // 高度扰动
sample(seed, 'color',  parcelSerial, slot)   // 立面色号
sample(seed, 'landuse-roll', parcelSerial)   // 功能分配
sample(seed, 'park-expand', parcelSerial)    // 公园扩张
sample(seed, 'parktree-jx', parkId, ix, iz)  // 树位扰动
```

`hash32` 为 FNV-1a + 末轮雪崩，输入是 `(seed, salt, ...keys)` 元组并带分隔符，输出归一化到 `[0,1)`。

**不变量**：任一属性值只依赖该属性自身的盐与该对象的稳定序号，与生成顺序、其他对象是否被接受、规则是否变化均无关。因此：

- 修改 `density.zoneMultipliers.east` 只改变**东侧地块的接受判定**；
- 被保留下来的东侧地块，其高度/面宽/颜色/屋顶逐位不变；
- 非东侧地块，以及**道路、街区、地块、功能、公园、树木、水系占位**全部逐位不变；
- 以后新增一个属性（如 `balcony`）只需新增一个盐，不会扰动既有属性。

这条不变量由 `chain.test.ts` / `partial-edit.test.ts` 用 `canonicalize()` 逐对象断言，不是靠肉眼观察。

### 方案对比

| 维度 | 全局 RNG 流 | 每格一个 RNG 流 | 按属性盐独立哈希（选用） |
| --- | --- | --- | --- |
| 局部编辑不扰动其他区域 | 否 | 是 | 是 |
| 新增生成属性向后兼容 | 否（序列错位） | 否（同格内后续值错位） | 是 |
| 规则追溯（解释某对象为何如此） | 需重放全序列 | 需重放该格序列 | 直接给出哈希输入 |
| 并行 / 分块生成可行性 | 差 | 中 | 好 |
| 每对象计算开销 | 最低 | 低 | 略高（多次哈希） |

实测 400×400 m、50×50 网格、241 地块、180 建筑、48 公园、457 树木，单次 `generateScene()` 约 40–60 ms，浏览器交互无卡顿；多出的哈希开销可以接受。

---

## 2. 分区模型：为什么用互斥的轴主导划分

「东侧」在自然语言处理里通常是叠加谓词（`nx > 1/3`），会导致东北角同时属于 east 与 north，两条规则的优先级产生歧义，「其他区域不变」也无法严格界定。

V0.1 采用**轴主导、五分区互斥**：

```
nx = x / (width/2),  nz = z / (depth/2)    // [-1, 1]，+X 东，-Z 北
|nx| < 1/3 且 |nz| < 1/3          → core
否则 |nx| >= |nz| 时 nx >= 0       → east，否则 west
否则 nz >= 0                       → south，否则 north
```

任意坐标恰好落入一个分区（有单测穷举 41×41 采样验证）。代价是「东北角」归 north 而不归 east —— 这是一个明确的、写进文档的语义取舍，而不是隐含 bug。后续可升级为可配置区域选择器 + 规则叠加层，但必须保留不变量测试。

---

## 3. Scene Schema

```ts
interface SceneDocument {
  schemaVersion: '1.2.0';            // v1.0.0 / v1.1.0 自动迁移
  id: string; name: string; seed: number; revision: number;
  rules: {
    terrain: TerrainRules;
    height: HeightRules;
    density: DensityRules;
    openSpace: OpenSpaceRules;       // 中央公园配置
    material: MaterialRules;
    pipeline: PipelineRules;         // v1.1.0 新增：30 项阶段参数
  };
  graph: RoadGraph;                  // v1.2.0 新增：可编辑道路图（持久化）
  parcelEdits: ParcelEdit[];         // v1.2.0 新增：地块空间编辑序列
  overrides: Record<string, ObjectOverride>;  // 仅表现层
  createdAt: string; updatedAt: string;
}
```

要点：

- **对象 ID 由阶段内稳定序号派生**（`bld.<地块序号>.<槽位>`、`prc.<n>`、`park.<cluster>`），不含生成序号，所以局部编辑不会重编号其他对象。
- **不存几何**，只存规则 + 种子 + 人工覆写。存档 JSON 通常 < 5 KB，与场景规模无关。
- `parseSceneDocument()` 做严格校验：版本、字段白名单、类型、区间、对象 ID 正则、分组键与子键枚举；拒绝任何未注册字段，防止外部输入注入任意结构。
- 文档指纹 `fingerprintOf({seed, rules, overrides})` 排除名称与时间戳，用于判断「规则是否实质改变」。

### 字段注册表是单一事实来源

`src/core/fields.ts` 的 `RULE_FIELDS` 同时驱动：

1. PCG Inspector 的控件（标签、单位、范围、枚举、分组、高级项折叠）；
2. `rule.set` 的路径白名单与取值夹紧；
3. 可选 LLM 系统提示中的工具字段目录。

因此「面板能改的」=「命令能写的」=「LLM 知道的」，三者不可能漂移。

---

## 4. 受控命令层

`Command` 是封闭 TypeScript 联合类型，运行时再经 `validateCommand()` 做白名单校验：

| 入口 | 路径 | 说明 |
| --- | --- | --- |
| 中文自然语言 | `parseNaturalLanguage()` → `Command[]` | 规则式解析，零依赖；识别失败明确拒绝 |
| 可选 LLM | `parseWithLlm()` → JSON → `validateCommands()` | 只输出命令 JSON，输出不直接执行 |
| Inspector | `store.setField()` → `rule.set` | 与 NL 共用执行器 |
| 手工 JSON | 文本框 → `validateCommands()` | 无 AI 也能验证全部核心生成能力 |

`applyCommands(doc, cmds, source)` 是纯函数，返回 `{ doc, changes, cameraPreset, errors }`，不修改入参。每条变更记录包含 `path / label / before / after / scope / source / note`，写入命令日志与规则变化时间线。

**安全边界**：不存在 `eval`、动态代码求值、任意 Three.js 构造或 shader 注入。LLM 输出里出现 `new THREE.Mesh()`、未注册路径、越界值都会被 `validateCommands()` 拒绝。

**撤销/重做**：以整份 `SceneDocument` 快照为粒度（上限 60 步），不做反向命令推导 —— 反向推导在乘积型相对调整（`×0.7` 再 `÷0.7`）上会引入浮点误差，破坏「撤销后指纹逐位相同」。系统类操作（撤销、重做、加载、导入、重置）也会用 `diffDocuments()` 生成可追溯 diff，因此规则变化面板不会在撤销后变空。

---

## 5. 分阶段 PCG 管线

原来的扁平单函数流水线（网格 → 圆形开放空间 exclusion → 分区 → 占地 → 高度 → 材质）已重构为**显式阶段 DAG**；v1.2.0 又把规则化正交路网替换为可编辑道路图与平面闭合面提取：

```
S0 场地 → S1 道路网络 → S2 地块划分 → S3 功能分配
        → S4a 多类型建筑 / S4b 多尺寸公园 / E1 水系 / E2 地形（同层）
        → S5 树木分布 → S6 汇总校验
```

关键设计：

- **阶段依赖是一等公民**：`STAGE_GRAPH` 声明 deps，runner 用 Kahn 拓扑排序执行，`ctx.upstream(id)` 在运行时守卫未声明依赖。开发过程中这道守卫实际抓到 3 处遗漏（`assembly→terrain`、`terrainFeatures→landuse` 等）。
- **可编辑道路图 → 闭合面**：`SceneDocument.graph` 持久化节点/路段；`normalizeGraph` 自动在边的交叉处插入节点并切分，半边环遍历提取所有有界面。道路与地块共享同一条边，闭合与一致性来自拓扑。
- **多边形地块**：`ParcelObject.polygon` 是面提取结果经细分与 `parcelEdits`（拆分/合并/顶点）重放后的红线，可非矩形、可凹；顶点若在道路图上则同步移动节点，落在道路段上的孤立顶点移动被拒绝。
- **功能分配与公园聚类**：按预设权重 + 独立哈希分配 8 类功能；公园按 `clusterBias` 向共边地块扩张，形成口袋 / 社区 / 中央三档尺寸；公园多边形由所属地块共边合并（可凹），失败则退回逐地块公园对象。
- **多建筑原型 + 旋转足迹**：塔楼、板楼、裙房、研发楼、孵化单元；足迹是地块多边形内的**旋转内接矩形族**，逐边净距按临路等级分别计算，凹形地块自动拆成沿臂分布的多个体量。
- **树木与边界协调**：行道树沿多边形每条边向内侧布点、公园树在多边形内网格采样；统一过滤路缘净距、边界净距、最小株距与可建范围。
- **扩展点**：`waterReserved` / `terrainReserved` 地块在 S3 登记，E1/E2 默认关闭但仍统计预留数量；契约文本写在 `STAGE_GRAPH[].contract`。

详见 [PCG_PIPELINE.md](PCG_PIPELINE.md)。

---

## 6. 空间无重叠校验

`validateSpatialLayout()` 检查 14 类冲突，报告 `SpatialReport` 随 `GeneratedScene` 返回，HUD 与「生成管线」面板实时显示 PASS / 冲突数。

生成侧的结构性保证（比事后校验更重要）：

1. 道路图交点自动切分为节点，所有面共享同一对节点坐标；`Σ face.area = Σ parcel.area = site.area`；
2. 地块多边形通过 `isSimple()` 非自交检查，退化面记入 `skippedEdits`；
3. 建筑旋转足迹四角 ⊂ `parcel.polygon`，且到**每条边**满足该边净距（临主干路/支路/内部边界分别取值）；
4. 公园多边形 ⊂ 所属地块多边形并集（可凹），不与可建地块严格相交；
5. 圆形公园半径取多边形最大内接圆与配置半径的较小值，保证内切；
6. 树心在 owner 多边形内，满足路缘净距、边界净距与最小株距；
7. 任何树心不得落在可建区或建筑足迹内。

14 组参数组合（中央公园 1/3 街区、细分 1/3×3、公园比例 0/30%、关闭开放空间、关闭道路抑制、矩形公园、高净距、启用扩展点、主干路加密、场地缩小等）全部 PASS。

---

## 7. 渲染层

- 道路、建筑主体、屋顶构件、水面占位、树干、树冠、道路节点手柄各 1 个 `InstancedMesh`，`setMatrixAt` + `setColorAt`；道路与建筑的实例矩阵带 Y 旋转以支持任意走向；所有公园多边形三角化后合并为 1 个 `BufferGeometry`（支持凹形）；地块边界用 1 个 `LineSegments`。
- `frustumCulled={false}`：InstancedMesh 的默认包围球来自单位几何体，不关会导致整组对象被错误裁剪。
- 实例数量变化时用 `key` 强制重建，避免缓冲区容量不匹配。
- 材质 / 分区 / 地块功能三视图切换只改实例颜色与边界线显隐，不重建几何。
- 选中高亮用独立 wireframe box，`depthTest={false}` 保证可见。
- `OrbitControls makeDefault` + `CameraRig` 响应相机预设；东北 35° 半鸟瞰由仰角与方位角解析计算。
- Camera 请求 `powerPreference: 'high-performance'`。双屏接核显的机器上仍可能被系统分配核显，见 README 的 GPU 排查项。

---

## 8. 已知的架构债

| 债务 | 影响 | 建议时机 |
| --- | --- | --- |
| E1 水系 / E2 地形仅占位 | 未实现水系拓扑连通、坡度与高程回填 | 下一阶段按已声明 contract 补齐 |
| 分区谓词硬编码 | 无法表达「滨水带」「沿轴线 50 m」等任意范围 | 引入区域选择器时 |
| 阶段集合硬编码 | 新增生成模块需改 `STAGE_GRAPH` 与 `STAGE_RUNNERS` | 模块注册表化时 |
| 每对象多次哈希 | 约 40–60 ms/次，规模扩大后线性增长 | 场地 > 2 km 时分块 + LOD |
| 全量重生成 | 局部编辑仍重算全城（但结果不变） | 需要更大场景时做分区缓存 |
| LLM 浏览器直连 | 密钥在本机请求中携带 | 生产部署前 |

注意「全量重生成」与「其他区域不变」并不矛盾：重算的是纯函数，非东侧对象的结果逐位一致；这是用计算换取实现简单与可验证性，属于有意识的取舍。
