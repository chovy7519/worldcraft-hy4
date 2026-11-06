/**
 * 应用状态：文档历史（undo/redo）、命令日志、选择、持久化。
 * 生成结果不在 store 中缓存，由 App 用 useMemo(generateScene(doc)) 派生，
 * 避免「规则已改但几何未刷新」这一类的状态不一致。
 */
import { create } from 'zustand';
import { applyCommands, describeCommand } from './commands';
import { diffDocuments } from './diff';
import { DEFAULT_LLM_CONFIG, loadLlmConfig, saveLlmConfig, type LlmConfig } from './llm';
import { generateScene } from './pcg';
import {
  cloneDoc, createDefaultDocument, parseSceneJSON,
  serializeScene, STORAGE_KEY,
} from './schema';
import {
  type Command, type CommandLogEntry, type CommandSource, type ObjectOverride,
  type RuleChange, type SceneDocument, type ZoneId,
} from './types';

const HISTORY_LIMIT = 60;
let logCounter = 0;

function nextLogId(): string { return `log-${Date.now().toString(36)}-${++logCounter}`; }
function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export type CameraPreset = 'iso' | 'top' | 'front' | 'ne35';
export type ViewMode = 'material' | 'zone' | 'parcel';

export interface ExecuteMeta {
  input: string;
  source: CommandSource;
  note?: string;
}

export interface ExecuteOutcome { ok: boolean; message: string; changes: RuleChange[] }

export interface ChangeHistoryEntry {
  key: string;
  time: string;
  source: CommandSource;
  changes: RuleChange[];
  note: string;
}

interface AppState {
  doc: SceneDocument;
  past: SceneDocument[];
  future: SceneDocument[];
  selectedId: string | null;
  commandLog: CommandLogEntry[];
  lastChanges: RuleChange[];
  changeHistory: ChangeHistoryEntry[];
  statusMessage: string;
  cameraPreset: CameraPreset;
  cameraNonce: number;
  viewMode: ViewMode;
  hiddenZones: ZoneId[];
  llmConfig: LlmConfig;
  rulesPanelOpen: boolean;

  execute: (commands: Command[], meta: ExecuteMeta) => ExecuteOutcome;
  setField: (path: string, value: number | string | boolean) => void;
  setSeed: (seed: number) => void;
  randomizeSeed: () => void;
  overrideObject: (id: string, patch: ObjectOverride) => void;
  deleteSelected: () => void;
  restoreObject: (id: string) => void;
  select: (id: string | null) => void;
  setCamera: (preset: CameraPreset) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleZone: (zone: ZoneId) => void;
  setLlmConfig: (config: LlmConfig) => void;
  setRulesPanelOpen: (open: boolean) => void;
  setStatus: (message: string) => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  load: () => void;
  importJSON: (text: string) => void;
  exportJSON: () => void;
  reset: () => void;
}

function initialDoc(): SceneDocument {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parseSceneJSON(raw);
      if (parsed.ok && parsed.doc) return parsed.doc;
    }
  } catch { /* localStorage 不可用时退回默认场景 */ }
  return createDefaultDocument();
}

function pushLog(
  log: CommandLogEntry[],
  entry: Omit<CommandLogEntry, 'id' | 'time'>,
): CommandLogEntry[] {
  return [{ id: nextLogId(), time: nowTime(), ...entry }, ...log].slice(0, 80);
}

/** 系统类操作（撤销/重做/加载/导入/重置）也产生可追溯的规则 diff */
function withSystemDiff(
  history: ChangeHistoryEntry[],
  before: SceneDocument,
  after: SceneDocument,
  note: string,
): ChangeHistoryEntry[] {
  const changes = diffDocuments(before, after, 'system', note);
  if (changes.length === 0) return history;
  const entry: ChangeHistoryEntry = { key: nextLogId(), time: nowTime(), source: 'system', changes, note };
  return [entry, ...history].slice(0, 30);
}

export const useAppStore = create<AppState>((set, get) => ({
  doc: initialDoc(),
  past: [],
  future: [],
  selectedId: null,
  commandLog: [],
  lastChanges: [],
  changeHistory: [],
  statusMessage: '就绪 · 未配置 AI 时使用本地规则解析器，功能完整',
  cameraPreset: 'iso',
  cameraNonce: 0,
  viewMode: 'material',
  hiddenZones: [],
  llmConfig: (() => { try { return loadLlmConfig(); } catch { return { ...DEFAULT_LLM_CONFIG }; } })(),
  rulesPanelOpen: true,

  execute: (commands, meta) => {
    const state = get();
    const before = generateScene(state.doc).fingerprint;
    const result = applyCommands(state.doc, commands, meta.source);
    if (result.errors.length > 0) {
      const message = `执行中断：${result.errors.join('；')}`;
      set({
        statusMessage: message,
        commandLog: pushLog(state.commandLog, {
          input: meta.input, source: meta.source, commands, changes: [],
          fingerprintBefore: before, fingerprintAfter: before,
          ok: false, message,
        }),
      });
      return { ok: false, message, changes: [] };
    }
    const docOnly = result.changes.length === 0 && !result.cameraPreset;
    const after = generateScene(result.doc).fingerprint;
    const changed = before !== after;
    const message = changed
      ? `已应用 ${commands.length} 条命令 · ${result.changes.length} 处规则变化 · 指纹 ${before} → ${after}`
      : `已应用 ${commands.length} 条命令（未改变几何）`;

    set({
      doc: result.doc,
      past: docOnly ? state.past : [...state.past, cloneDoc(state.doc)].slice(-HISTORY_LIMIT),
      future: docOnly ? state.future : [],
      lastChanges: result.changes,
      changeHistory: result.changes.length > 0
        ? [{ key: nextLogId(), time: nowTime(), source: meta.source, changes: result.changes, note: meta.input }, ...state.changeHistory].slice(0, 30)
        : state.changeHistory,
      statusMessage: message,
      commandLog: pushLog(state.commandLog, {
        input: meta.input, source: meta.source, commands, changes: result.changes,
        fingerprintBefore: before, fingerprintAfter: after, ok: true,
        message: `${commands.map(describeCommand).join('；')}${meta.note ? ` · ${meta.note}` : ''}`,
      }),
      ...(result.cameraPreset ? { cameraPreset: result.cameraPreset, cameraNonce: state.cameraNonce + 1 } : {}),
    });
    return { ok: true, message, changes: result.changes };
  },

  setField: (path, value) => {
    get().execute([{ op: 'rule.set', path, value }], {
      input: `参数面板：${path} = ${String(value)}`, source: 'inspector',
    });
  },

  setSeed: (seed) => {
    get().execute([{ op: 'seed.set', value: seed }], {
      input: `参数面板：种子 = ${seed}`, source: 'inspector',
    });
  },

  randomizeSeed: () => {
    const seed = Math.floor(Math.random() * 9_000_000) + 1_000_000;
    get().setSeed(seed);
  },

  overrideObject: (id, patch) => {
    get().execute([{ op: 'object.override', id, patch }], {
      input: `单体编辑：${id}`, source: 'inspector',
    });
  },

  deleteSelected: () => {
    const { selectedId } = get();
    if (!selectedId) { get().setStatus('未选中对象'); return; }
    get().execute([{ op: 'object.delete', id: selectedId }], {
      input: `删除对象 ${selectedId}`, source: 'inspector',
    });
  },

  restoreObject: (id) => {
    get().execute([{ op: 'object.restore', id }], {
      input: `恢复对象 ${id}`, source: 'inspector',
    });
  },

  select: (id) => set({ selectedId: id }),
  setCamera: (preset) => set((s) => ({ cameraPreset: preset, cameraNonce: s.cameraNonce + 1 })),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleZone: (zone) => set((s) => ({
    hiddenZones: s.hiddenZones.includes(zone)
      ? s.hiddenZones.filter((z) => z !== zone)
      : [...s.hiddenZones, zone],
  })),
  setLlmConfig: (config) => { try { saveLlmConfig(config); } catch { /* ignore */ } set({ llmConfig: config }); },
  setRulesPanelOpen: (open) => set({ rulesPanelOpen: open }),
  setStatus: (message) => set({ statusMessage: message }),

  undo: () => {
    const s = get();
    if (s.past.length === 0) { s.setStatus('没有可撤销的操作'); return; }
    const prev = s.past[s.past.length - 1];
    const before = generateScene(s.doc).fingerprint;
    const after = generateScene(prev).fingerprint;
    set({
      doc: prev,
      past: s.past.slice(0, -1),
      future: [cloneDoc(s.doc), ...s.future].slice(0, HISTORY_LIMIT),
      lastChanges: diffDocuments(s.doc, prev, 'system', '撤销'),
      changeHistory: withSystemDiff(s.changeHistory, s.doc, prev, '撤销'),
      statusMessage: `已撤销 · 指纹 ${before} → ${after}`,
      commandLog: pushLog(s.commandLog, {
        input: '撤销', source: 'system', commands: [], changes: [],
        fingerprintBefore: before, fingerprintAfter: after, ok: true, message: '回退到上一份 SceneDocument',
      }),
    });
  },

  redo: () => {
    const s = get();
    if (s.future.length === 0) { s.setStatus('没有可重做的操作'); return; }
    const next = s.future[0];
    const before = generateScene(s.doc).fingerprint;
    const after = generateScene(next).fingerprint;
    set({
      doc: next,
      past: [...s.past, cloneDoc(s.doc)].slice(-HISTORY_LIMIT),
      future: s.future.slice(1),
      lastChanges: diffDocuments(s.doc, next, 'system', '重做'),
      changeHistory: withSystemDiff(s.changeHistory, s.doc, next, '重做'),
      statusMessage: `已重做 · 指纹 ${before} → ${after}`,
      commandLog: pushLog(s.commandLog, {
        input: '重做', source: 'system', commands: [], changes: [],
        fingerprintBefore: before, fingerprintAfter: after, ok: true, message: '前进到下一份 SceneDocument',
      }),
    });
  },

  save: () => {
    const s = get();
    const doc = { ...s.doc, updatedAt: new Date().toISOString() };
    try {
      const fp = generateScene(doc).fingerprint;
      // 存档附带指纹，加载时用于一致性校验（parseSceneDocument 会忽略该扩展字段）
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...doc, savedFingerprint: fp }, null, 2));
      set({
        statusMessage: `已保存到浏览器本地存储 · 指纹 ${fp}`,
        commandLog: pushLog(s.commandLog, {
          input: '保存场景', source: 'system', commands: [],
          changes: [], fingerprintBefore: fp, fingerprintAfter: fp, ok: true,
          message: `SceneDocument v${doc.schemaVersion} · rev.${doc.revision} · ${Object.keys(doc.overrides).length} 处人工覆写`,
        }),
      });
    } catch (e) {
      set({ statusMessage: `保存失败：${(e as Error).message}` });
    }
  },

  load: () => {
    const s = get();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { s.setStatus('本地没有存档，请先保存'); return; }
      const parsed = parseSceneJSON(raw);
      if (!parsed.ok || !parsed.doc) { s.setStatus(`加载失败：${parsed.error}`); return; }
      const restored = parsed.doc;
      const fp = generateScene(restored).fingerprint;
      const expected = (() => {
        try {
          const saved = JSON.parse(raw) as { savedFingerprint?: string };
          return saved.savedFingerprint;
        } catch { return undefined; }
      })();
      set({
        doc: restored,
        past: [...s.past, cloneDoc(s.doc)].slice(-HISTORY_LIMIT),
        future: [],
        selectedId: null,
        lastChanges: diffDocuments(s.doc, restored, 'system', '加载存档'),
        changeHistory: withSystemDiff(s.changeHistory, s.doc, restored, '加载存档'),
        statusMessage: `已加载存档 · 重新生成指纹 ${fp}${expected && expected !== fp ? '（与存档记录不一致，请检查）' : ' · 一致性校验通过'}`,
        commandLog: pushLog(s.commandLog, {
          input: '加载场景', source: 'system', commands: [], changes: [],
          fingerprintBefore: generateScene(s.doc).fingerprint, fingerprintAfter: fp, ok: true,
          message: `从 SceneDocument 重新推导几何，指纹 ${fp}`,
        }),
      });
    } catch (e) {
      set({ statusMessage: `加载失败：${(e as Error).message}` });
    }
  },

  importJSON: (text) => {
    const s = get();
    const parsed = parseSceneJSON(text);
    if (!parsed.ok || !parsed.doc) { s.setStatus(`导入失败：${parsed.error}`); return; }
    const doc = parsed.doc;
    const fp = generateScene(doc).fingerprint;
    set({
      doc,
      past: [...s.past, cloneDoc(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      selectedId: null,
      lastChanges: diffDocuments(s.doc, doc, 'system', '导入 JSON'),
      changeHistory: withSystemDiff(s.changeHistory, s.doc, doc, '导入 JSON'),
      statusMessage: `已导入场景 · 指纹 ${fp}`,
      commandLog: pushLog(s.commandLog, {
        input: '导入 JSON', source: 'structured', commands: [], changes: [],
        fingerprintBefore: generateScene(s.doc).fingerprint, fingerprintAfter: fp, ok: true,
        message: `通过 schema 校验，版本 ${doc.schemaVersion}`,
      }),
    });
  },

  exportJSON: () => {
    const s = get();
    const doc = { ...s.doc, updatedAt: new Date().toISOString() };
    const blob = new Blob([serializeScene(doc)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldcraft-${doc.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}-${doc.seed}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    s.setStatus('已导出 SceneDocument JSON（仅规则与种子，不含几何缓存）');
  },

  reset: () => {
    const s = get();
    const doc = createDefaultDocument(s.doc.seed);
    const fp = generateScene(doc).fingerprint;
    set({
      doc,
      past: [...s.past, cloneDoc(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      selectedId: null,
      lastChanges: diffDocuments(s.doc, doc, 'system', '重置场景'),
      changeHistory: withSystemDiff(s.changeHistory, s.doc, doc, '重置场景'),
      statusMessage: `已重置为默认场景 · 指纹 ${fp}`,
      commandLog: pushLog(s.commandLog, {
        input: '重置场景', source: 'system', commands: [], changes: [],
        fingerprintBefore: generateScene(s.doc).fingerprint, fingerprintAfter: fp, ok: true,
        message: '规则恢复默认，人工覆写清空',
      }),
    });
  },
}));
