import { useEffect, useMemo, useState } from 'react';
import { FIELD_BY_PATH, RULE_FIELDS, RULE_GROUPS, getRuleValue, type RuleField } from '../core/fields';
import { STAGE_GRAPH, buildStagePlan, downstreamOf, extensionStatus } from '../core/pcg';
import { useAppStore, type ChangeHistoryEntry } from '../core/store';
import type { Command, RoadClass } from '../core/types';
import {
  ARCHETYPE_LABELS, LAND_USE_LABELS, PARK_SIZE_LABELS, ZONE_COLORS, ZONE_LABELS,
  type ArchetypeId, type GeneratedScene, type LandUseId, type ObjectOverride,
  type RuleChange, type SceneDocument,
} from '../core/types';

interface InspectorProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  selectedId: string | null;
  lastChanges: RuleChange[];
  changeHistory: ChangeHistoryEntry[];
  setField: (path: string, value: number | string | boolean) => void;
  setSeed: (seed: number) => void;
  randomizeSeed: () => void;
  overrideObject: (id: string, patch: ObjectOverride) => void;
  restoreObject: (id: string) => void;
  deleteSelected: () => void;
  tab: TabId;
  onTabChange: (t: TabId) => void;
}

export type TabId = 'rules' | 'stats' | 'pipeline' | 'graph' | 'object' | 'changes';

function RuleSlider({ field, value, onCommit }: { field: RuleField; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <div className="field">
      <div className="field-head">
        <label>{field.label}</label>
        <span className="val">{draft}{field.unit}</span>
      </div>
      <div className="field-row">
        <input
          type="range" min={field.min} max={field.max} step={field.step} value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        />
        <input
          className="input" type="number" min={field.min} max={field.max} step={field.step} value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <div className="desc">{field.description}</div>
    </div>
  );
}

function FieldControl({ field, doc, setField }: { field: RuleField; doc: SceneDocument; setField: InspectorProps['setField'] }) {
  const raw = getRuleValue(doc.rules, field.path);
  const isBoolLike = field.type === 'enum' && field.options?.length === 2 && field.options[0].value === 'true';
  if (isBoolLike) {
    const on = Boolean(raw);
    return (
      <div className="field">
        <div className="field-head">
          <label>{field.label}</label>
          <button className={`toggle ${on ? 'on' : ''}`} onClick={() => setField(field.path, !on)}>
            <span className="track" /><span className="small muted">{on ? '启用' : '关闭'}</span>
          </button>
        </div>
        <div className="desc">{field.description}</div>
      </div>
    );
  }
  if (field.type === 'enum') {
    return (
      <div className="field">
        <div className="field-head"><label>{field.label}</label></div>
        <select className="select" value={String(raw)} onChange={(e) => setField(field.path, e.target.value)}>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="desc">{field.description}</div>
      </div>
    );
  }
  return <RuleSlider field={field} value={Number(raw)} onCommit={(v) => setField(field.path, v)} />;
}

/** 可编辑道路图与多边形地块的图形编辑面板 */
function GraphEditor({ doc, scene }: { doc: SceneDocument; scene: GeneratedScene }) {
  const run = (cmd: Command, label: string) => {
    useAppStore.getState().execute([cmd], { input: label, source: 'inspector' });
  };
  const [nx, setNx] = useState('0'); const [nz, setNz] = useState('0');
  const [from, setFrom] = useState(doc.graph.nodes[0]?.id ?? '');
  const [to, setTo] = useState(doc.graph.nodes[1]?.id ?? '');
  const [cls, setCls] = useState<RoadClass>('local');
  const [p, setP] = useState({ ax: '-195', az: '-195', bx: '-155', bz: '-155' });
  const [limit, setLimit] = useState(16);
  const num = (s: string) => Number(s) || 0;
  const A = { x: num(p.ax), z: num(p.az) }; const B = { x: num(p.bx), z: num(p.bz) };
  const coord = (key: keyof typeof p, value: string) => setP((s) => ({ ...s, [key]: value }));

  return (
    <>
      <div className="section"><div className="section-body">
        <div className="stat-grid">
          <div className="stat-card"><div className="k">道路节点 / 路段</div><div className="v">{doc.graph.nodes.length} / {doc.graph.edges.length}</div></div>
          <div className="stat-card"><div className="k">地块编辑序列</div><div className="v">{doc.parcelEdits.length}</div></div>
          <div className="stat-card"><div className="k">闭合面面积</div><div className="v">{scene.stats.faceArea}<small>/{scene.stats.siteArea}</small></div></div>
          <div className="stat-card"><div className="k">空间校验</div><div className="v" style={{ color: scene.spatial.ok ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>{scene.spatial.ok ? 'PASS' : `${scene.spatial.issues.length} 冲突`}</div></div>
        </div>
        {scene.skippedEdits.length > 0 && (
          <div className="inline-note mt6" style={{ color: 'var(--amber)' }}>
            {scene.skippedEdits.length} 条编辑因几何不成立被跳过：{scene.skippedEdits.slice(0, 2).join('；')}
          </div>
        )}
        {scene.faceIssues.length > 0 && (
          <div className="inline-note mt6" style={{ color: 'var(--red)' }}>面提取异常：{scene.faceIssues.slice(0, 2).join('；')}</div>
        )}
        <div className="row wrap" style={{ gap: 5 }}>
          <button className="btn sm" onClick={() => run({ op: 'graph.regenerate' }, '按规则重建正交道路图')}>按规则重建路网</button>
          <button className="btn sm" onClick={() => run({ op: 'parcel.edits.clear' }, '清空地块编辑')}>清空地块编辑</button>
        </div>
      </div></div>

      <div className="section">
        <div className="section-title">S1 道路节点<span className="spacer" /><span className="tag">{doc.graph.nodes.length}</span></div>
        <div className="section-body">
          <div className="row wrap" style={{ gap: 4 }}>
            <input className="input small" style={{ width: 62 }} value={nx} onChange={(e) => setNx(e.target.value)} placeholder="X" />
            <input className="input small" style={{ width: 62 }} value={nz} onChange={(e) => setNz(e.target.value)} placeholder="Z" />
            <button className="btn sm" onClick={() => run({ op: 'graph.node.add', x: num(nx), z: num(nz) }, `新增道路节点 (${nx}, ${nz})`)}>新增节点</button>
          </div>
          {doc.graph.nodes.slice(0, limit).map((n) => (
            <div className="row" key={n.id} style={{ gap: 4, marginTop: 4 }}>
              <span className="mono small muted" style={{ width: 44, flex: 'none' }}>{n.id}</span>
              <input className="input small" style={{ width: 56 }} defaultValue={n.x} key={`x${n.id}${n.x}`}
                onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== n.x) run({ op: 'graph.node.move', id: n.id, x: v, z: n.z }, `移动节点 ${n.id}.x`); }} />
              <input className="input small" style={{ width: 56 }} defaultValue={n.z} key={`z${n.id}${n.z}`}
                onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== n.z) run({ op: 'graph.node.move', id: n.id, x: n.x, z: v }, `移动节点 ${n.id}.z`); }} />
              <button className="btn sm" onClick={() => run({ op: 'graph.node.remove', id: n.id }, `删除节点 ${n.id}`)}>×</button>
            </div>
          ))}
          {doc.graph.nodes.length > limit && (
            <button className="chip" style={{ marginTop: 6 }} onClick={() => setLimit((l) => l + 24)}>显示更多（还有 {doc.graph.nodes.length - limit} 个）</button>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">S1 路段与连通关系<span className="spacer" /><span className="tag">{doc.graph.edges.length}</span></div>
        <div className="section-body">
          <div className="row wrap" style={{ gap: 4 }}>
            <select className="select small" style={{ width: 70 }} value={from} onChange={(e) => setFrom(e.target.value)}>
              {doc.graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
            </select>
            <select className="select small" style={{ width: 70 }} value={to} onChange={(e) => setTo(e.target.value)}>
              {doc.graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
            </select>
            <select className="select small" style={{ width: 66 }} value={cls} onChange={(e) => setCls(e.target.value as RoadClass)}>
              <option value="local">支路</option><option value="arterial">主干</option>
            </select>
            <button className="btn sm" onClick={() => run({ op: 'graph.edge.add', from, to, cls }, `新增路段 ${from}→${to}`)}>连边</button>
          </div>
          {doc.graph.edges.slice(0, limit).map((e) => (
            <div className="row" key={e.id} style={{ gap: 4, marginTop: 4 }}>
              <span className="mono small muted" style={{ width: 58, flex: 'none' }}>{e.id}</span>
              <span className="small" style={{ flex: 1 }}>{e.from} → {e.to}</span>
              <button className="btn sm" onClick={() => run({ op: 'graph.edge.update', id: e.id, cls: e.cls === 'arterial' ? 'local' : 'arterial' }, `切换 ${e.id} 等级`)}>{e.cls === 'arterial' ? '主干' : '支路'}</button>
              <button className="btn sm" onClick={() => run({ op: 'graph.edge.remove', id: e.id }, `删除路段 ${e.id}`)}>×</button>
            </div>
          ))}
          {doc.graph.edges.length > limit && (
            <button className="chip" style={{ marginTop: 6 }} onClick={() => setLimit((l) => l + 24)}>显示更多（还有 {doc.graph.edges.length - limit} 条）</button>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">S2 多边形地块编辑（空间两点）</div>
        <div className="section-body">
          <div className="row wrap small" style={{ gap: 4 }}>
            <span className="muted">A</span>
            {(['ax', 'az', 'bx', 'bz'] as const).map((k, i) => (
              <span className="row" key={k} style={{ gap: 3 }}>
                {i === 2 && <span className="muted" style={{ marginLeft: 4 }}>B</span>}
                <input className="input small" style={{ width: 54 }} value={p[k]} onChange={(e) => coord(k, e.target.value)} />
              </span>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 5, marginTop: 7 }}>
            <button className="btn sm" onClick={() => run({ op: 'parcel.split', a: A, b: B }, `拆分地块 A(${A.x},${A.z})→B(${B.x},${B.z})`)}>拆分</button>
            <button className="btn sm" onClick={() => run({ op: 'parcel.merge', a: A, b: B }, `合并地块 A(${A.x},${A.z}) / B(${B.x},${B.z})`)}>合并</button>
            <button className="btn sm" onClick={() => run({ op: 'parcel.vertex', at: A, to: B }, `移动顶点 A(${A.x},${A.z})→B(${B.x},${B.z})`)}>移动顶点</button>
          </div>
          <div className="desc mt6">拆分线 A→B 按空间锚点重放；合并作用于两点所在的两个共边地块；顶点位于道路图上时同步移动节点，保证道路与地块边界一致。</div>
          {doc.parcelEdits.length > 0 && (
            <div className="trace-list mt6">
              {doc.parcelEdits.slice(-8).map((e) => (
                <div className="trace-item" key={e.id}>{e.kind} · {e.id} · {e.kind === 'vertex'
                  ? `(${e.at.x},${e.at.z})→(${e.to.x},${e.to.z})`
                  : `(${e.a.x},${e.a.z})→(${e.b.x},${e.b.z})`}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function Inspector(props: InspectorProps) {
  const { doc, scene, selectedId, lastChanges, changeHistory, setField, setSeed, randomizeSeed, overrideObject, restoreObject, deleteSelected, tab, onTabChange } = props;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    '地形与路网': false, '建筑高度': true, '分布密度': true, '中央开放空间': true, '材质与表现': true,
  });
  const [seedDraft, setSeedDraft] = useState(String(doc.seed));
  useEffect(() => setSeedDraft(String(doc.seed)), [doc.seed]);

  const selected = useMemo(
    () => scene.buildings.find((b) => b.id === selectedId),
    [scene.buildings, selectedId],
  );
  useEffect(() => { if (selectedId) onTabChange('object'); }, [selectedId, onTabChange]);

  const fieldsFor = (group: string) => RULE_FIELDS.filter((f) => f.group === group && (showAdvanced || !f.advanced));

  return (
    <div className="inspector panel">
      <div className="panel-head">
        <h2>PCG Inspector</h2>
        <span className="spacer" />
        <span className="tag accent">v{doc.schemaVersion}</span>
      </div>
      <div className="tabs">
        {([['rules', '规则'], ['stats', '统计'], ['pipeline', '管线'], ['graph', '图形编辑'], ['object', '对象'], ['changes', '变化']] as Array<[TabId, string]>).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => onTabChange(id)}>{label}</button>
        ))}
      </div>

      <div className="panel-body">
        {tab === 'rules' && (
          <>
            <div className="section">
              <div className="section-body">
                <div className="field">
                  <div className="field-head"><label>随机种子</label><span className="tag">确定性源</span></div>
                  <div className="field-row">
                    <input
                      className="input mono grow" value={seedDraft}
                      onChange={(e) => setSeedDraft(e.target.value)}
                      onBlur={() => { const n = Number(seedDraft); if (Number.isFinite(n) && n !== doc.seed) setSeed(Math.trunc(n)); else setSeedDraft(String(doc.seed)); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <button className="btn sm" onClick={randomizeSeed}>换一批</button>
                  </div>
                  <div className="desc">种子与网格坐标共同决定每个属性值；改变种子会重建全城，局部编辑请改用分区倍率。</div>
                </div>
                <button className={`toggle ${showAdvanced ? 'on' : ''}`} onClick={() => setShowAdvanced((v) => !v)}>
                  <span className="track" /><span className="small muted">显示高级参数（{RULE_FIELDS.filter((f) => f.advanced).length} 项）</span>
                </button>
              </div>
            </div>

            {RULE_GROUPS.map((group) => {
              const fields = fieldsFor(group);
              const open = openGroups[group];
              return (
                <div className="section" key={group}>
                  <div className="section-title" onClick={() => setOpenGroups((o) => ({ ...o, [group]: !o[group] }))}>
                    <span className="chev">{open ? '▾' : '▸'}</span>{group}<span className="spacer" /><span className="tag">{fields.length}</span>
                  </div>
                  {open && <div className="section-body">{fields.map((f) => <FieldControl key={f.path} field={f} doc={doc} setField={setField} />)}</div>}
                </div>
              );
            })}
          </>
        )}

        {tab === 'stats' && (
          <>
            <div className="section"><div className="section-body">
              <div className="stat-grid">
                <div className="stat-card"><div className="k">建筑总数</div><div className="v">{scene.stats.buildingCount}</div></div>
                <div className="stat-card"><div className="k">平均高度</div><div className="v">{scene.stats.avgHeight.toFixed(1)}<small>m</small></div></div>
                <div className="stat-card"><div className="k">最高建筑</div><div className="v">{scene.stats.maxHeight.toFixed(0)}<small>m</small></div></div>
                <div className="stat-card"><div className="k">可建用地占用率</div><div className="v">{(scene.stats.buildingCount / Math.max(1, scene.stats.availableCells) * 100).toFixed(1)}<small>%</small></div></div>
                <div className="stat-card"><div className="k">可建地块</div><div className="v">{scene.stats.availableCells}</div></div>
                <div className="stat-card"><div className="k">场景指纹</div><div className="v" style={{ fontSize: 12 }}>{scene.fingerprint}</div></div>
              </div>
            </div></div>
            <div className="section">
              <div className="section-title">分区统计</div>
              <div className="section-body" style={{ padding: '4px 11px 11px' }}>
                <table className="zone-table">
                  <thead><tr><th>分区</th><th>建筑</th><th>占用率</th><th>均高</th></tr></thead>
                  <tbody>
                    {scene.stats.byZone.map((z) => (
                      <tr key={z.zone}>
                        <td><span className="swatch" style={{ background: ZONE_COLORS[z.zone], display: 'inline-block', marginRight: 5 }} />{ZONE_LABELS[z.zone]}</td>
                        <td>{z.buildings}</td>
                        <td>
                          {(z.occupancy * 100).toFixed(0)}%
                          <div className="bar-mini"><i style={{ width: `${Math.min(100, z.occupancy * 100)}%`, background: ZONE_COLORS[z.zone] }} /></div>
                        </td>
                        <td>{z.avgHeight.toFixed(0)}m</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="inline-note mt6">
                  分区采用<b>轴主导互斥划分</b>：每个网格只属于一个分区，因此「东侧密度 -30%」的影响范围可被逐对象验证，非东侧统计值保持不变。
                </div>
              </div>
            </div>
            <div className="section">
              <div className="section-title">链路产出统计</div>
              <div className="section-body">
                <div className="stat-grid">
                  <div className="stat-card"><div className="k">道路总长</div><div className="v">{scene.stats.roadLength.toFixed(0)}<small>m</small></div></div>
                  <div className="stat-card"><div className="k">街区 / 地块</div><div className="v">{scene.stats.blocks} / {scene.stats.parcels}</div></div>
                  <div className="stat-card"><div className="k">公园 / 面积</div><div className="v">{scene.stats.parks} · {scene.stats.parkArea}<small>m²</small></div></div>
                  <div className="stat-card"><div className="k">行道 / 公园树</div><div className="v">{scene.stats.streetTrees} / {scene.stats.parkTrees}</div></div>
                </div>
                <table className="zone-table">
                  <thead><tr><th>公园尺寸等级</th><th>数量</th><th>地块功能</th><th>数量</th></tr></thead>
                  <tbody>
                    {(['pocket', 'neighborhood', 'central'] as const).map((k, i) => {
                      const uses = Object.keys(scene.stats.landUseCounts) as LandUseId[];
                      const u = uses[(i * 2) % uses.length];
                      const u2 = uses[(i * 2 + 1) % uses.length];
                      return (
                        <tr key={k}>
                          <td>{PARK_SIZE_LABELS[k]}</td><td>{scene.stats.parksBySize[k]}</td>
                          <td>{LAND_USE_LABELS[u]} / {LAND_USE_LABELS[u2]}</td>
                          <td>{scene.stats.landUseCounts[u]} / {scene.stats.landUseCounts[u2]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <table className="zone-table mt6">
                  <thead><tr><th>建筑原型</th><th>数量</th><th>扩展预留</th><th>数量</th></tr></thead>
                  <tbody>
                    {(Object.keys(scene.stats.archetypeCounts) as ArchetypeId[]).map((a, i) => (
                      <tr key={a}>
                        <td>{ARCHETYPE_LABELS[a]}</td><td>{scene.stats.archetypeCounts[a]}</td>
                        <td>{i === 0 ? '水系预留地块' : i === 1 ? '地形预留地块' : i === 2 ? '抑制的内部道路' : '—'}</td>
                        <td>{i === 0 ? scene.stats.reservedWater : i === 1 ? scene.stats.reservedTerrain : i === 2 ? scene.stats.suppressedRoads : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {tab === 'pipeline' && (
          <>
            <div className="section">
              <div className="section-title">阶段依赖 DAG<span className="spacer" /><span className="tag">{buildStagePlan().levels.length} 层</span></div>
              <div className="section-body" style={{ padding: '4px 11px 11px' }}>
                <table className="zone-table">
                  <thead><tr><th>阶段</th><th>依赖</th><th>产出</th><th>状态</th></tr></thead>
                  <tbody>
                    {scene.stages.map((s) => {
                      const meta = STAGE_GRAPH.find((m) => m.id === s.id);
                      return (
                        <tr key={s.id} title={meta?.description}>
                          <td>{s.label}<div className="mono muted" style={{ fontSize: 9.5 }}>{s.id}</div></td>
                          <td className="mono" style={{ fontSize: 9.5 }}>{s.deps.length ? s.deps.join(', ') : '—'}</td>
                          <td>{s.produced}</td>
                          <td style={{ color: s.enabled ? 'var(--green)' : 'var(--muted)' }}>{s.enabled ? '运行' : '预留'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="inline-note mt6">
                  依赖由 <b>ctx.upstream()</b> 运行时守卫：阶段读取未声明的上游会直接抛错。S4a 建筑与 S4b 公园同层可并行；S5 树木刻意不依赖 buildings，因此调整建筑密度不会扰动树木。
                </div>
              </div>
            </div>
            <div className="section">
              <div className="section-title">空间无重叠校验</div>
              <div className="section-body">
                <div className={`inline-note`} style={{ borderColor: scene.spatial.ok ? '#2c5540' : '#5c322e', color: scene.spatial.ok ? 'var(--green)' : 'var(--red)' }}>
                  {scene.spatial.ok ? 'PASS · 全链路无空间冲突' : `${scene.spatial.issues.length} 处冲突`}
                  <div className="small muted mt6">
                    最小株距 {scene.spatial.minTreeSpacing} m（要求 ≥ {doc.rules.pipeline.trees.minSpacing} m）·
                    最小路缘净距 {scene.spatial.minRoadClearance} m（要求 ≥ {doc.rules.pipeline.trees.roadSetback} m）
                  </div>
                </div>
                {!scene.spatial.ok && (
                  <div className="trace-list">
                    {scene.spatial.issues.slice(0, 12).map((iss, i) => (
                      <div className="trace-item" key={i}>{iss.code} · {iss.a} / {iss.b} · {iss.detail}</div>
                    ))}
                  </div>
                )}
                <div className="kv-list mt6">
                  {Object.entries(scene.spatial.checks).map(([k, v]) => (
                    <div className="kv" key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
                  ))}
                </div>
              </div>
            </div>
            <div className="section">
              <div className="section-title">扩展点（默认关闭）</div>
              <div className="section-body">
                {extensionStatus(doc).map((e) => (
                  <div className="inline-note" key={e.id} style={{ marginBottom: 6 }}>
                    <b>{e.label}</b> · {e.enabled ? '已启用' : '未启用'}
                    <div className="small muted mt6">{e.contract}</div>
                    <div className="small muted">下游影响：{downstreamOf(e.id as Parameters<typeof downstreamOf>[0]).join(', ') || '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'graph' && <GraphEditor doc={doc} scene={scene} />}

        {tab === 'object' && (
          selected ? (
            <>
              <div className="section">
                <div className="section-title">选中对象 · <span className="mono">{selected.id}</span></div>
                <div className="section-body">
                  <div className="kv-list">
                    <div className="kv"><span className="k">所属地块</span><span className="v">{selected.parcelId}</span></div>
                    <div className="kv"><span className="k">功能 / 原型</span><span className="v">{LAND_USE_LABELS[selected.landUse]} · {ARCHETYPE_LABELS[selected.archetype]}</span></div>
                    <div className="kv"><span className="k">槽位坐标</span><span className="v">{selected.cell.join(' , ')}</span></div>
                    <div className="kv"><span className="k">分区</span><span className="v" style={{ color: ZONE_COLORS[selected.zone] }}>{ZONE_LABELS[selected.zone]}</span></div>
                    <div className="kv"><span className="k">世界坐标</span><span className="v">X {selected.x.toFixed(1)} / Z {selected.z.toFixed(1)}</span></div>
                    <div className="kv"><span className="k">建筑 AABB</span><span className="v">[{selected.bounds.minX.toFixed(1)}, {selected.bounds.maxX.toFixed(1)}] × [{selected.bounds.minZ.toFixed(1)}, {selected.bounds.maxZ.toFixed(1)}]</span></div>
                    <div className="kv"><span className="k">累计退界</span><span className="v">{selected.setback.toFixed(2)} m（地块 + 原型）</span></div>
                    <div className="kv"><span className="k">基底尺寸</span><span className="v">{selected.w.toFixed(2)} × {selected.d.toFixed(2)} m</span></div>
                    <div className="kv"><span className="k">建筑高度</span><span className="v">{selected.h.toFixed(2)} m</span></div>
                    <div className="kv"><span className="k">立面 / 屋顶</span><span className="v"><span className="swatch" style={{ background: selected.color, display: 'inline-block', marginRight: 5 }} />{selected.color} · {selected.roof}</span></div>
                    <div className="kv"><span className="k">地块哈希</span><span className="v">0x{selected.hash.toString(16).toUpperCase()}</span></div>
                    <div className="kv"><span className="k">人工覆写</span><span className="v">{selected.overridden ? '是' : '否'} · {selected.deleted ? '已删除' : selected.visible ? '可见' : '已隐藏'}</span></div>
                  </div>
                  <div className="row wrap" style={{ gap: 5 }}>
                    <label className="small muted">高度</label>
                    <input
                      className="input" style={{ width: 80 }} type="number" min={4} max={500} defaultValue={Math.round(selected.h)}
                      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== selected.h) overrideObject(selected.id, { height: v }); }}
                    />
                    <label className="small muted">立面</label>
                    <input type="color" value={selected.color} style={{ width: 34, height: 24, padding: 0, background: 'none', border: '1px solid var(--line)' }} onChange={(e) => overrideObject(selected.id, { color: e.target.value })} />
                    <button className="btn sm" onClick={() => overrideObject(selected.id, { visible: !selected.visible })}>{selected.visible ? '隐藏' : '显示'}</button>
                    {selected.deleted
                      ? <button className="btn sm" onClick={() => restoreObject(selected.id)}>恢复</button>
                      : <button className="btn sm" onClick={deleteSelected}>删除</button>}
                  </div>
                </div>
              </div>
              <div className="section">
                <div className="section-title">规则追溯 · 该对象为何长这样</div>
                <div className="section-body">
                  <div className="trace-list">
                    {selected.trace.map((t, i) => <div className="trace-item" key={i}>{i + 1}. {t}</div>)}
                  </div>
                  <div className="inline-note">
                    所有随机值由 <b>sample(seed, 属性盐, gx, gy)</b> 独立求得，不依赖生成顺序。修改其他分区规则不会改变本对象的抽样值。
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty">在 3D 视口点击建筑，或在左侧 Scene Hierarchy 中选择对象。<br />此处将显示对象属性与完整规则追溯链。</div>
          )
        )}

        {tab === 'changes' && (
          <>
            <div className="section">
              <div className="section-title">规则变化时间线<span className="spacer" /><span className="tag">{changeHistory.length} 步 · 最近 {lastChanges.length} 处</span></div>
              <div className="section-body" style={{ padding: '8px 11px 11px' }}>
                {changeHistory.length === 0
                  ? <div className="empty">尚无规则变化。<br />执行一条自然语言命令或修改参数后，此处会列出逐字段 diff。</div>
                  : (() => {
                      const idx = Math.min(historyIndex, changeHistory.length - 1);
                      const entry = changeHistory[idx];
                      return (
                        <>
                          <select className="select small mb6" value={idx} onChange={(e) => setHistoryIndex(Number(e.target.value))}>
                            {changeHistory.map((h, i) => (
                              <option key={h.key} value={i}>{i === 0 ? '最新' : `−${i}`} · {h.time} · {h.source} · {h.note.slice(0, 22)}（{h.changes.length} 处）</option>
                            ))}
                          </select>
                          <table className="diff-table">
                            <thead><tr><th>字段</th><th>作用域</th><th>前 → 后</th></tr></thead>
                            <tbody>
                              {entry.changes.map((c, i) => (
                                <tr key={i}>
                                  <td>
                                    <div>{FIELD_BY_PATH[c.path]?.label ?? c.path}</div>
                                    <div className="mono muted" style={{ fontSize: 9.5 }}>{c.path}</div>
                                  </td>
                                  <td>{c.scope}<div className="muted" style={{ fontSize: 9.5 }}>{c.source}</div></td>
                                  <td>
                                    <span className="diff-before">{String(c.before)}</span> → <span className="diff-after">{String(c.after)}</span>
                                    {c.note && <div className="muted" style={{ fontSize: 9.5, marginTop: 2 }}>{c.note}</div>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="small muted mt6">当前显示第 {idx + 1} / {changeHistory.length} 条（最新在前）。撤销、重做、加载等系统操作同样产生可追溯 diff。</div>
                        </>
                      );
                    })()}
              </div>
            </div>
            <div className="section">
              <div className="section-title">确定性说明</div>
              <div className="section-body">
                <div className="inline-note">
                  当前指纹 <b>{scene.fingerprint}</b>。相同 SceneDocument（规则 + 种子 + 覆写）必然推导出相同几何与相同指纹；保存/加载后可复核。
                </div>
                <div className="inline-note">
                  局部编辑通过<b>分区倍率</b>实现，不重排随机序列。撤销/重做以整份 SceneDocument 快照为粒度，最多 60 步。
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
