import { useMemo, useState } from 'react';
import {
  ARCHETYPE_LABELS, LAND_USE_LABELS, PARK_SIZE_LABELS, ZONE_COLORS, ZONE_IDS, ZONE_LABELS,
  type ArchetypeId, type GeneratedScene, type SceneDocument, type ZoneId,
} from '../core/types';

interface HierarchyProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  hiddenZones: ZoneId[];
  toggleZone: (z: ZoneId) => void;
  hiddenGroups: string[];
  toggleGroup: (g: string) => void;
}

const STATIC_NODES: Array<{
  key: string; label: string; count: (s: GeneratedScene) => string; detail?: 'parks' | 'parcels';
}> = [
  { key: 'terrain', label: 'S0 地形基底', count: (s) => `${s.stats.cols}×${s.stats.rows} 格` },
  { key: 'roads', label: 'S1 道路网络', count: (s) => `${s.roads.length} 段 · 主干 ${s.stats.arterialSegments}` },
  { key: 'blocks', label: 'S1 街区', count: (s) => `${s.stats.blocks} 个` },
  { key: 'parcels', label: 'S2 地块', count: (s) => `${s.stats.parcels} 块`, detail: 'parcels' },
  { key: 'parks', label: 'S4b 公园', count: (s) => `${s.stats.parks} 处`, detail: 'parks' },
  { key: 'trees', label: 'S5 乔木', count: (s) => `${s.trees.length} 株` },
];

export function Hierarchy(props: HierarchyProps) {
  const { scene, selectedId, onSelect, hiddenZones, toggleZone, hiddenGroups, toggleGroup } = props;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    site: true, buildings: true, archetypes: false,
    core: false, east: false, west: false, north: false, south: false,
    'grp.parcels': false, 'grp.parks': false,
  });
  const [limits, setLimits] = useState<Record<string, number>>({});

  const toggleExpand = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));
  const eye = (hidden: boolean) => hidden ? '○' : '◉';

  const grouped = useMemo(() => {
    const map = Object.fromEntries(ZONE_IDS.map((z) => [z, [] as typeof scene.buildings])) as Record<ZoneId, typeof scene.buildings>;
    for (const b of scene.buildings) map[b.zone].push(b);
    return map;
  }, [scene.buildings]);

  const visibleBuildings = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.trim().toLowerCase();
    return scene.buildings.filter((b) => b.id.toLowerCase().includes(q) || b.zone.includes(q) || b.archetype.includes(q) || b.parcelId.includes(q));
  }, [query, scene.buildings]);

  return (
    <div className="hierarchy panel">
      <div className="panel-head">
        <h2>Scene Hierarchy</h2>
        <span className="spacer" />
        <span className="tag">{scene.buildings.length + scene.parcels.length + scene.parks.length + scene.trees.length} 对象</span>
      </div>
      <div className="tree-search">
        <input className="input small" placeholder="搜索建筑 / 地块 / 原型" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="panel-body">
        {visibleBuildings ? (
          <>
            <div className="tree-row group"><span className="caret" /><span className="label">搜索结果</span><span className="count">{visibleBuildings.length}</span></div>
            {visibleBuildings.slice(0, 120).map((b) => (
              <div key={b.id} className={`tree-row ${selectedId === b.id ? 'selected' : ''}`} style={{ paddingLeft: 18 }} onClick={() => onSelect(b.id)}>
                <span className="swatch" style={{ background: b.color }} />
                <span className="label mono">{b.id}</span>
                <span className="count">{b.h.toFixed(0)}m</span>
              </div>
            ))}
            {visibleBuildings.length === 0 && <div className="empty">无匹配对象</div>}
          </>
        ) : (
          <>
            <div className="tree-row group" onClick={() => toggleExpand('site')}>
              <span className="caret">{expanded.site ? '▾' : '▸'}</span>
              <span className="label">场地与管线图层</span><span className="count">{STATIC_NODES.length}</span>
            </div>
            {expanded.site && STATIC_NODES.map((n) => {
              const key = `grp.${n.key}`;
              const open = expanded[key];
              return (
                <div key={n.key}>
                  <div className="tree-row" style={{ paddingLeft: 20 }} onClick={() => n.detail && toggleExpand(key)}>
                    <span className="caret">{n.detail ? (open ? '▾' : '▸') : ''}</span>
                    <span className="label">{n.label}</span>
                    <span className="count">{n.count(scene)}</span>
                    <button className="eye" title={hiddenGroups.includes(n.key === 'parks' ? 'parks' : n.key) ? '显示' : '隐藏'}
                      onClick={(e) => { e.stopPropagation(); toggleGroup(n.key === 'plaza' ? 'parks' : n.key); }}>
                      {eye(hiddenGroups.includes(n.key === 'parks' ? 'parks' : n.key))}
                    </button>
                  </div>
                  {open && n.detail === 'parks' && scene.parks.slice(0, 60).map((p) => (
                    <div key={p.id} className="tree-row muted small" style={{ paddingLeft: 40 }}>
                      <span className="swatch" style={{ background: p.style === 'park' ? '#3f9e6b' : p.style === 'water' ? '#2f86ab' : '#98a3ac' }} />
                      <span className="label mono">{p.id}</span>
                      <span className="count">{PARK_SIZE_LABELS[p.sizeClass]} · {Math.round(p.area)}m²</span>
                    </div>
                  ))}
                  {open && n.detail === 'parcels' && scene.parcels.slice(0, 80).map((p) => {
                    const u = scene.uses.find((x) => x.parcelId === p.id);
                    return (
                      <div key={p.id} className="tree-row muted small" style={{ paddingLeft: 40 }}>
                        <span className="label mono">{p.id}</span>
                        <span className="count">{u ? LAND_USE_LABELS[u.use] : '-'} · {Math.round(p.area)}m²</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div className="tree-row group" style={{ marginTop: 4 }} onClick={() => toggleExpand('buildings')}>
              <span className="caret">{expanded.buildings ? '▾' : '▸'}</span>
              <span className="label">S4a 建筑 · 按分区</span><span className="count">{scene.buildings.length}</span>
            </div>
            {expanded.buildings && ZONE_IDS.map((z) => {
              const list = grouped[z];
              const limit = limits[z] ?? 60;
              const hidden = hiddenZones.includes(z);
              return (
                <div key={z}>
                  <div className="tree-row" style={{ paddingLeft: 18 }} onClick={() => toggleExpand(z)}>
                    <span className="caret">{expanded[z] ? '▾' : '▸'}</span>
                    <span className="swatch" style={{ background: ZONE_COLORS[z] }} />
                    <span className="label">{ZONE_LABELS[z]}</span>
                    <span className="count">{list.length}</span>
                    <button className="eye" title={hidden ? '显示该分区' : '隐藏该分区'} onClick={(e) => { e.stopPropagation(); toggleZone(z); }}>{eye(hidden)}</button>
                  </div>
                  {expanded[z] && (
                    <>
                      {list.slice(0, limit).map((b) => (
                        <div key={b.id} className={`tree-row ${selectedId === b.id ? 'selected' : ''}`} style={{ paddingLeft: 40 }} onClick={() => onSelect(b.id)}>
                          <span className="swatch" style={{ background: b.deleted ? '#4a3a3a' : b.color }} />
                          <span className="label mono">{b.id}</span>
                          <span className="count">{b.deleted ? '已删除' : `${ARCHETYPE_LABELS[b.archetype]} ${b.h.toFixed(0)}m`}</span>
                        </div>
                      ))}
                      {list.length > limit && (
                        <div className="tree-row muted small" style={{ paddingLeft: 40 }} onClick={() => setLimits((l) => ({ ...l, [z]: limit + 100 }))}>
                          … 还有 {list.length - limit} 个，点击加载更多
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            <div className="tree-row group" style={{ marginTop: 4 }} onClick={() => toggleExpand('archetypes')}>
              <span className="caret">{expanded.archetypes ? '▾' : '▸'}</span>
              <span className="label">S4a 建筑 · 按原型</span><span className="count">{Object.values(scene.stats.archetypeCounts).reduce((a, b) => a + b, 0)}</span>
            </div>
            {expanded.archetypes && (Object.keys(scene.stats.archetypeCounts) as ArchetypeId[]).map((a) => (
              <div key={a} className="tree-row muted small" style={{ paddingLeft: 26 }}>
                <span className="label">{ARCHETYPE_LABELS[a]}</span>
                <span className="count">{scene.stats.archetypeCounts[a]} 栋</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="tree-note">
        对象 ID 由阶段内稳定序号派生（<span className="mono">bld.&lt;地块序号&gt;.&lt;槽位&gt;</span>），与生成顺序无关；建筑严格落在<span className="mono">parcel.buildable</span>内，树木只落在退界绿带或公园内。
      </div>
    </div>
  );
}
