import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Hierarchy } from './components/Hierarchy';
import { Viewport } from './components/Viewport';
import { Inspector, type TabId } from './components/Inspector';
import { CommandPanel } from './components/CommandPanel';
import type { SceneTheme, SheetTheme } from './components/CityScene';
import { generateScene } from './core/pcg';
import { useAppStore } from './core/store';
import type { UiAction } from './core/nlp';
import type { ZoneId } from './core/types';

const THEME_KEY = 'worldcraft.theme';
const SCENE_THEME_KEY = 'worldcraft.sceneTheme';

/** UI 制图主题只影响编辑器面板配色，存 localStorage，不写入 SceneDocument */
function initialTheme(): SheetTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'nautical' ? 'nautical' : 'sheet';
  } catch {
    return 'sheet';
  }
}

/**
 * 三维场景美术主题与 UI 主题完全独立：只控制视口色板 / 光照 / toon 材质 /
 * 描边 / 构件层，不触碰 doc、几何与指纹。默认 everyday（二次元日常街区）。
 */
function initialSceneTheme(): SceneTheme {
  try {
    return localStorage.getItem(SCENE_THEME_KEY) === 'draft' ? 'draft' : 'everyday';
  } catch {
    return 'everyday';
  }
}

export default function App() {
  const store = useAppStore();
  const [hiddenGroups, setHiddenGroups] = useState<string[]>([]);
  const [inspectorTab, setInspectorTab] = useState<TabId>('rules');
  const [showNodes, setShowNodes] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showMobility, setShowMobility] = useState(true);
  const [mobilityPaused, setMobilityPaused] = useState(false);
  const [theme, setTheme] = useState<SheetTheme>(initialTheme);
  const [sceneTheme, setSceneTheme] = useState<SceneTheme>(initialSceneTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 隐私模式禁用存储时，主题仍在本会话内生效
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(SCENE_THEME_KEY, sceneTheme);
    } catch {
      // 同上：存储不可用时仍在本会话内生效
    }
  }, [sceneTheme]);

  // 生成结果永远是 doc 的纯函数派生，不缓存、不落盘
  const scene = useMemo(() => generateScene(store.doc), [store.doc]);

  // 静态关系违规主动提示：命令执行后立即把首条建议推到顶栏状态条，
  // 而不是让用户自己去 HUD 里找。
  useEffect(() => {
    if (scene.spatial.ok) return;
    const first = scene.spatial.issues[0];
    if (!first) return;
    useAppStore.getState().setStatus(
      first.advice
        ? `关系冲突 ${scene.spatial.issues.length} 条：${first.detail} → ${first.advice}`
        : `空间校验 ${scene.spatial.issues.length} 冲突：${first.detail}`,
    );
  }, [scene]);

  const toggleGroup = useCallback((g: string) => {
    setHiddenGroups((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]);
  }, []);

  const setTab = useCallback((t: TabId) => setInspectorTab(t), []);
  const toggleTheme = useCallback(() => setTheme((t) => t === 'sheet' ? 'nautical' : 'sheet'), []);
  const toggleSceneTheme = useCallback(
    () => setSceneTheme((t) => t === 'everyday' ? 'draft' : 'everyday'),
    [],
  );

  const onUiAction = useCallback((a: UiAction) => {
    switch (a) {
      case 'undo': useAppStore.getState().undo(); break;
      case 'redo': useAppStore.getState().redo(); break;
      case 'save': useAppStore.getState().save(); break;
      case 'load': useAppStore.getState().load(); break;
      case 'export': useAppStore.getState().exportJSON(); break;
      case 'deleteSelected': useAppStore.getState().deleteSelected(); break;
      case 'showRules': setInspectorTab('changes'); break;
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); onUiAction('undo'); }
      else if ((e.key.toLowerCase() === 'y') || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); onUiAction('redo'); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); onUiAction('save'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUiAction]);

  return (
    <div className="app">
      <TopBar
        doc={store.doc} scene={scene} statusMessage={store.statusMessage}
        canUndo={store.past.length > 0} canRedo={store.future.length > 0}
        llmEnabled={store.llmConfig.enabled && (store.llmConfig.mode === 'proxy'
          ? Boolean(store.llmConfig.proxyUrl) : Boolean(store.llmConfig.apiKey))}
        showMobility={showMobility} mobilityPaused={mobilityPaused}
        toggleMobility={() => setShowMobility((v) => !v)}
        toggleMobilityPause={() => setMobilityPaused((v) => !v)}
        theme={theme} toggleTheme={toggleTheme}
        sceneTheme={sceneTheme} toggleSceneTheme={toggleSceneTheme}
        undo={store.undo} redo={store.redo} save={store.save} load={store.load}
        exportJSON={store.exportJSON} importJSON={store.importJSON} reset={store.reset}
      />

      <Hierarchy
        doc={store.doc} scene={scene}
        selectedId={store.selectedId} onSelect={store.select}
        hiddenZones={store.hiddenZones as ZoneId[]} toggleZone={store.toggleZone}
        hiddenGroups={hiddenGroups} toggleGroup={toggleGroup}
      />

      <Viewport
        doc={store.doc} scene={scene} sceneTheme={sceneTheme}
        selectedId={store.selectedId} onSelect={store.select}
        cameraPreset={store.cameraPreset} cameraNonce={store.cameraNonce} setCamera={store.setCamera}
        viewMode={store.viewMode} setViewMode={store.setViewMode}
        hiddenZones={store.hiddenZones} hiddenGroups={hiddenGroups}
        showNodes={showNodes} setShowNodes={setShowNodes}
        showMobility={showMobility} mobilityPaused={mobilityPaused}
        selectedNodeId={selectedNodeId}
        onSelectNode={(id) => { setSelectedNodeId(id); if (id) setInspectorTab('graph'); }}
        onNodeDragEnd={(id, x, z) => {
          useAppStore.getState().execute(
            [{ op: 'graph.node.move', id, x, z }],
            { input: `拖拽道路节点 ${id} → (${x}, ${z})`, source: 'inspector' },
          );
        }}
      />

      <Inspector
        doc={store.doc} scene={scene} selectedId={store.selectedId}
        lastChanges={store.lastChanges} changeHistory={store.changeHistory}
        setField={store.setField} setSeed={store.setSeed} randomizeSeed={store.randomizeSeed}
        overrideObject={store.overrideObject} restoreObject={store.restoreObject}
        deleteSelected={store.deleteSelected}
        tab={inspectorTab} onTabChange={setTab}
      />

      <CommandPanel
        doc={store.doc} llmConfig={store.llmConfig} setLlmConfig={store.setLlmConfig}
        commandLog={store.commandLog} execute={store.execute}
        onUiAction={onUiAction} setStatus={store.setStatus}
      />
    </div>
  );
}
