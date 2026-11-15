import { useRef } from 'react';
import type { SceneTheme, SheetTheme } from './CityScene';
import type { GeneratedScene, SceneDocument } from '../core/types';

interface TopBarProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  statusMessage: string;
  canUndo: boolean;
  canRedo: boolean;
  llmEnabled: boolean;
  showMobility: boolean;
  mobilityPaused: boolean;
  toggleMobility: () => void;
  toggleMobilityPause: () => void;
  theme: SheetTheme;
  toggleTheme: () => void;
  sceneTheme: SceneTheme;
  toggleSceneTheme: () => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  load: () => void;
  exportJSON: () => void;
  importJSON: (text: string) => void;
  reset: () => void;
}

export function TopBar(props: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { doc, scene, statusMessage, canUndo, canRedo, llmEnabled, theme, sceneTheme, showMobility, mobilityPaused } = props;

  return (
    <header className="topbar">
      <div className="brand">
        <strong>WorldCraft</strong><span className="v">V0.1</span>
        <span className="sub">自然语言驱动的程序化三维世界生成器</span>
      </div>
      <span className="divider" />
      <span className="tag accent">{doc.name}</span>
      <span className="tag">seed {doc.seed}</span>
      <span className="tag">{doc.rules.terrain.width} × {doc.rules.terrain.depth} m</span>
      <span className="divider" />

      <div className="tool-group">
        <button className="btn sm" disabled={!canUndo} title="Ctrl+Z" onClick={props.undo}>↶ 撤销</button>
        <button className="btn sm" disabled={!canRedo} title="Ctrl+Y" onClick={props.redo}>↷ 重做</button>
      </div>
      <div className="tool-group">
        <button className="btn sm" title="Ctrl+S" onClick={props.save}>保存</button>
        <button className="btn sm" onClick={props.load}>加载</button>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>导入</button>
        <button className="btn sm" onClick={props.exportJSON}>导出 JSON</button>
        <button className="btn sm" title="回到默认 800 × 800 m 预设场景（保留当前 seed）" onClick={props.reset}>重置</button>
      </div>
      <div className="tool-group">
        <button className={`btn sm ${showMobility ? 'primary' : ''}`} title="显示 / 隐藏人流与车流" onClick={props.toggleMobility}>
          {showMobility ? '● 流动' : '○ 流动'}
        </button>
        <button className="btn sm" disabled={!showMobility} title="暂停 / 继续流动" onClick={props.toggleMobilityPause}>
          {mobilityPaused ? '▶ 继续' : '❚❚ 暂停'}
        </button>
      </div>
      <div className="tool-group">
        <button
          className={`btn sm ${sceneTheme === 'everyday' ? 'primary' : ''}`}
          title="切换三维场景美术主题：日常三渲二 / 深色制图。与编辑器 UI 主题彼此独立，不改变场景数据"
          onClick={props.toggleSceneTheme}
        >{sceneTheme === 'everyday' ? '☀ 日常场景' : '▤ 制图场景'}</button>
        <button
          className="btn sm"
          title="切换编辑器 UI 制图主题：浅色图纸 / 深色海图（不影响三维视口）"
          onClick={props.toggleTheme}
        >{theme === 'sheet' ? '◐ UI 海图' : '◑ UI 图纸'}</button>
      </div>
      <input
        ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) props.importJSON(await file.text());
          e.target.value = '';
        }}
      />

      <div className="status-strip"><span title={statusMessage}>{statusMessage}</span></div>
      <span className={`tag ${llmEnabled ? 'green' : ''}`}>{llmEnabled ? 'AI 接口已启用' : '离线可用'}</span>
      <span className="tag amber">{scene.fingerprint}</span>
    </header>
  );
}
