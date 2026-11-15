import { useEffect, useState } from 'react';
import { validateCommands } from '../core/commands';
import { parseNaturalLanguage, type ParseResult, type UiAction } from '../core/nlp';
import { parseWithLlm, type LlmConfig } from '../core/llm';
import type { Command, CommandLogEntry, CommandSource, SceneDocument } from '../core/types';
import type { ExecuteMeta, ExecuteOutcome } from '../core/store';

const ACCEPT_1 = '生成一座 400m × 400m 的未来城市，中央建筑较高，外围建筑较低，保留一片中央公共开放空间。';
const ACCEPT_2 = '将东侧建筑密度降低 30%，其他区域不变。';

const PRESETS: Array<{ label: string; text: string; hot?: boolean; json?: string }> = [
  { label: '① 验收：生成城市', text: ACCEPT_1, hot: true },
  { label: '② 验收：东侧密度 -30%', text: ACCEPT_2, hot: true },
  { label: '降低东侧建筑高度 30%', text: '降低东侧建筑高度 30%，其他区域不变。' },
  { label: '西侧密度设为 45%', text: '将西侧建筑密度设为 45%' },
  { label: '种子改为 12345', text: '种子改为 12345' },
  { label: '东北 35° 半鸟瞰', text: '切换到东北 35 度视角' },
  { label: '撤销 · 保存 · 加载', text: '撤销上一步，然后保存并加载' },
  { label: '查看规则变化', text: '查看规则变化' },
  {
    label: '管线：主干路加密', text: '设置主干路间隔为 2',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.roads.arterialPeriod', value: 2 }], null, 2),
  },
  {
    label: '管线：公园比例 20%', text: '把分散公园比例设为 20%',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.landUse.parkRatio', value: 0.2 }], null, 2),
  },
  {
    label: '管线：地块细分 3×3', text: '把单街区最大细分设为 3',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.parcels.maxSplit', value: 3 }], null, 2),
  },
  {
    label: '管线：行道树株距 6m', text: '把行道树株距设为 6 米',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.trees.streetInterval', value: 6 }], null, 2),
  },
  {
    label: '扩展：启用水系预留', text: '启用水系扩展点',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.extensions.water', value: true }], null, 2),
  },
  {
    label: '图形：加斜向路', text: '在两个网格节点之间新增一条斜向路段',
    json: JSON.stringify([{ op: 'graph.edge.add', from: 'gn.0', to: 'gn.10', cls: 'local' }], null, 2),
  },
  {
    label: '图形：移动节点改走向', text: '移动道路节点，制造斜向道路',
    json: JSON.stringify([{ op: 'graph.node.move', id: 'gn.9', x: -95, z: -108 }], null, 2),
  },
  {
    label: '图形：斜切地块', text: '用斜线拆分多个地块，产生多边形边界',
    json: JSON.stringify([{ op: 'parcel.split', a: { x: -195, z: -195 }, b: { x: -155, z: -155 } }], null, 2),
  },
  {
    label: '图形：合并相邻地块', text: '合并两点所在的共边地块',
    json: JSON.stringify([{ op: 'parcel.merge', a: { x: -187, z: -137 }, b: { x: -162, z: -137 } }], null, 2),
  },
  {
    label: '图形：重建路网', text: '按当前规则重建正交道路图',
    json: JSON.stringify([{ op: 'graph.regenerate' }], null, 2),
  },
  {
    label: '图形：造 L 形凹地块', text: '删除两条相邻路段，三个面合并为凹多边形地块',
    json: JSON.stringify([
      { op: 'graph.edge.remove', id: 'ge.57' },
      { op: 'graph.edge.remove', id: 'ge.1' },
    ], null, 2),
  },
  {
    label: '区域：西侧带密度 -50%', text: '沿 X 轴 -200 ~ -100 m 的带状区域降低密度 50%',
    json: JSON.stringify([{
      op: 'region.add',
      layer: {
        id: 'r.westband', name: '西侧带状区域',
        selector: { kind: 'band', axis: 'x', min: -200, max: -100 },
        density: 0.5, height: 1, enabled: true, priority: 10, blend: 'multiply',
      },
    }], null, 2),
  },
  {
    label: '区域：中心 80m 增高', text: '以场地中心 80 m 半径内建筑高度提高 30%',
    json: JSON.stringify([{
      op: 'region.add',
      layer: {
        id: 'r.core80', name: '中心 80m 圈',
        selector: { kind: 'radius', cx: 0, cz: 0, r: 80 },
        density: 1, height: 1.3, enabled: true, priority: 5, blend: 'multiply',
      },
    }], null, 2),
  },
  {
    label: '区域：清空叠加层', text: '清空全部区域叠加层',
    json: JSON.stringify([{ op: 'region.clear' }], null, 2),
  },
  {
    label: 'E1：水系 + 岸线退界 6m', text: '启用水系扩展点，把岸线退界设为 6 米',
    json: JSON.stringify([
      { op: 'rule.set', path: 'pipeline.extensions.water', value: true },
      { op: 'rule.set', path: 'pipeline.landUse.waterReserveRatio', value: 0.08 },
      { op: 'rule.set', path: 'pipeline.extensions.bankSetback', value: 6 },
    ], null, 2),
  },
  {
    label: 'E2：地形高程场', text: '启用地形扩展点并加大起伏幅度',
    json: JSON.stringify([
      { op: 'rule.set', path: 'pipeline.extensions.terrain', value: true },
      { op: 'rule.set', path: 'pipeline.extensions.terrainAmplitude', value: 5 },
    ], null, 2),
  },
  {
    label: '流动：车流加倍', text: '把车辆数量提高到 144',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.mobility.vehicles', value: 144 }], null, 2),
  },
  {
    label: '流动：步道加宽 3m', text: '加宽步道；建筑退界会按关系契约自动跟着变',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.mobility.sidewalkWidth', value: 3 }], null, 2),
  },
  {
    label: '流动：关闭', text: '关闭人流与车流',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.mobility.enabled', value: false }], null, 2),
  },
  {
    label: '关系：触发廊道违规', text: '把节点挪近，验证通行廊道规则与修复提示',
    json: JSON.stringify([{ op: 'graph.node.move', id: 'gn.9', x: -95, z: -108 }], null, 2),
  },
  {
    label: '功能：住宅主导街区', text: '切到自定义占比，住宅 60% / 商业 25% / 办公 10% / 研发 5%',
    json: JSON.stringify([
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.6 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.25 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.1 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.05 },
    ], null, 2),
  },
  {
    label: '功能：沿街商业街区', text: '商业 55% / 住宅 30% / 办公 10% / 研发 5%，构件层招牌密度随之上升',
    json: JSON.stringify([
      { op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'custom' },
      { op: 'rule.set', path: 'pipeline.landUse.mix.residential', value: 0.3 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.commercial', value: 0.55 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.office', value: 0.1 },
      { op: 'rule.set', path: 'pipeline.landUse.mix.research', value: 0.05 },
    ], null, 2),
  },
  {
    label: '功能：回到预设配比', text: '切回 mixPreset 权重表（自定义权重保留但不生效）',
    json: JSON.stringify([{ op: 'rule.set', path: 'pipeline.landUse.mixMode', value: 'preset' }], null, 2),
  },
];

interface CommandPanelProps {
  doc: SceneDocument;
  llmConfig: LlmConfig;
  setLlmConfig: (c: LlmConfig) => void;
  commandLog: CommandLogEntry[];
  execute: (commands: Command[], meta: ExecuteMeta) => ExecuteOutcome;
  onUiAction: (a: UiAction) => void;
  setStatus: (s: string) => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function CommandPanel(props: CommandPanelProps) {
  const { doc, llmConfig, setLlmConfig, commandLog, execute, onUiAction, setStatus } = props;
  const [input, setInput] = useState(ACCEPT_1);
  const [commandsText, setCommandsText] = useState('[]');
  const [edited, setEdited] = useState(false);
  const [mode, setMode] = useState<'local' | 'llm'>('local');
  const [parseInfo, setParseInfo] = useState<ParseResult['matched'] | null>(null);
  const [explanation, setExplanation] = useState('尚未解析');
  const [confidence, setConfidence] = useState(0);
  const [pendingUi, setPendingUi] = useState<UiAction[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(llmConfig);

  useEffect(() => { setLlmDraft(llmConfig); }, [llmConfig]);

  function applyLocal(text: string): { commands: Command[]; source: CommandSource; ui: UiAction[] } {
    const r = parseNaturalLanguage(text, { seed: doc.seed });
    setCommandsText(JSON.stringify(r.commands, null, 2));
    setParseInfo(r.matched);
    setExplanation(r.explanation);
    setConfidence(r.confidence);
    setPendingUi(r.uiActions);
    setEdited(false);
    setMode('local');
    return { commands: r.commands, source: 'nl', ui: r.uiActions };
  }

  // 首屏就把验收语句解析成可见的结构化命令，证明「无 AI 也能验证核心能力」
  useEffect(() => { applyLocal(ACCEPT_1); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  // proxy 模式由后端持有密钥，浏览器不需要 apiKey；direct 模式仅开发调试
  const llmReady = llmConfig.enabled
    && (llmConfig.mode === 'proxy' ? Boolean(llmConfig.proxyUrl) : Boolean(llmConfig.apiKey));

  async function resolveCommands(): Promise<{ commands: Command[]; source: CommandSource; ui: UiAction[] } | null> {
    setError(''); setNotice(''); setBusy(true);
    if (llmReady) {
      const res = await parseWithLlm(input, doc.rules, doc.seed, llmConfig);
      if (res.commands) {
        setCommandsText(JSON.stringify(res.commands, null, 2));
        setParseInfo([res.explanation ?? 'LLM 已输出结构化命令']);
        setExplanation('LLM 输出已通过 validateCommands() 白名单校验，未执行任何生成代码。');
        setConfidence(1);
        setPendingUi([]);
        setEdited(false);
        setMode('llm');
        setBusy(false);
        return { commands: res.commands, source: 'llm', ui: [] };
      }
      setNotice(`${res.error ?? 'LLM 失败'} 已回退到本地规则解析器。`);
    }
    const local = applyLocal(input);
    setBusy(false);
    return local;
  }

  function run(commands: Command[], source: CommandSource, ui: UiAction[]) {
    const v = validateCommands(commands);
    if (!v.ok || !v.commands) { setError(`命令校验失败：${v.error}`); return false; }
    const outcome = execute(v.commands, { input, source });
    if (!outcome.ok) { setError(outcome.message); return false; }
    for (const a of ui) onUiAction(a);
    setError('');
    return true;
  }

  function handleExecuteText() {
    let parsed: unknown;
    try { parsed = JSON.parse(commandsText); }
    catch (e) { setError(`JSON 语法错误：${(e as Error).message}`); return; }
    const v = validateCommands(parsed);
    if (!v.ok || !v.commands) { setError(`命令校验失败：${v.error}`); return; }
    run(v.commands, edited ? 'structured' : mode === 'llm' ? 'llm' : 'nl', pendingUi);
  }

  async function handleParseAndExecute() {
    const r = await resolveCommands();
    if (r) run(r.commands, r.source, r.ui);
  }

  async function runAcceptanceDemo() {
    setBusy(true);
    setStatus('验收演示开始：生成城市 → 局部编辑 → 撤销 → 重做 → 保存 → 加载');
    const flow: Array<{ text: string; }> = [{ text: ACCEPT_1 }, { text: ACCEPT_2 }];
    for (const step of flow) {
      setInput(step.text);
      const r = parseNaturalLanguage(step.text, { seed: doc.seed });
      setCommandsText(JSON.stringify(r.commands, null, 2));
      setParseInfo(r.matched);
      setExplanation(r.explanation);
      setConfidence(r.confidence);
      setEdited(false);
      setMode('local');
      execute(r.commands, { input: step.text, source: 'nl' });
      await delay(420);
    }
    onUiAction('showRules');
    await delay(420);
    onUiAction('undo'); await delay(420);
    onUiAction('redo'); await delay(420);
    onUiAction('save'); await delay(420);
    onUiAction('load');
    setBusy(false);
    setExplanation('验收演示完成：查看右侧「规则变化」与下方执行日志，可核对局部编辑、撤销与保存/加载一致性。');
    setStatus('验收演示完成 · 保存后重新加载得到一致生成结果');
  }

  return (
    <div className="command-panel">
      <div className="cmd-head">
        <h2>AI Command</h2>
        <span className={`tag ${llmReady ? 'green' : 'accent'}`}>
          {llmReady
            ? `LLM 已配置 · ${llmConfig.mode === 'proxy' ? '后端代理' : '直连（仅开发）'} · 输出经白名单校验`
            : '本地规则解析器 · 无需 API'}
        </span>
        <span className="spacer" />
        <button className={`btn sm ghost ${showLlm ? 'active' : ''}`} onClick={() => setShowLlm((v) => !v)}>AI 接口设置</button>
        <button className="btn sm" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }} disabled={busy} onClick={runAcceptanceDemo}>▶ 运行验收演示</button>
      </div>

      <div className="cmd-left">
        <div className="cmd-input-row">
          <textarea className="textarea" value={input} placeholder="输入中文场景指令…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleParseAndExecute(); }} />
          <div className="cmd-actions">
            <button className="btn primary" disabled={busy} onClick={() => void handleParseAndExecute()}>解析并执行<span className="small">Ctrl + Enter</span></button>
          </div>
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.label} className={`chip ${p.hot ? 'hot' : ''}`} onClick={() => {
              setInput(p.text);
              if (p.json) {
                setCommandsText(p.json);
                setEdited(true);
                setParseInfo(['结构化命令（手工）', '执行前经 validateCommands() 白名单校验']);
                setExplanation('管线参数预设：可先编辑数值，再点「校验并执行」。');
                setConfidence(1);
                setPendingUi([]);
                setMode('local');
              } else applyLocal(p.text);
            }}>{p.label}</button>
          ))}
          <span className="small muted" style={{ alignSelf: 'center', marginLeft: 4 }}>Ctrl+Enter 快速执行</span>
        </div>

        <div className="cmd-split">
          <div className="cmd-col">
            <div className="cmd-col-head">
              结构化命令 · 执行前强制校验<span className="spacer" />
              <button className="mini-btn" disabled={busy} onClick={() => void resolveCommands()}>解析</button>
              <button className="mini-btn" onClick={handleExecuteText}>校验并执行</button>
              <span className="tag">{edited ? '手工' : mode === 'llm' ? 'LLM' : '本地解析'}</span>
            </div>
            <div className="cmd-col-body">
              <textarea
                className="textarea" spellCheck={false} value={commandsText}
                onChange={(e) => { setCommandsText(e.target.value); setEdited(true); }}
              />
              {error && <div className="err">{error}</div>}
              {notice && <div className="inline-note mt6" style={{ color: 'var(--amber)' }}>{notice}</div>}
            </div>
          </div>
          <div className="cmd-col">
            <div className="cmd-col-head">解析说明<span className="spacer" /><span className="tag">置信度 {(confidence * 100).toFixed(0)}%</span></div>
            <div className="cmd-col-body">
              <div className="parse-info">
                {parseInfo?.map((m, i) => <div className="line" key={i}><span className="k">·</span><span>{m}</span></div>)}
                <div className="line" style={{ marginTop: 6 }}><span className="k">说明</span><span>{explanation}</span></div>
              </div>
              <div className="inline-note mt6">
                未配置 AI 时可直接粘贴命令 JSON，或用右侧 <b>PCG Inspector</b> 参数面板驱动生成 —— 核心 PCG 能力完全不依赖 LLM。
              </div>
            </div>
          </div>
        </div>

        {showLlm && (
          <div className="llm-box">
            <div className="row">
              <button className={`toggle ${llmDraft.enabled ? 'on' : ''}`} onClick={() => setLlmDraft({ ...llmDraft, enabled: !llmDraft.enabled })}>
                <span className="track" /><span className="small muted">启用 LLM 意图编译（关闭则始终使用本地解析器）</span>
              </button>
              <span className="spacer" />
              <button className="btn sm primary" onClick={() => { setLlmConfig(llmDraft); setStatus('AI 接口设置已保存到浏览器本地存储'); }}>保存设置</button>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <span className="small muted">接入方式</span>
              <button className={`btn sm ${llmDraft.mode === 'proxy' ? 'primary' : 'ghost'}`} onClick={() => setLlmDraft({ ...llmDraft, mode: 'proxy' })}>后端代理（推荐）</button>
              <button className={`btn sm ${llmDraft.mode === 'direct' ? 'primary' : 'ghost'}`} onClick={() => setLlmDraft({ ...llmDraft, mode: 'direct' })}>浏览器直连（仅开发）</button>
            </div>
            <div className="llm-grid">
              <label>模型<input className="input small" value={llmDraft.model} onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })} placeholder="gpt-4o-mini" /></label>
              {llmDraft.mode === 'proxy' ? (
                <label>代理地址<input className="input small" value={llmDraft.proxyUrl} onChange={(e) => setLlmDraft({ ...llmDraft, proxyUrl: e.target.value })} placeholder="/api/llm" /></label>
              ) : (
                <>
                  <label>Base URL<input className="input small" value={llmDraft.baseUrl} onChange={(e) => setLlmDraft({ ...llmDraft, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
                  <label>API Key<input className="input small" type="password" value={llmDraft.apiKey} onChange={(e) => setLlmDraft({ ...llmDraft, apiKey: e.target.value })} placeholder="仅存本机 localStorage" /></label>
                </>
              )}
              <button className="btn sm" onClick={() => setLlmDraft({ ...llmDraft, apiKey: '' })}>清除密钥</button>
            </div>
            <div className="llm-note">
              v1.3.0 默认走后端代理：先设置服务端环境变量 OPENAI_API_KEY，再运行 <b>npm run proxy</b>（Vite 已把 /api 转发到 5191）。
              代理模式使用 tool calling + JSON Schema 约束输出，密钥不进浏览器；直连模式仅用于开发调试。
              两条路径的输出都必须经 validateCommands() 白名单校验，LLM 不生成任何三维代码。
            </div>
          </div>
        )}
      </div>

      <div className="cmd-right">
        <div className="cmd-col-head">执行日志 · 规则变化与指纹追踪<span className="spacer" /><span className="tag">{commandLog.length} 条</span></div>
        <div className="cmd-col-body">
          <div className="log-list">
            {commandLog.length === 0 && <div className="empty">尚无执行记录。</div>}
            {commandLog.slice(0, 40).map((entry) => (
              <div className={`log-item ${entry.ok ? '' : 'fail'}`} key={entry.id}>
                <div className="l1">
                  <span className="t">{entry.time}</span>
                  <span className="tag" style={{ padding: '0 4px' }}>{entry.source}</span>
                  <span className="txt" title={entry.input}>{entry.input}</span>
                </div>
                <div className="l2">
                  {entry.message}
                  {entry.changes.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {entry.changes.map((c, i) => (
                        <div key={i}>· {c.label}（{c.scope}）<span className="diff-before">{String(c.before)}</span> → <span className="diff-after">{String(c.after)}</span></div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="l2 fp">{entry.fingerprintBefore} → {entry.fingerprintAfter}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
