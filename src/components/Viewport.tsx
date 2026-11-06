import { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { CityScene } from './CityScene';
import {
  LAND_USE_COLORS, LAND_USE_LABELS, ZONE_COLORS, ZONE_IDS, ZONE_LABELS,
  type GeneratedScene, type SceneDocument,
} from '../core/types';
import type { CameraPreset, ViewMode } from '../core/store';

interface ViewportProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  cameraPreset: CameraPreset;
  cameraNonce: number;
  setCamera: (p: CameraPreset) => void;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  hiddenZones: string[];
  hiddenGroups: string[];
  showNodes: boolean;
  setShowNodes: (v: boolean) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onNodeDragEnd: (id: string, x: number, z: number) => void;
}

const CAMERA_LABELS: Array<[CameraPreset, string]> = [
  ['iso', '等轴测'], ['ne35', '东北 35°'], ['top', '顶视'], ['front', '正视'],
];

function CameraRig({ preset, nonce, span }: { preset: CameraPreset; nonce: number; span: number }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    const R = span * 1.05;
    let p: [number, number, number];
    switch (preset) {
      case 'top': p = [0.001, R * 1.4, 0.001]; camera.up.set(0, 0, -1); break;
      case 'front': p = [0, R * 0.34, R * 1.05]; camera.up.set(0, 1, 0); break;
      case 'ne35': {
        const el = (35 * Math.PI) / 180;
        const h = R * Math.cos(el) * Math.cos(Math.PI / 4);
        p = [h, R * Math.sin(el), -h];
        camera.up.set(0, 1, 0);
        break;
      }
      default: p = [R * 0.72, R * 0.78, R * 0.72]; camera.up.set(0, 1, 0);
    }
    camera.position.set(...p);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const c = controls as unknown as {
      target?: THREE.Vector3; update?: () => void;
    } | null;
    if (c?.target) { c.target.set(0, 0, 0); c.update?.(); }
  }, [preset, nonce, span, camera, controls]);
  return null;
}

export function Viewport(props: ViewportProps) {
  const {
    doc, scene, selectedId, onSelect, cameraPreset, cameraNonce, setCamera,
    viewMode, setViewMode, hiddenZones, hiddenGroups,
    showNodes, setShowNodes, selectedNodeId, onSelectNode, onNodeDragEnd,
  } = props;
  const span = Math.max(doc.rules.terrain.width, doc.rules.terrain.depth);
  const gridStep = Math.max(4, Math.round(span / 20));

  return (
    <div className="viewport panel">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
        camera={{ position: [span * 0.72, span * 0.78, span * 0.72], fov: 42, near: 1, far: span * 6 }}
        onPointerMissed={() => onSelect(null)}
      >
        <CameraRig preset={cameraPreset} nonce={cameraNonce} span={span} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2.02} minDistance={span * 0.12} maxDistance={span * 4} />
        <CityScene
          doc={doc} scene={scene} selectedId={selectedId} onSelect={onSelect}
          viewMode={viewMode} hiddenZones={hiddenZones} hiddenGroups={hiddenGroups}
          showNodes={showNodes} selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode} onNodeDragEnd={onNodeDragEnd}
        />
      </Canvas>

      <div className="hud">
        <div className="hud-tl">
          <div className="hud-card hud-kv">
            <span>建筑</span><b>{scene.stats.visibleBuildings}</b>
            <span>地块</span><b>{scene.stats.parcels}</b>
            <span>凹形</span><b>{scene.stats.concaveParcels}</b>
            <span>公园</span><b>{scene.stats.parks}</b>
            <span>乔木</span><b>{scene.trees.length}</b>
            <span>指纹</span><b>{scene.fingerprint}</b>
          </div>
          <div className="hud-card hud-kv">
            <span>节点/路段</span><b>{scene.stats.roadNodes} / {scene.stats.roadEdges}</b>
            <span>seed</span><b>{doc.seed}</b>
            <span>schema</span><b>v{doc.schemaVersion}</b>
            <span>rev</span><b>{doc.revision}</b>
            <span>空间校验</span><b style={{ color: scene.spatial.ok ? 'var(--green)' : 'var(--red)' }}>{scene.spatial.ok ? 'PASS' : `${scene.spatial.issues.length} 冲突`}</b>
          </div>
        </div>

        <div className="hud-tr">
          <div className="hud-card row" style={{ gap: 4 }}>
            {CAMERA_LABELS.map(([key, label]) => (
              <button key={key} className={`btn sm ghost ${cameraPreset === key ? 'active' : ''}`} onClick={() => setCamera(key)}>{label}</button>
            ))}
            <span style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 2px' }} />
            <button className={`btn sm ghost ${viewMode === 'material' ? 'active' : ''}`} onClick={() => setViewMode('material')}>材质</button>
            <button className={`btn sm ghost ${viewMode === 'zone' ? 'active' : ''}`} onClick={() => setViewMode('zone')}>分区</button>
            <button className={`btn sm ghost ${viewMode === 'parcel' ? 'active' : ''}`} onClick={() => setViewMode('parcel')}>地块/功能</button>
            <button className={`btn sm ghost ${showNodes ? 'active' : ''}`} onClick={() => setShowNodes(!showNodes)} title="显示道路节点手柄，可拖动改变道路走向">节点编辑</button>
          </div>
        </div>

        <div className="hud-bl">
          <div className="compass hud-card">
            <span className="n">N</span><span>↑ -Z　·　E → +X</span>
          </div>
          <div className="scale-bar hud-card">
            <div className="bar" />
            <span>网格 {gridStep} m（示意）</span>
          </div>
          <div className="hud-card small muted" style={{ maxWidth: 250, lineHeight: 1.5 }}>
            左键旋转 · 滚轮缩放 · 右键平移 · 点击建筑选中<br />
            {showNodes ? '拖动橙色节点可改变道路走向，地块与建筑自动重适配' : '开启「节点编辑」可拖拽道路节点'}<br />
            {selectedNodeId ? `已选节点 ${selectedNodeId}` : selectedId ? `已选中 ${selectedId}` : '未选中对象'}
          </div>
        </div>

        <div className="hud-br">
          <div className="hud-card legend">
            {viewMode === 'parcel'
              ? (['office', 'residential', 'research', 'commercial', 'park', 'plaza'] as const).map((u) => (
                  <span key={u}><i style={{ background: LAND_USE_COLORS[u] }} />{LAND_USE_LABELS[u]}</span>
                ))
              : ZONE_IDS.map((z) => (
                  <span key={z}><i style={{ background: ZONE_COLORS[z] }} />{ZONE_LABELS[z]}</span>
                ))}
            <span className="muted">{viewMode === 'zone' ? '按分区着色' : viewMode === 'parcel' ? '按功能着色 · 显示地块边界' : '按材质着色'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
