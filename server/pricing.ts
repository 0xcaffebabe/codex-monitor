import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tokens } from './usage-parser.js';

const rate = z.number().finite().min(0);
const schema = z.object({
  currency: z.literal('USD'),
  note: z.string().optional(),
  models: z.record(
    z.string(),
    z.object({ input: rate, cachedInput: rate, cacheWrite: rate.default(0), output: rate }),
  ),
  aliases: z.record(z.string(), z.string()).default({}),
});
export class PricingCatalog {
  private catalog?: z.infer<typeof schema>;
  private version = '';
  warning = '';
  constructor(public file: string) {}
  get revision() {
    return `${this.version}:${this.warning}`;
  }
  reload() {
    try {
      const stat = statSync(this.file),
        version = `${stat.mtimeMs}:${stat.size}`;
      if (version === this.version) return;
      const next = schema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.catalog = next;
      this.version = version;
      this.warning = '';
    } catch {
      this.warning = this.catalog
        ? '价格配置无效，暂时沿用上次有效价格。'
        : '价格配置不可用，成本暂无法计算。';
    }
  }
  cost(model: string, usage: Tokens): number | null {
    const models = this.catalog?.models,
      aliases = this.catalog?.aliases;
    if (!models) return null;
    const normalized = model
      .trim()
      .replace(/^(?:openai|azure)\//, '')
      .replace(/-(?:minimal|low|medium|high|xhigh|max|ultra)$/, '');
    const alias =
      aliases &&
      (Object.hasOwn(aliases, model)
        ? aliases[model]
        : Object.hasOwn(aliases, normalized)
          ? aliases[normalized]
          : undefined);
    const key = alias ?? (Object.hasOwn(models, model) ? model : normalized);
    const p = Object.hasOwn(models, key) ? models[key] : undefined;
    if (!p) return null;
    return (
      ((usage.input - usage.cached - usage.cacheWrite) * p.input +
        usage.cached * p.cachedInput +
        usage.cacheWrite * p.cacheWrite +
        usage.output * p.output) /
      1000000
    );
  }
}
