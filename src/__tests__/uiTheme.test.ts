/**
 * UI 双主题回归。
 *
 * 曾经出过的事故：`:root[data-theme='sheet']` 与 `:root[data-theme='nautical']`
 * 两套变量被「配色回退」改成逐行相同，按钮和 dataset.theme 都还在，
 * 但点击后画面毫无变化 —— 功能实际上不存在。这里把「两套主题必须真的不同」
 * 变成可自动验证的契约，防止再次被无意识回退。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest 会把 .css / ?raw 导入 mock 成空串，因此直接读磁盘原文。
// 由 @types/node 提供类型；纯 devDependency，不进入浏览器产物。
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

function themeVars(theme: 'sheet' | 'nautical'): Record<string, string> {
  const re = new RegExp(`:root\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const match = re.exec(css);
  if (!match) throw new Error(`找不到主题变量块 ${theme}`);
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = /--([\w-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const sheet = themeVars('sheet');
const nautical = themeVars('nautical');

describe('UI 制图双主题', () => {
  it('两套主题都定义了完整的设计令牌', () => {
    for (const vars of [sheet, nautical]) {
      expect(Object.keys(vars).length).toBeGreaterThanOrEqual(25);
      for (const key of [
        'paper', 'paper-2', 'paper-3', 'ink', 'ink-2', 'ink-3', 'rule', 'rule-soft',
        'grid', 'grid-2', 'accent', 'accent-soft', 'scheme',
        'on-accent', 'btn-primary-bg', 'btn-active-bg', 'hud-border',
      ]) {
        expect(vars[key], `缺少 --${key}`).toBeDefined();
      }
    }
  });

  it('两套主题的基础色板必须真的不同（这次事故的回归断言）', () => {
    const differing = Object.keys(sheet).filter((k) => sheet[k] !== nautical[k]);
    expect(differing.length).toBeGreaterThanOrEqual(12);
    for (const key of [
      'paper', 'paper-2', 'paper-3', 'ink', 'ink-2', 'ink-3',
      'rule', 'rule-soft', 'grid', 'accent-soft',
      'btn-primary-bg', 'btn-active-bg', 'hud-border', 'scheme',
    ]) {
      expect(sheet[key], `--${key} 在两套主题中相同，主题切换将不可见`).not.toBe(nautical[key]);
    }
  });

  it('浅色图纸 / 深色海图的明暗语义正确，功能色不反转', () => {
    expect(sheet.scheme).toBe('light');
    expect(nautical.scheme).toBe('dark');
    // VISUAL_STYLE.md §4.2：功能色与浅色主题一致，不反转
    for (const key of ['accent', 'red', 'green', 'amber', 'purple', 'teal']) {
      expect(sheet[key]).toBe(nautical[key]);
    }
  });

  it('组件样式通过变量取色，不再把旧深色硬编码写死', () => {
    expect(css).not.toContain('#090e14');
    expect(css).toContain('background: var(--btn-primary-bg)');
    expect(css).toContain('background: var(--btn-active-bg)');
    expect(css).toContain('border: 1px solid var(--hud-border)');
  });

  it('UI 主题与场景主题是两套独立状态，切换 UI 不动 SceneDocument', () => {
    expect(app).toContain("document.documentElement.dataset.theme = theme");
    expect(app).toContain("const THEME_KEY = 'worldcraft.theme'");
    expect(app).toContain("const SCENE_THEME_KEY = 'worldcraft.sceneTheme'");
    expect(app).toContain('toggleSceneTheme={toggleSceneTheme}');
  });
});
