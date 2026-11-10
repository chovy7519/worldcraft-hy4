/**
 * 三维场景渲染层（v1.2.0 可编辑几何版；配色已回退到修改前）。
 * - 道路段支持任意走向（实例矩阵带 Y 旋转）
 * - 建筑旋转足迹贴合斜向/多边形地块（实例矩阵带 Y 旋转）
 * - 公园用 earcut 三角化后的合并 BufferGeometry，可渲染凹多边形
 * - 地块边界用单个 LineSegments；道路节点用实例球体，可点击/拖拽
 * - 配色回退后直接使用数据层材质色，不改写 SceneDocument、不参与场景指纹；
 *   布局、几何与交互逻辑保持不变
 */
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import {
  LAND_USE_COLORS, ZONE_COLORS,
  type BuildingObject, type GeneratedScene, type ParkObject, type SceneDocument,
} from '../core/types';
import type { ViewMode } from '../core/store';

/** 图面主题：sheet = 浅色图纸（参考图 2/3/4/5），nautical = 深色海图（参考图 1） */
export type SheetTheme = 'sheet' | 'nautical';

interface CitySceneProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  viewMode: ViewMode;
  hiddenZones: string[];
  hiddenGroups: string[];
  showNodes: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onNodeDragEnd: (id: string, x: number, z: number) => void;
  theme: SheetTheme;
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
const draftTmp = new THREE.Color();
interface Instance { matrix: THREE.Matrix4; color: THREE.Color }

interface ThemePalette {
  bg: string; ground: string; plinth: string;
  grid1: string; grid2: string;
  roadMain: string; roadMinor: string;
  parkStyles: Record<string, string>;
  water: string; trunk: string;
  canopy: string[]; canopyStreet: string[];
  node: string; nodeSelected: string;
  parcelLine: string; selectLine: string;
  hemiSky: string; hemiGround: string;
  emissive: string;
}

/** 依据 docs/VISUAL_STYLE.md §6 的三维视口配色映射表 */
/* 配色回退：两套主题共用修改前的深色色板，主题切换逻辑保持不变 */
const THEME: Record<SheetTheme, ThemePalette> = {
  sheet: {
    bg: '#0a121a', ground: '#14212b', plinth: '#0d1620',
    grid1: '#2b4657', grid2: '#1b2c37',
    roadMain: '#34495a', roadMinor: '#25333f',
    parkStyles: { park: '#2b7350', plaza: '#7a858f', water: '#1f6a8c' },
    water: '#2b7fa8', trunk: '#4b3d30',
    canopy: ['#3a9163', '#4baa76', '#2f875e', '#5cb683'],
    canopyStreet: ['#4f9e6f', '#57a97a', '#438c62', '#63b184'],
    node: '#ef9a4a', nodeSelected: '#ffdf7a',
    parcelLine: '#8fd3ff', selectLine: '#ffc65a',
    hemiSky: '#bcd9f5', hemiGround: '#14202a',
    emissive: '#0d2b3d',
  },
  nautical: {
    bg: '#0a121a', ground: '#14212b', plinth: '#0d1620',
    grid1: '#2b4657', grid2: '#1b2c37',
    roadMain: '#34495a', roadMinor: '#25333f',
    parkStyles: { park: '#2b7350', plaza: '#7a858f', water: '#1f6a8c' },
    water: '#2b7fa8', trunk: '#4b3d30',
    canopy: ['#3a9163', '#4baa76', '#2f875e', '#5cb683'],
    canopyStreet: ['#4f9e6f', '#57a97a', '#438c62', '#63b184'],
    node: '#ef9a4a', nodeSelected: '#ffdf7a',
    parcelLine: '#8fd3ff', selectLine: '#ffc65a',
    hemiSky: '#bcd9f5', hemiGround: '#14202a',
    emissive: '#0d2b3d',
  },
};

/** 配色回退：返回数据层材质色本身，不做淡彩重映射（与修改前一致）。 */
function draftColor(hex: string, theme: SheetTheme, heightRatio = 0): string {
  void theme; void heightRatio;
  draftTmp.set(hex);
  return `#${draftTmp.getHexString()}`;
}

function useInstances(ref: RefObject<THREE.InstancedMesh>, items: Instance[]): void {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < items.length; i++) {
      mesh.setMatrixAt(i, items[i].matrix);
      mesh.setColorAt(i, items[i].color);
    }
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, items]);
}

function matrixOf(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0): THREE.Matrix4 {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, rotY, 0);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  return dummy.matrix.clone();
}

/** 所有公园多边形三角化后合并为一个几何体，支持凹形 */
function parkGeometry(parks: ParkObject[], theme: SheetTheme): THREE.BufferGeometry {
  const positions: number[] = []; const colors: number[] = [];
  const styles = THEME[theme].parkStyles;
  for (const park of parks) {
    if (park.polygon.length < 3) continue;
    let pts = park.polygon.map((q) => new THREE.Vector2(q.x, q.z));
    if (THREE.ShapeUtils.isClockWise(pts)) pts = pts.reverse();
    let faces: number[][];
    try { faces = THREE.ShapeUtils.triangulateShape(pts, []); } catch { continue; }
    const col = tmpColor.clone().set(styles[park.style] ?? styles.park);
    for (const tri of faces) {
      for (const idx of tri) {
        positions.push(pts[idx].x, 0.14, pts[idx].y);
        colors.push(col.r, col.g, col.b);
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  return geom;
}

/** 地块红线（每条边一条线段） */
function parcelLineGeometry(scene: GeneratedScene): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const p of scene.parcels) {
    const poly = p.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]; const b = poly[(i + 1) % poly.length];
      pts.push(a.x, 0.22, a.z, b.x, 0.22, b.z);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geom;
}

export function CityScene(props: CitySceneProps) {
  const {
    doc, scene, selectedId, onSelect, viewMode, hiddenZones, hiddenGroups,
    showNodes, selectedNodeId, onSelectNode, onNodeDragEnd, theme,
  } = props;
  const T = THEME[theme];
  const { width, depth } = doc.rules.terrain;
  const span = Math.max(width, depth);
  const [dragId, setDragId] = useState<string | null>(null);

  const visibleBuildings = useMemo(
    () => scene.buildings.filter((b) => b.visible && !b.deleted && !hiddenZones.includes(b.zone)),
    [scene.buildings, hiddenZones],
  );
  const buildingInstances = useMemo<Instance[]>(() => visibleBuildings.map((b) => ({
    matrix: matrixOf(b.x, b.h / 2, b.z, b.w, b.h, b.d, -b.orientation),
    color: tmpColor.clone().set(
      viewMode === 'zone' ? ZONE_COLORS[b.zone]
        : viewMode === 'parcel' ? LAND_USE_COLORS[b.landUse]
          : draftColor(b.color, theme, Math.min(1, b.h / 90)),
    ),
  })), [visibleBuildings, viewMode, theme]);
  const roofInstances = useMemo<Instance[]>(() => visibleBuildings.filter((b) => b.roof !== 'flat').map((b) => {
    const antenna = b.roof === 'antenna';
    return {
      matrix: matrixOf(b.x, b.h + (antenna ? 3.2 : 0.7), b.z,
        antenna ? 0.5 : b.w * 0.66, antenna ? 6.4 : 1.4, antenna ? 0.5 : b.d * 0.66, -b.orientation),
      color: tmpColor.clone().set(draftColor(b.color, theme, 0.6)).multiplyScalar(1.4),
    };
  }), [visibleBuildings, theme]);

  const roadInstances = useMemo<Instance[]>(() => {
    if (hiddenGroups.includes('roads')) return [];
    return scene.roads.map((r) => ({
      matrix: matrixOf(r.x, 0.05, r.z, r.length, 0.1, r.d, -r.angle),
      color: tmpColor.clone().set(r.cls === 'arterial' ? T.roadMain : T.roadMinor),
    }));
  }, [scene.roads, hiddenGroups, T]);

  const showTrees = !hiddenGroups.includes('trees');
  const trunks = useMemo<Instance[]>(() => !showTrees ? [] : scene.trees.map((t) => ({
    matrix: matrixOf(t.x, 1.1 * t.scale + 0.1, t.z, 0.42 * t.scale, 2.2 * t.scale, 0.42 * t.scale),
    color: tmpColor.clone().set(T.trunk),
  })), [scene.trees, showTrees, T]);
  const canopies = useMemo<Instance[]>(() => !showTrees ? [] : scene.trees.map((t) => ({
    matrix: matrixOf(t.x, 4.2 * t.scale + 0.1, t.z, 2.4 * t.scale, 5.8 * t.scale, 2.4 * t.scale),
    color: tmpColor.clone().set((t.context === 'street' ? T.canopyStreet : T.canopy)[t.hash % 4]),
  })), [scene.trees, showTrees, T]);

  const nodes = useMemo(() => showNodes ? scene.graphNodes : [], [showNodes, scene.graphNodes]);
  const nodeInstances = useMemo<Instance[]>(() => nodes.map((n) => ({
    matrix: matrixOf(n.x, 1.6, n.z, 2.4, 2.4, 2.4),
    color: tmpColor.clone().set(n.id === selectedNodeId ? T.nodeSelected : T.node),
  })), [nodes, selectedNodeId, T]);

  const parkGeom = useMemo(
    () => !hiddenGroups.includes('parks') ? parkGeometry(scene.parks, theme) : null,
    [scene.parks, hiddenGroups, theme],
  );
  const outlineGeom = useMemo(
    () => viewMode === 'parcel' && !hiddenGroups.includes('parcels') ? parcelLineGeometry(scene) : null,
    [viewMode, scene, hiddenGroups],
  );
  const waterInstances = useMemo<Instance[]>(() => scene.water.map((w) => ({
    matrix: matrixOf((w.bounds.minX + w.bounds.maxX) / 2, 0.16, (w.bounds.minZ + w.bounds.maxZ) / 2,
      w.bounds.maxX - w.bounds.minX, 0.04, w.bounds.maxZ - w.bounds.minZ),
    color: tmpColor.clone().set(T.water),
  })), [scene.water, T]);

  const buildingRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const roadRef = useRef<THREE.InstancedMesh>(null);
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const canopyRef = useRef<THREE.InstancedMesh>(null);
  const nodeRef = useRef<THREE.InstancedMesh>(null);
  const waterRef = useRef<THREE.InstancedMesh>(null);

  useInstances(buildingRef, buildingInstances);
  useInstances(roofRef, roofInstances);
  useInstances(roadRef, roadInstances);
  useInstances(trunkRef, trunks);
  useInstances(canopyRef, canopies);
  useInstances(nodeRef, nodeInstances);
  useInstances(waterRef, waterInstances);

  const selected = selectedId ? scene.buildings.find((b) => b.id === selectedId) : undefined;

  return (
    <>
      <color attach="background" args={[T.bg]} />
      <fog attach="fog" args={[T.bg, span * 1.25, span * 3.1]} />
      <ambientLight intensity={0.85} />
      <hemisphereLight args={[T.hemiSky, T.hemiGround, 0.6]} />
      <directionalLight position={[span * 0.55, span * 0.9, span * 0.32]} intensity={0.9}
        castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-span * 0.72} shadow-camera-right={span * 0.72}
        shadow-camera-top={span * 0.72} shadow-camera-bottom={-span * 0.72}
        shadow-camera-near={1} shadow-camera-far={span * 3} shadow-bias={-0.0008} />

      <mesh position={[0, -0.7, 0]} receiveShadow>
        <boxGeometry args={[width + 10, 1.3, depth + 10]} />
        <meshStandardMaterial color={T.plinth} roughness={1} metalness={0} />
      </mesh>
      {!hiddenGroups.includes('terrain') && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow>
          <planeGeometry args={[width, depth]} />
          <meshStandardMaterial color={T.ground} roughness={1} metalness={0} />
        </mesh>
      )}
      <gridHelper args={[span, Math.max(4, Math.round(span / 20)), T.grid1, T.grid2]} position={[0, 0.015, 0]} />

      {/* S1 任意走向的分级道路 */}
      <instancedMesh key={`roads-${roadInstances.length}`} ref={roadRef} args={[undefined, undefined, Math.max(1, roadInstances.length)]} frustumCulled={false} receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} />
      </instancedMesh>

      {/* S4b 多边形公园（含凹形），一次 draw call */}
      {parkGeom && (
        <mesh geometry={parkGeom} receiveShadow frustumCulled={false}>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={1} metalness={0} />
        </mesh>
      )}

      {/* E1 水系占位 */}
      <instancedMesh key={`water-${waterInstances.length}`} ref={waterRef} args={[undefined, undefined, Math.max(1, waterInstances.length)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" transparent opacity={0.85} roughness={0.6} metalness={0} />
      </instancedMesh>

      {/* S2 地块红线 */}
      {outlineGeom && (
        <lineSegments geometry={outlineGeom} frustumCulled={false}>
          <lineBasicMaterial color={T.parcelLine} transparent opacity={0.85} depthTest={false} />
        </lineSegments>
      )}

      {/* S5 乔木 */}
      <instancedMesh key={`trunks-${trunks.length}`} ref={trunkRef} args={[undefined, undefined, Math.max(1, trunks.length)]} frustumCulled={false} castShadow>
        <cylinderGeometry args={[0.5, 0.6, 1, 6]} />
        <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} />
      </instancedMesh>
      <instancedMesh key={`canopy-${canopies.length}`} ref={canopyRef} args={[undefined, undefined, Math.max(1, canopies.length)]} frustumCulled={false} castShadow>
        <coneGeometry args={[1, 1, 7]} />
        <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} />
      </instancedMesh>

      {/* S4a 旋转建筑足迹 */}
      <instancedMesh key={`bld-${buildingInstances.length}-${viewMode}-${theme}`} ref={buildingRef}
        args={[undefined, undefined, Math.max(1, buildingInstances.length)]} frustumCulled={false} castShadow receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          const b: BuildingObject | undefined = visibleBuildings[e.instanceId ?? -1];
          if (b) onSelect(b.id);
        }}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.95} metalness={0}
          emissive={T.emissive} emissiveIntensity={doc.rules.material.emissive * 0.22} />
      </instancedMesh>
      <instancedMesh key={`roof-${roofInstances.length}`} ref={roofRef} args={[undefined, undefined, Math.max(1, roofInstances.length)]} frustumCulled={false} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.95} metalness={0} />
      </instancedMesh>

      {/* 可拖拽的道路节点手柄 */}
      {showNodes && (
        <instancedMesh key={`nodes-${nodeInstances.length}-${selectedNodeId}-${theme}`} ref={nodeRef}
          args={[undefined, undefined, Math.max(1, nodeInstances.length)]} frustumCulled={false}
          onPointerDown={(e) => {
            e.stopPropagation();
            const n = nodes[e.instanceId ?? -1];
            if (n) { onSelectNode(n.id); setDragId(n.id); }
          }}>
          <sphereGeometry args={[1, 10, 8]} />
          <meshBasicMaterial color="#ffffff" depthTest={false} />
        </instancedMesh>
      )}
      {showNodes && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]}
          onPointerMove={(e) => {
            if (!dragId) return;
            const n = nodes.find((x) => x.id === dragId);
            if (!n) return;
            // 拖拽预览：直接改写实例矩阵，pointerup 时才提交命令，避免产生大量历史步骤
            const idx = nodes.indexOf(n);
            const mesh = nodeRef.current;
            if (mesh) {
              mesh.setMatrixAt(idx, matrixOf(e.point.x, 1.6, e.point.z, 2.8, 2.8, 2.8));
              mesh.instanceMatrix.needsUpdate = true;
            }
          }}
          onPointerUp={(e) => {
            if (!dragId) return;
            onNodeDragEnd(dragId, Math.round(e.point.x * 10) / 10, Math.round(e.point.z * 10) / 10);
            setDragId(null);
          }}>
          <planeGeometry args={[width + 40, depth + 40]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {selected && selected.visible && !selected.deleted && (
        <mesh position={[selected.x, selected.h / 2, selected.z]} rotation={[0, -selected.orientation, 0]}
          scale={[selected.w + 1.4, selected.h + 1.4, selected.d + 1.4]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color={T.selectLine} wireframe transparent opacity={0.95} depthTest={false} />
        </mesh>
      )}
    </>
  );
}
