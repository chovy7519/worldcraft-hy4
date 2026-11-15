/**
 * 版本演进一致性回归。
 *
 * 出过的问题：应用版本停在 0.1.0，README 版本演进停在 v1.3.0，
 * 而代码已经迭代了七轮 —— 版本号与文档各自漂移，没人发现。
 * 这里把「应用版本 / Schema 版本 / CHANGELOG / README / 开发记录」锁在一起。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATABLE_VERSIONS, SCHEMA_VERSION } from '../core/types';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string; description: string };
const lock = JSON.parse(read('package-lock.json')) as {
  version: string;
  packages: { '': { version: string } };
};
const changelog = read('docs/CHANGELOG.md');
const readme = read('README.md');
const story = read('docs/DEVELOPMENT_STORY.md');

describe('版本口径', () => {
  it('应用版本与锁文件三处一致，且描述不含过时的 V0.1', () => {
    expect(pkg.version).toBe('1.4.0');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(pkg.description).not.toContain('V0.1');
  });

  it('Scene Schema 保持 1.3.0，与应用版本刻意不同步', () => {
    expect(SCHEMA_VERSION).toBe('1.3.0');
    expect(pkg.version).not.toBe(SCHEMA_VERSION);
    expect(MIGRATABLE_VERSIONS).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect(MIGRATABLE_VERSIONS).not.toContain(SCHEMA_VERSION);
    expect(changelog).toContain('应用版本与 Schema 版本刻意不同步');
  });
});

describe('版本演进记录完整性', () => {
  it('CHANGELOG 顶部声明的应用版本与 package.json 一致', () => {
    const m = /\*\*应用版本\*\*[^|]*\|\s*\*\*([\d.]+)\*\*/.exec(changelog);
    expect(m, 'CHANGELOG §0 缺少应用版本声明').not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });

  it('五个版本在 CHANGELOG 中都有条目，README 摘要含当前版本', () => {
    for (const v of ['V0.1', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0']) {
      expect(changelog, `CHANGELOG 缺少 ${v}`).toContain(v);
    }
    expect(readme).toContain('v1.4.0');
    expect(readme).toContain('[CHANGELOG.md](docs/CHANGELOG.md)');
  });

  it('开发过程记录补上阶段六，并标明 §6 是历史快照', () => {
    expect(story).toContain('阶段六 · v1.4.0');
    expect(story).toContain('2026-11-06 首次交付时的快照');
  });

  it('记录中保留关键硬数据与未做清单，不把评估写成已实现', () => {
    for (const datum of ['57/57', '11,169', '−36.8%', '203', '209', 'DCA491B5', '50d9cc7']) {
      expect(changelog, `CHANGELOG 缺少关键数据 ${datum}`).toContain(datum);
    }
    expect(changelog).toContain('明确未做');
    expect(changelog).toContain('2 km 判定为非目标');
  });
});
