/**
 * 可选 LLM 适配器（OpenAI Chat Completions 兼容协议）。
 *
 * 职责边界：LLM 只负责「中文意图 → Command[] JSON」，**不生成任何三维代码**。
 * 输出必须经 validateCommands() 白名单校验，非法字段/越界值/未知 op 一律拒绝。
 * 未配置时整个应用仍可完整运行：本地规则解析器 + Inspector + 结构化命令 JSON。
 *
 * 密钥仅存于浏览器 localStorage，绝不写入源码、构建产物或 git。
 * 注意：浏览器直连会在本机网络请求中携带密钥，仅建议在开发环境使用；
 * 生产部署应改为自有后端代理。V0.1 为纯前端工作台，不引入后端。
 */
import { validateCommands } from './commands';
import { llmFieldCatalog } from './fields';
import type { Command, SceneRules } from './types';

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const LLM_STORAGE_KEY = 'worldcraft.llm.v1';

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
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
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_LLM_CONFIG.baseUrl,
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

const COMMAND_DOC = `
可用命令（commands 数组，每个元素必须严格符合以下之一）：
1. {"op":"scene.create","width":400,"depth":400,"name":"...","seed":123}  重新生成场景
2. {"op":"scene.reset"}  恢复默认规则
3. {"op":"seed.set","value":12345}  设置随机种子
4. {"op":"rule.set","path":"<已注册路径>","value":<number|string|boolean>}  设置单条规则
5. {"op":"density.adjust","zone":"all|core|east|west|north|south","mode":"relative","delta":-0.3}
   mode 也可为 "absolute" 并给出 value（倍率）。relative 的 delta 是比例，-0.3 表示降低 30%。
6. {"op":"height.adjust","zone":"...","mode":"relative","delta":-0.2}  同上，作用于高度倍率
7. {"op":"object.override","id":"bld.12.8","patch":{"height":80,"color":"#3f7fa8","visible":true}}
8. {"op":"object.delete","id":"bld.12.8"} / {"op":"object.restore","id":"..."}
9. {"op":"camera.set","preset":"iso|top|front|ne35"}

关键语义：
- 「降低东侧建筑密度 30%」→ density.adjust zone=east mode=relative delta=-0.3。
  系统按网格坐标独立哈希采样，因此其他分区对象逐位不变，无需生成额外命令。
- 「中心高外围低」→ rule.set height.profile = "centerHigh"。
- 「保留中央公共开放空间」→ rule.set openSpace.enabled = true。
- 分区互斥：core / east / west / north / south；all 表示全局。
- 禁止输出上述 op 之外的任何操作，禁止输出 JavaScript / Three.js 代码。
- 输出必须是严格 JSON：{"commands":[...],"explanation":"简短中文说明"}，不要 Markdown 代码块。
`.trim();

export function buildSystemPrompt(currentRules: SceneRules, seed: number): string {
  const fields = llmFieldCatalog()
    .map((f) => `  - ${f.path} (${f.label}, ${f.type}${f.min !== undefined ? `, ${f.min}~${f.max}` : ''}${f.options ? `, 可选 ${f.options.join('|')}` : ''})`)
    .join('\n');
  return [
    '你是 WorldCraft V0.1 的意图编译器，把用户的中文场景编辑请求翻译成受控命令 JSON。',
    '你只能使用下列已注册规则路径与命令，任何越界请求都要在 explanation 中说明无法执行。',
    '',
    '已注册规则路径：',
    fields,
    '',
    `当前随机种子：${seed}。当前规则摘要：${JSON.stringify({
      size: [currentRules.terrain.width, currentRules.terrain.depth],
      profile: currentRules.height.profile,
      densityBase: currentRules.density.base,
      zoneDensity: currentRules.density.zoneMultipliers,
      openSpace: currentRules.openSpace.enabled,
      palette: currentRules.material.palette,
    })}`,
    '',
    COMMAND_DOC,
  ].join('\n');
}

export interface LlmParseResult {
  commands?: Command[];
  explanation?: string;
  error?: string;
  raw?: string;
}

export async function parseWithLlm(
  input: string,
  currentRules: SceneRules,
  seed: number,
  config: LlmConfig,
  timeoutMs = 20000,
): Promise<LlmParseResult> {
  if (!config.apiKey) return { error: '未配置 API Key，已回退到本地规则解析器。' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(currentRules, seed) },
          { role: 'user', content: input },
        ],
      }),
    });
    if (!res.ok) return { error: `LLM 接口返回 ${res.status} ${res.statusText}` };
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { error: 'LLM 未返回内容' };
    const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch { return { error: 'LLM 输出不是合法 JSON', raw: cleaned }; }
    const obj = parsed as { commands?: unknown; explanation?: string };
    const validation = validateCommands(obj.commands);
    if (!validation.ok || !validation.commands) {
      return { error: `LLM 输出未通过受控命令校验：${validation.error}`, raw: cleaned };
    }
    return { commands: validation.commands, explanation: obj.explanation, raw: cleaned };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === 'AbortError' ? 'LLM 请求超时' : `LLM 请求失败：${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
