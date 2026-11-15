/**
 * 三维场景渲染层。
 *
 * v1.3.0 主题解耦：
 *   - UI 制图主题（SheetTheme）只由 App 写入 document.documentElement.dataset.theme，
 *     不再参与三维视口配色；本组件不再接收它。
 *   - 场景美术主题（SceneTheme）独立控制视口色板 / 光照 / toon 材质 / 描边 / 构件层，
 *     切换不写 SceneDocument、不改变几何、不影响指纹。
 *
 * 其余能力保持不变：任意走向道路、旋转建筑足迹、凹多边形公园、可拖拽节点、
 * 确定性人流车流、E1 水面与岸线双线。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  BUILT_USE_IDS, LAND_USE_COLORS, ZONE_COLORS,
  type BuildingObject, type BuiltUseId, type GeneratedScene, type ParkObject, type SceneDocument,
} from '../core/types';
import { positionOnPath, type FlowAgent } from '../core/mobility';
import { assembleFacadeKit, EVERYDAY_ROOF_COLORS, EVERYDAY_USE_COLORS, KIT_PALETTE } from '../core/facadeKit';
import type { ViewMode } from '../core/store';

/** 编辑器 UI 的制图主题（由 App / TopBar 使用，不影响三维场景） */
export type SheetTheme = 'sheet' | 'nautical';
/** 三维场景的美术主题（与 UI 主题完全独立） */
export type SceneTheme = 'draft' | 'everyday';

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
  sceneTheme: SceneTheme;
  showMobility: boolean;
  mobilityPaused: boolean;
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
const draftTmp = new THREE.Color();
interface Instance { matrix: THREE.Matrix4; color: THREE.Color }

interface ThemePalette {
  bg: string; fog: string; ground: string; plinth: string;
  grid1: string; grid2: string;
  roadMain: string; roadMinor: string;
  parkStyles: Record<string, string>;
  water: string; trunk: string;
  canopy: string[]; canopyStreet: string[];
  node: string; nodeSelected: string;
  parcelLine: string; selectLine: string;
  hemiSky: string; hemiGround: string;
  emissive: string; outline: string;
}

/**
 * 场景主题色板。draft = 已验收的深色制图视口；everyday = ART_DIRECTION §2.2 日常色板。
 * 两张表字段完全同构，切换只换呈现，不改任何生成参数。
 */
const SCENE_PALETTES: Record<SceneTheme, ThemePalette> = {
  draft: {
    bg: '#0a121a', fog: '#0a121a', ground: '#14212b', plinth: '#0d1620',
    grid1: '#2b4657', grid2: '#1b2c37',
    roadMain: '#34495a', roadMinor: '#25333f',
    parkStyles: { park: '#2b7350', plaza: '#7a858f', water: '#1f6a8c' },
    water: '#2b7fa8', trunk: '#4b3d30',
    canopy: ['#3a9163', '#4baa76', '#2f875e', '#5cb683'],
    canopyStreet: ['#4f9e6f', '#57a97a', '#438c62', '#63b184'],
    node: '#ef9a4a', nodeSelected: '#ffdf7a',
    parcelLine: '#8fd3ff', selectLine: '#ffc65a',
    hemiSky: '#bcd9f5', hemiGround: '#14202a',
    emissive: '#0d2b3d', outline: '#4A4640',
  },
  everyday: {
    bg: '#E8F1F4', fog: '#DCEBF0', ground: '#EDE7DA', plinth: '#D9D4C8',
    grid1: '#CFCABD', grid2: '#DEDACF',
    roadMain: '#CFC9BC', roadMinor: '#D9D4C8',
    parkStyles: { park: '#D5E4C4', plaza: '#E4DDCC', water: '#A8CFD6' },
    water: '#A8CFD6', trunk: '#B98A5E',
    canopy: ['#A8CC8C', '#7FA86B', '#5C8354', '#8FBA78'],
    canopyStreet: ['#A8CC8C', '#7FA86B', '#5C8354', '#94C083'],
    node: '#4E7E96', nodeSelected: '#D9705B',
    parcelLine: '#7A756C', selectLine: '#D9705B',
    hemiSky: '#BBD8EE', hemiGround: '#EDE7DA',
    emissive: '#000000', outline: KIT_PALETTE.outline,
  },
};

const useKind = (landUse: string): BuiltUseId =>
  (BUILT_USE_IDS as string[]).includes(landUse) ? landUse as BuiltUseId : 'office';

/** everyday 下把数据层材质色重映射为功能色：只改呈现，不改 doc */
function buildingColor(b: BuildingObject, theme: SceneTheme): string {
  if (theme === 'draft') {
    draftTmp.set(b.color);
    return `#${draftTmp.getHexString()}`;
  }
  const base = EVERYDAY_USE_COLORS[useKind(b.landUse)];
  // 同功能内只允许极小明度变化，保持色相与饱和度统一
  const lift = ((b.hash >>> 0) % 7) * 0.012;
  const c = new THREE.Color(base).lerp(new THREE.Color('#FFFFFF'), lift);
  return `#${c.getHexString()}`;
}

function roofColor(b: BuildingObject, theme: SceneTheme): string {
  if (theme === 'draft') {
    return `#${draftTmp.set(b.color).multiplyScalar(1.4).getHexString()}`;
  }
  return EVERYDAY_ROOF_COLORS[useKind(b.landUse)];
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
function parkGeometry(parks: ParkObject[], theme: SceneTheme): THREE.BufferGeometry {
  const positions: number[] = []; const colors: number[] = [];
  const styles = SCENE_PALETTES[theme].parkStyles;
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

/** E1 水面多边形（含岸线退界后的凹形），一次 draw call */
function waterPolygonGeometry(surfaces: GeneratedScene['water'], theme: SceneTheme): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const col = tmpColor.clone().set(SCENE_PALETTES[theme].water);
  for (const w of surfaces) {
    const poly = w.polygon;
    if (!poly || poly.length < 3) continue;
    let pts = poly.map((q) => new THREE.Vector2(q.x, q.z));
    if (THREE.ShapeUtils.isClockWise(pts)) pts = pts.reverse();
    let faces: number[][];
    try { faces = THREE.ShapeUtils.triangulateShape(pts, []); } catch { continue; }
    for (const tri of faces) {
      for (const idx of tri) {
        positions.push(pts[idx].x, 0.18, pts[idx].y);
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

/** E1 原始岸线：与退界后的水面构成双线，直观表达岸线退界 */
function shorelineGeometry(surfaces: GeneratedScene['water']): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const w of surfaces) {
    const poly = w.shoreline && w.shoreline.length >= 3 ? w.shoreline : w.polygon;
    if (!poly || poly.length < 3 || (w.bankSetback ?? 0) <= 0) continue;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      pts.push(a.x, 0.24, a.z, b.x, 0.24, b.z);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
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

/** 三值 toon ramp：N·L 量化为暗 / 中 / 亮三阶，过渡带由 NearestFilter 保证是硬边 */
function makeToonRamp(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([92, 178, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function CityScene(props: CitySceneProps) {
  const {
    doc, scene, selectedId, onSelect, viewMode, hiddenZones, hiddenGroups,
    showNodes, selectedNodeId, onSelectNode, onNodeDragEnd, sceneTheme,
  } = props;
  const T = SCENE_PALETTES[sceneTheme];
  const isEveryday = sceneTheme === 'everyday';
  const { width, depth } = doc.rules.terrain;
  const span = Math.max(width, depth);
  const [dragId, setDragId] = useState<string | null>(null);

  // --- 三值 toon 材质：只在 everyday 启用，保留 instanceColor（three 自动注入） ---
  const toonRamp = useMemo(makeToonRamp, []);
  const materials = useMemo(() => {
    if (!isEveryday) {
      return {
        solid: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 }),
        building: new THREE.MeshStandardMaterial({
          color: '#ffffff', roughness: 0.95, metalness: 0,
          emissive: T.emissive, emissiveIntensity: doc.rules.material.emissive * 0.22,
        }),
        vertex: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, side: THREE.DoubleSide, roughness: 1, metalness: 0 }),
        water: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.9, roughness: 0.35 }),
        ground: new THREE.MeshStandardMaterial({ color: T.ground, roughness: 1, metalness: 0 }),
        // 实例色承载轮廓色，材质基色必须为白，否则颜色会被相乘两次
        outline: new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.BackSide }),
      };
    }
    return {
      solid: new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp }),
      building: new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp }),
      vertex: new THREE.MeshToonMaterial({ color: '#ffffff', vertexColors: true, side: THREE.DoubleSide, gradientMap: toonRamp }),
      water: new THREE.MeshToonMaterial({ color: '#ffffff', vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92, gradientMap: toonRamp }),
      ground: new THREE.MeshToonMaterial({ color: T.ground, gradientMap: toonRamp }),
      outline: new THREE.MeshBasicMaterial({ color: T.outline, side: THREE.BackSide }),
    };
  }, [isEveryday, T, toonRamp, doc.rules.material.emissive]);
  useEffect(() => () => {
    materials.solid.dispose(); materials.building.dispose(); materials.vertex.dispose();
    materials.water.dispose(); materials.ground.dispose(); materials.outline.dispose();
  }, [materials]);
  useEffect(() => () => toonRamp.dispose(), [toonRamp]);

  // --- 人流 / 车流：路径由 core/mobility 按空间关系契约生成，这里只推进时间 ---
  const mobility = scene.mobility;
  const carAgents = useMemo(() => mobility?.agents.filter((a) => a.kind === 'vehicle') ?? [], [mobility]);
  const pedAgents = useMemo(() => mobility?.agents.filter((a) => a.kind === 'pedestrian') ?? [], [mobility]);
  const pathById = useMemo(
    () => new Map((mobility?.paths ?? []).map((p) => [p.id, p])),
    [mobility],
  );
  const carRef = useRef<THREE.InstancedMesh>(null);
  const pedRef = useRef<THREE.InstancedMesh>(null);
  const flowTime = useRef(0);

  useFrame((_, delta) => {
    if (!props.mobilityPaused) flowTime.current += Math.min(delta, 0.08);
    const t = flowTime.current;
    const update = (
      ref: RefObject<THREE.InstancedMesh>, agents: FlowAgent[],
      y: number, sx: number, sy: number, sz: number,
    ) => {
      const mesh = ref.current;
      if (!mesh) return;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const path = pathById.get(a.pathId);
        if (!path) continue;
        const p = positionOnPath(path, a.phase + (t * a.speed) / Math.max(1, path.length), a.lateral);
        dummy.position.set(p.x, y, p.z);
        dummy.rotation.set(0, p.angle, 0);
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    update(carRef, carAgents, 0.72, 1.6, 1.1, 3.4);
    update(pedRef, pedAgents, 0.9, 0.7, 1.7, 0.7);
  });

  useLayoutEffect(() => {
    const carColors = ['#c96a52', '#d9a24c', '#4f86b8', '#7c8b96', '#b9b2a3'];
    const pedColors = ['#7a5ba8', '#3f8f8a', '#c47a55', '#5a7fa8', '#8a8f6a'];
    const paint = (ref: RefObject<THREE.InstancedMesh>, agents: FlowAgent[], colors: string[]) => {
      const mesh = ref.current;
      if (!mesh) return;
      for (let i = 0; i < agents.length; i++) {
        mesh.setColorAt(i, tmpColor.clone().set(colors[agents[i].tone % colors.length]));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    paint(carRef, carAgents, carColors);
    paint(pedRef, pedAgents, pedColors);
  }, [carAgents, pedAgents]);

  const visibleBuildings = useMemo(
    () => scene.buildings.filter((b) => b.visible && !b.deleted && !hiddenZones.includes(b.zone)),
    [scene.buildings, hiddenZones],
  );
  const buildingInstances = useMemo<Instance[]>(() => visibleBuildings.map((b) => ({
    matrix: matrixOf(b.x, b.h / 2, b.z, b.w, b.h, b.d, -b.orientation),
    color: tmpColor.clone().set(
      viewMode === 'zone' ? ZONE_COLORS[b.zone]
        : viewMode === 'parcel' ? LAND_USE_COLORS[b.landUse]
          : buildingColor(b, sceneTheme),
    ),
  })), [visibleBuildings, viewMode, sceneTheme]);

  /** 几何法描边：同矩阵放大一圈的背面实例，1 个额外 draw call，视角转动不抖 */
  const outlineInstances = useMemo<Instance[]>(() => isEveryday ? visibleBuildings.map((b) => ({
    matrix: matrixOf(b.x, b.h / 2, b.z, b.w + 0.38, b.h + 0.38, b.d + 0.38, -b.orientation),
    color: tmpColor.clone().set(T.outline),
  })) : [], [visibleBuildings, isEveryday, T]);

  const roofInstances = useMemo<Instance[]>(() => visibleBuildings.filter((b) => b.roof !== 'flat').map((b) => {
    const antenna = b.roof === 'antenna';
    return {
      matrix: matrixOf(b.x, b.h + (antenna ? 3.2 : 0.7), b.z,
        antenna ? 0.5 : b.w * 0.66, antenna ? 6.4 : 1.4, antenna ? 0.5 : b.d * 0.66, -b.orientation),
      color: tmpColor.clone().set(roofColor(b, sceneTheme)),
    };
  }), [visibleBuildings, sceneTheme]);

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

  // --- 共享构件库：纯函数装配，只在 everyday 显示，1 个 InstancedMesh ---
  const kit = useMemo(
    () => isEveryday ? assembleFacadeKit(scene, doc.seed) : null,
    [isEveryday, scene, doc.seed],
  );
  const kitInstances = useMemo<Instance[]>(() => (kit?.instances ?? []).map((k) => ({
    matrix: matrixOf(k.x, k.y, k.z, k.sx, k.sy, k.sz, k.rotY),
    color: tmpColor.clone().set(k.color),
  })), [kit]);

  const parkGeom = useMemo(
    () => !hiddenGroups.includes('parks') ? parkGeometry(scene.parks, sceneTheme) : null,
    [scene.parks, hiddenGroups, sceneTheme],
  );
  const outlineGeom = useMemo(
    () => viewMode === 'parcel' && !hiddenGroups.includes('parcels') ? parcelLineGeometry(scene) : null,
    [viewMode, scene, hiddenGroups],
  );
  const polygonWater = useMemo(() => scene.water.filter((w) => w.polygon && w.polygon.length >= 3), [scene.water]);
  const legacyWater = useMemo(() => scene.water.filter((w) => !w.polygon), [scene.water]);
  const waterInstances = useMemo<Instance[]>(() => legacyWater.map((w) => ({
    matrix: matrixOf((w.bounds.minX + w.bounds.maxX) / 2, 0.16, (w.bounds.minZ + w.bounds.maxZ) / 2,
      w.bounds.maxX - w.bounds.minX, 0.04, w.bounds.maxZ - w.bounds.minZ),
    color: tmpColor.clone().set(T.water),
  })), [legacyWater, T]);
  const waterGeom = useMemo(
    () => polygonWater.length ? waterPolygonGeometry(polygonWater, sceneTheme) : null,
    [polygonWater, sceneTheme],
  );
  const shoreGeom = useMemo(
    () => polygonWater.length ? shorelineGeometry(polygonWater) : null,
    [polygonWater],
  );

  const buildingRef = useRef<THREE.InstancedMesh>(null);
  const outlineRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const roadRef = useRef<THREE.InstancedMesh>(null);
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const canopyRef = useRef<THREE.InstancedMesh>(null);
  const nodeRef = useRef<THREE.InstancedMesh>(null);
  const waterRef = useRef<THREE.InstancedMesh>(null);
  const kitRef = useRef<THREE.InstancedMesh>(null);

  useInstances(buildingRef, buildingInstances);
  useInstances(outlineRef, outlineInstances);
  useInstances(roofRef, roofInstances);
  useInstances(roadRef, roadInstances);
  useInstances(trunkRef, trunks);
  useInstances(canopyRef, canopies);
  useInstances(nodeRef, nodeInstances);
  useInstances(waterRef, waterInstances);
  useInstances(kitRef, kitInstances);

  const selected = selectedId ? scene.buildings.find((b) => b.id === selectedId) : undefined;

  return (
    <>
      <color attach="background" args={[T.bg]} />
      <fog attach="fog" args={[T.fog, span * 1.25, span * 3.1]} />
      {isEveryday ? (
        <>
          {/* 固定晴日上午 10:00：单一主光 225° / 48°，无昼夜与天气切换 */}
          <ambientLight intensity={0.35} />
          <hemisphereLight args={[T.hemiSky, T.hemiGround, 0.45]} />
          <directionalLight position={[-span * 0.53, span * 0.83, span * 0.53]} intensity={1.0}
            color="#FFF4DC" castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
            shadow-camera-left={-span * 0.72} shadow-camera-right={span * 0.72}
            shadow-camera-top={span * 0.72} shadow-camera-bottom={-span * 0.72}
            shadow-camera-near={1} shadow-camera-far={span * 3} shadow-bias={-0.0008} />
        </>
      ) : (
        <>
          <ambientLight intensity={0.85} />
          <hemisphereLight args={[T.hemiSky, T.hemiGround, 0.6]} />
          <directionalLight position={[span * 0.55, span * 0.9, span * 0.32]} intensity={0.9}
            castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
            shadow-camera-left={-span * 0.72} shadow-camera-right={span * 0.72}
            shadow-camera-top={span * 0.72} shadow-camera-bottom={-span * 0.72}
            shadow-camera-near={1} shadow-camera-far={span * 3} shadow-bias={-0.0008} />
        </>
      )}

      <mesh position={[0, -0.7, 0]} receiveShadow material={materials.ground}>
        <boxGeometry args={[width + 10, 1.3, depth + 10]} />
      </mesh>
      {!hiddenGroups.includes('terrain') && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow material={materials.ground}>
          <planeGeometry args={[width, depth]} />
        </mesh>
      )}
      <gridHelper args={[span, Math.max(4, Math.round(span / 20)), T.grid1, T.grid2]} position={[0, 0.015, 0]} />

      {/* S1 任意走向的分级道路 */}
      <instancedMesh key={`roads-${roadInstances.length}-${sceneTheme}`} ref={roadRef}
        args={[undefined, undefined, Math.max(1, roadInstances.length)]} frustumCulled={false} receiveShadow
        material={materials.solid}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>

      {/* S4b 多边形公园（含凹形），一次 draw call */}
      {parkGeom && (
        <mesh geometry={parkGeom} receiveShadow frustumCulled={false} material={materials.vertex} />
      )}

      {/* E1 水系：退界后的水面多边形 + 原始岸线双线 */}
      {waterGeom && (
        <mesh geometry={waterGeom} receiveShadow frustumCulled={false} material={materials.water} />
      )}
      {shoreGeom && (
        <lineSegments geometry={shoreGeom} frustumCulled={false}>
          <lineBasicMaterial color={T.water} transparent opacity={0.6} depthTest={false} />
        </lineSegments>
      )}
      {legacyWater.length > 0 && (
        <instancedMesh key={`water-${waterInstances.length}-${sceneTheme}`} ref={waterRef}
          args={[undefined, undefined, Math.max(1, waterInstances.length)]} frustumCulled={false}
          material={materials.solid}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}

      {/* 流动：车辆沿车道回路、行人沿步道与公园环线，实例矩阵每帧更新 */}
      {props.showMobility && carAgents.length > 0 && (
        <instancedMesh key={`cars-${carAgents.length}-${sceneTheme}`} ref={carRef}
          args={[undefined, undefined, carAgents.length]} frustumCulled={false} castShadow material={materials.solid}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}
      {props.showMobility && pedAgents.length > 0 && (
        <instancedMesh key={`peds-${pedAgents.length}-${sceneTheme}`} ref={pedRef}
          args={[undefined, undefined, pedAgents.length]} frustumCulled={false} castShadow material={materials.solid}>
          <cylinderGeometry args={[0.5, 0.5, 1, 6]} />
        </instancedMesh>
      )}

      {/* S2 地块红线 */}
      {outlineGeom && (
        <lineSegments geometry={outlineGeom} frustumCulled={false}>
          <lineBasicMaterial color={T.parcelLine} transparent opacity={0.85} depthTest={false} />
        </lineSegments>
      )}

      {/* S5 乔木 */}
      <instancedMesh key={`trunks-${trunks.length}-${sceneTheme}`} ref={trunkRef}
        args={[undefined, undefined, Math.max(1, trunks.length)]} frustumCulled={false} castShadow material={materials.solid}>
        <cylinderGeometry args={[0.5, 0.6, 1, 6]} />
      </instancedMesh>
      <instancedMesh key={`canopy-${canopies.length}-${sceneTheme}`} ref={canopyRef}
        args={[undefined, undefined, Math.max(1, canopies.length)]} frustumCulled={false} castShadow material={materials.solid}>
        <coneGeometry args={[1, 1, 7]} />
      </instancedMesh>

      {/* S4a 旋转建筑足迹 */}
      {isEveryday && outlineInstances.length > 0 && (
        <instancedMesh key={`outline-${outlineInstances.length}-${sceneTheme}`} ref={outlineRef}
          args={[undefined, undefined, outlineInstances.length]} frustumCulled={false}
          material={materials.outline}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}
      <instancedMesh key={`bld-${buildingInstances.length}-${viewMode}-${sceneTheme}`} ref={buildingRef}
        args={[undefined, undefined, Math.max(1, buildingInstances.length)]} frustumCulled={false} castShadow receiveShadow
        material={materials.building}
        onClick={(e) => {
          e.stopPropagation();
          const b: BuildingObject | undefined = visibleBuildings[e.instanceId ?? -1];
          if (b) onSelect(b.id);
        }}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh key={`roof-${roofInstances.length}-${sceneTheme}`} ref={roofRef}
        args={[undefined, undefined, Math.max(1, roofInstances.length)]} frustumCulled={false} castShadow material={materials.solid}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>

      {/* 共享构件库：窗格 / 阳台 / 招牌 / 棚 / 外机 / 街具，按功能装配，1 个 draw call */}
      {isEveryday && kit && kitInstances.length > 0 && (
        <instancedMesh key={`kit-${kitInstances.length}-${sceneTheme}`} ref={kitRef}
          args={[undefined, undefined, kitInstances.length]} frustumCulled={false} castShadow
          material={materials.solid}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}

      {/* 可拖拽的道路节点手柄 */}
      {showNodes && (
        <instancedMesh key={`nodes-${nodeInstances.length}-${selectedNodeId}-${sceneTheme}`} ref={nodeRef}
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
