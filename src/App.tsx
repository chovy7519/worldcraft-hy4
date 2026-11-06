import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Hierarchy } from './components/Hierarchy';
import { Viewport } from './components/Viewport';
import { Inspector, type TabId } from './components/Inspector';
import { CommandPanel } from './components/CommandPanel';
import { generateScene } from './core/pcg';
import { useAppStore } from './core/store';
import type { UiAction } from './core/nlp';
import type { ZoneId } from './core/types';

export default function App() {
  const store = useAppStore();
  const [hiddenGroups, setHiddenGroups] = useState<string[]>([]);
  const [inspectorTab, setInspectorTab] = useState<TabId>('rules');
  const [showNodes, setShowNodes] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 生成结果永远是 doc 的纯函数派生，不缓存、不落盘
  const scene = useMemo(() => generateScene(store.doc), [store.doc]);

  const toggleGroup = useCallback((g: string) => {
    setHiddenGroups((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]);
  }, []);

  const setTab = useCallback((t: TabId) => setInspectorTab(t), []);

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
        llmEnabled={store.llmConfig.enabled && Boolean(store.llmConfig.apiKey)}
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
        doc={store.doc} scene={scene}
        selectedId={store.selectedId} onSelect={store.select}
        cameraPreset={store.cameraPreset} cameraNonce={store.cameraNonce} setCamera={store.setCamera}
        viewMode={store.viewMode} setViewMode={store.setViewMode}
        hiddenZones={store.hiddenZones} hiddenGroups={hiddenGroups}
        showNodes={showNodes} setShowNodes={setShowNodes}
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
