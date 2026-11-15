/**
 * LLM 适配器（v1.3.0）
 *
 * 职责边界不变：LLM 只负责「中文意图 → Command[] JSON」，不生成任何三维代码。
 * 输出必须经 validateCommands() 白名单校验，非法字段 / 越界值 / 未知 op 一律拒绝。
 * 未配置时整个应用仍可完整运行：本地规则解析器 + Inspector + 结构化命令 JSON。
 *
 * v1.3.0 修复两处结构性问题：
 * 1. 命令目录漂移：旧版 COMMAND_DOC 硬编码 9 类命令，v1.2.0 的 graph.* / parcel.*
 *    全部不可见。现在用 `satisfies Record<Command['op'], ...>` 做**编译期穷尽检查** ——
 *    以后新增 Command op 而不补文档，tsc 直接报错，不可能再悄悄漂移。
 * 2. 浏览器直连：默认改为后端代理模式（密钥不进浏览器）。proxy 模式同时启用
 *    tool calling + JSON Schema 结构化输出；direct 模式保留为开发调试用，界面明确标注。
 */
import { validateCommands } from './commands';
import { llmFieldCatalog } from './fields';
import type { Command, SceneRules } from './types';

export interface LlmConfig {
  enabled: boolean;
  /** proxy：请求自有后端（推荐）；direct：浏览器直连，仅开发用 */
  mode: 'direct' | 'proxy';
  baseUrl: string;
  proxyUrl: string;
  model: string;
  /** direct 模式下的密钥；proxy 模式必须为空白，密钥只存在服务端环境变量中 */
  apiKey: string;
}

export const LLM_STORAGE_KEY = 'worldcraft.llm.v1';

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  mode: 'proxy',
  baseUrl: 'https://api.openai.com/v1',
  proxyUrl: '/api/llm',
  model: 'gpt-4o-mini',
  apiKey: '',
};

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      mode: parsed.mode === 'direct' ? 'direct' : 'proxy',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_LLM_CONFIG.baseUrl,
      proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl : DEFAULT_LLM_CONFIG.proxyUrl,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_LLM_CONFIG.model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(config));
}

export interface CommandDoc {
  label: string;
  shape: string;
  note?: string;
}

/**
 * 命令目录 = 单一事实来源。satisfies 保证它穷尽 Command 联合类型的所有 op。
 * 这份目录同时喂给：系统提示、tool calling 的 enum、命令面板的结构化预设。
 */
export const COMMAND_DOCS = {
  'scene.create': { label: '生成场景', shape: '{"op":"scene.create","width":400,"depth":400,"name":"...","seed":123}' },
  'scene.reset': { label: '恢复默认规则', shape: '{"op":"scene.reset"}' },
  'seed.set': { label: '设置随机种子', shape: '{"op":"seed.set","value":12345}' },
  'rule.set': { label: '设置单条规则', shape: '{"op":"rule.set","path":"<已注册路径>","value":<number|string|boolean>}', note: 'path 必须来自字段目录' },
  'density.adjust': { label: '调整密度', shape: '{"op":"density.adjust","zone":"all|core|east|west|north|south","mode":"relative","delta":-0.3}' },
  'height.adjust': { label: '调整高度', shape: '{"op":"height.adjust","zone":"all|core|east|west|north|south","mode":"relative","delta":-0.2}' },
  'object.override': { label: '覆写单体建筑', shape: '{"op":"object.override","id":"bld.12.8","patch":{"height":80,"color":"#3f7fa8"}}' },
  'object.delete': { label: '删除单体', shape: '{"op":"object.delete","id":"bld.12.8"}' },
  'object.restore': { label: '恢复单体', shape: '{"op":"object.restore","id":"bld.12.8"}' },
  'graph.regenerate': { label: '重建道路图', shape: '{"op":"graph.regenerate"}' },
  'graph.node.add': { label: '新增道路节点', shape: '{"op":"graph.node.add","x":0,"z":0,"id":"n.custom"}' },
  'graph.node.move': { label: '移动道路节点', shape: '{"op":"graph.node.move","id":"n.1","x":10,"z":20}' },
  'graph.node.remove': { label: '删除道路节点', shape: '{"op":"graph.node.remove","id":"n.1"}' },
  'graph.edge.add': { label: '新增路段', shape: '{"op":"graph.edge.add","from":"n.1","to":"n.2","cls":"local"}' },
  'graph.edge.remove': { label: '删除路段', shape: '{"op":"graph.edge.remove","id":"e.1"}' },
  'graph.edge.update': { label: '修改路段', shape: '{"op":"graph.edge.update","id":"e.1","cls":"arterial","width":11}' },
  'parcel.split': { label: '拆分地块', shape: '{"op":"parcel.split","a":{"x":0,"z":0},"b":{"x":30,"z":30}}' },
  'parcel.merge': { label: '合并地块', shape: '{"op":"parcel.merge","a":{"x":10,"z":10},"b":{"x":20,"z":20}}' },
  'parcel.vertex': { label: '移动地块顶点', shape: '{"op":"parcel.vertex","at":{"x":0,"z":0},"to":{"x":5,"z":5}}' },
  'parcel.edits.clear': { label: '清空地块编辑', shape: '{"op":"parcel.edits.clear"}' },
  'region.add': {
    label: '新增区域叠加层',
    shape: '{"op":"region.add","layer":{"id":"r.river","name":"沿江带","selector":{"kind":"band","axis":"x","min":-200,"max":-100},"density":0.7,"height":0.8,"enabled":true,"priority":10,"blend":"multiply"}}',
    note: 'selector.kind: all | zone | band | radius | polygon',
  },
  'region.update': { label: '更新区域叠加层', shape: '{"op":"region.update","id":"r.river","patch":{"density":0.5}}' },
  'region.remove': { label: '移除区域叠加层', shape: '{"op":"region.remove","id":"r.river"}' },
  'region.clear': { label: '清空区域叠加层', shape: '{"op":"region.clear"}' },
  'camera.set': { label: '切换视角', shape: '{"op":"camera.set","preset":"iso|top|front|ne35"}' },
} satisfies Record<Command['op'], CommandDoc>;

export const COMMAND_OPS = Object.keys(COMMAND_DOCS) as Array<Command['op']>;

/** tool calling / response_format json_schema 用的结构化输出定义 */
export function buildCommandToolSchema() {
  return {
    type: 'function' as const,
    function: {
      name: 'compile_commands',
      description: '把用户的中文城市设计编辑意图编译成 WorldCraft 受控命令数组。只输出命令，不输出任何代码。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['commands', 'explanation'],
        properties: {
          commands: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'object',
              required: ['op'],
              properties: { op: { type: 'string', enum: COMMAND_OPS } },
            },
            description: '按执行顺序排列的命令；op 之外的字段见系统提示中的命令目录。',
          },
          explanation: { type: 'string', description: '简短中文说明；无法执行时在此写明原因并返回空数组。' },
        },
      },
    },
  };
}

export function buildSystemPrompt(currentRules: SceneRules, seed: number): string {
  const fields = llmFieldCatalog()
    .map((f) => `  - ${f.path} (${f.label}, ${f.type}${f.min !== undefined ? `, ${f.min}~${f.max}` : ''}${f.options ? `, 可选 ${f.options.join('|')}` : ''})`)
    .join('\n');
  const commands = (Object.entries(COMMAND_DOCS) as Array<[string, CommandDoc]>)
    .map(([op, doc]) => `  - ${op} · ${doc.label}：${doc.shape}${doc.note ? `（${doc.note}）` : ''}`)
    .join('\n');
  return [
    '你是 WorldCraft v1.3.0 的意图编译器，把用户的中文场景编辑请求翻译成受控命令 JSON。',
    '你只能使用下列已注册规则路径与命令，任何越界请求都要在 explanation 中说明无法执行。',
    '',
    '已注册规则路径：',
    fields,
    '',
    '可用命令（穷尽清单，禁止输出清单之外的 op）：',
    commands,
    '',
    '关键语义：',
    '- 「降低东侧建筑密度 30%」→ density.adjust zone=east mode=relative delta=-0.3；系统按坐标独立哈希采样，其他分区逐位不变。',
    '- 「沿 X 轴 -200~-100 m 的区域降低密度」→ region.add + band 选择器，不要用互斥分区近似。',
    '- 「中心高外围低」→ rule.set height.profile = "centerHigh"；「保留中央开放空间」→ rule.set openSpace.enabled = true。',
    '- 分区互斥：core / east / west / north / south；all 表示全局。区域叠加层可表达叠加谓词，优先于分区近似。',
    '- 禁止输出 JavaScript / Three.js 代码；输出严格 JSON，不要 Markdown 代码块。',
    '',
    `当前随机种子：${seed}。当前规则摘要：${JSON.stringify({
      size: [currentRules.terrain.width, currentRules.terrain.depth],
      profile: currentRules.height.profile,
      densityBase: currentRules.density.base,
      zoneDensity: currentRules.density.zoneMultipliers,
      openSpace: currentRules.openSpace.enabled,
      palette: currentRules.material.palette,
      extensions: currentRules.pipeline.extensions,
    })}`,
  ].join('\n');
}

export interface LlmParseResult {
  commands?: Command[];
  explanation?: string;
  error?: string;
  raw?: string;
}

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ function?: { arguments?: string } }>;
  };
}

function extractPayload(data: { choices?: ChatChoice[] }): unknown {
  const message = data.choices?.[0]?.message;
  const args = message?.tool_calls?.[0]?.function?.arguments;
  const content = args ?? message?.content;
  if (!content) return null;
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return { __invalid: cleaned }; }
}

/**
 * proxy 模式：请求自有后端，body 里带 tools/tool_choice，密钥由服务端注入。
 * direct 模式：浏览器直连 OpenAI 兼容接口，用 json_object 约束输出；仅开发调试。
 */
export async function parseWithLlm(
  input: string,
  currentRules: SceneRules,
  seed: number,
  config: LlmConfig,
  timeoutMs = 20000,
): Promise<LlmParseResult> {
  const isProxy = config.mode !== 'direct';
  if (!isProxy && !config.apiKey) return { error: '直连模式未配置 API Key；请改用后端代理或本地规则解析器。' };
  if (isProxy && !config.proxyUrl) return { error: '代理模式未配置 proxyUrl。' };

  const system = buildSystemPrompt(currentRules, seed);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: input }];
  const body: Record<string, unknown> = isProxy
    ? {
      model: config.model, temperature: 0, messages,
      tools: [buildCommandToolSchema()],
      tool_choice: { type: 'function', function: { name: 'compile_commands' } },
    }
    : {
      model: config.model, temperature: 0, messages,
      response_format: { type: 'json_object' },
    };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = isProxy
      ? config.proxyUrl
      : `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(!isProxy ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const hint = isProxy ? '（代理未部署或服务端密钥缺失）' : '';
      return { error: `LLM 接口返回 ${res.status} ${res.statusText}${hint}` };
    }
    const data = await res.json() as { choices?: ChatChoice[] };
    const parsed = extractPayload(data);
    if (parsed === null) return { error: 'LLM 未返回内容' };
    if (typeof parsed === 'object' && parsed !== null && '__invalid' in parsed) {
      return { error: 'LLM 输出不是合法 JSON', raw: String((parsed as { __invalid: string }).__invalid) };
    }
    const obj = parsed as { commands?: unknown; explanation?: string };
    const validation = validateCommands(obj.commands);
    if (!validation.ok || !validation.commands) {
      return { error: `LLM 输出未通过受控命令校验：${validation.error}`, raw: JSON.stringify(parsed) };
    }
    return { commands: validation.commands, explanation: obj.explanation, raw: JSON.stringify(parsed) };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === 'AbortError' ? 'LLM 请求超时' : `LLM 请求失败：${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
