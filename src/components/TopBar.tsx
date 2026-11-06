import { useRef } from 'react';
import type { GeneratedScene, SceneDocument } from '../core/types';

interface TopBarProps {
  doc: SceneDocument;
  scene: GeneratedScene;
  statusMessage: string;
  canUndo: boolean;
  canRedo: boolean;
  llmEnabled: boolean;
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
  const { doc, scene, statusMessage, canUndo, canRedo, llmEnabled } = props;

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
        <button className="btn sm" onClick={props.reset}>重置</button>
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
