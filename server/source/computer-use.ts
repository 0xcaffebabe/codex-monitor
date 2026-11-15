import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ComputerUsePage, ComputerUseStep } from '../../src/types.js';
import type { SourceDatabases } from './databases.js';
import type { RolloutStore } from './rollouts.js';
import type { InternalSession } from './session.js';
import { displayItemSql } from './sql.js';
import {
  computerUseResult,
  computerUseStep,
  isComputerUseCall,
  screenshotMedia,
} from './computer-use-parser.js';
import { COMPUTER_USE_LINE_LIMIT, computerUseRecords } from './computer-use-log.js';

type ImageLocation =
  | { kind: 'log'; offset: number; bytes: number; index: number }
  | { kind: 'history'; table: string; index: number };
type StoredStep = { step: ComputerUseStep; images: ImageLocation[]; rank: number };
type Snapshot = {
  version: string;
  file: string | null;
  identity: string;
  size: number;
  mtime: number;
  offset: number;
  steps: Map<string, StoredStep>;
  warnings: Set<string>;
};

/** A lazy, bounded index of Computer Use metadata and screenshot locations. No image payload is cached. */
export class ComputerUseReader {
  private cache = new Map<string, Snapshot>();
  private reading = new Map<string, Promise<Snapshot>>();
  private availability = new Map<string, { version: string; value: boolean }>();
  constructor(
    private databases: Pick<SourceDatabases, 'history' | 'historyColumns'>,
    private rollouts: Pick<RolloutStore, 'safeFile'>,
  ) {}
  private candidates(table: 'thread_items' | 'thread_realtime_items') {
    const type =
      table === 'thread_items' && this.databases.historyColumns.has('item_type')
        ? 'item_type'
        : "json_extract(item_json,'$.type')";
    return this.databases.history?.prepare(
      `SELECT item_id,created_at_ms,${displayItemSql('item_json')} AS item_json
       FROM ${table} WHERE thread_id=? AND json_valid(item_json)
       AND lower(replace(${type},'_','')) IN ('mcptoolcall','functioncall','customtoolcall')
       ORDER BY rollout_ordinal`,
    );
  }
  has(session: InternalSession, version: string) {
    const cached = this.availability.get(session.id);
    if (cached?.version === version) return cached.value;
    let value = false;
    for (const table of ['thread_items', 'thread_realtime_items'] as const) {
      try {
        for (const row of this.candidates(table)?.iterate(session.id) ?? []) {
          if (isComputerUseCall(JSON.parse(String(row.item_json)))) {
            value = true;
            break;
          }
        }
      } catch {
        /* Older histories may not have a realtime table. */
      }
      if (value) break;
    }
    if (this.availability.size >= 64)
      this.availability.delete(this.availability.keys().next().value!);
    this.availability.set(session.id, { version, value });
    return value;
  }
  private add(
    snapshot: Snapshot,
    candidate: ComputerUseStep,
    result?: any,
    location?:
      Omit<Extract<ImageLocation, { kind: 'log' }>, 'index'> | { kind: 'history'; table: string },
    rank = 0,
  ) {
    const previous = snapshot.steps.get(candidate.id);
    const data = result === undefined ? undefined : computerUseResult(result);
    const step: ComputerUseStep = { ...previous?.step, ...candidate };
    if (previous) {
      step.timestamp = Math.min(
        previous.step.timestamp || candidate.timestamp,
        candidate.timestamp || previous.step.timestamp,
      );
      step.title = candidate.title === '操作电脑或浏览器' ? previous.step.title : candidate.title;
      step.durationMs ??= previous.step.durationMs;
      if (
        ['inProgress', 'in_progress', 'running'].includes(step.status) &&
        !['inProgress', 'in_progress', 'running'].includes(previous.step.status)
      )
        step.status = previous.step.status;
    }
    if (data?.failed) step.status = 'failed';
    if (data?.text) step.text = data.text;
    if (data?.url) step.url = data.url;
    if (data?.pageTitle) step.pageTitle = data.pageTitle;
    let images = previous?.images ?? [],
      imageRank = previous?.rank ?? -1;
    if (location && data?.images.length && rank >= imageRank) {
      images = data.images.map((_, index) => ({ ...location, index }));
      imageRank = rank;
    }
    step.screenshots = images.length;
    snapshot.steps.set(step.id, { step, images, rank: imageRank });
  }
  private record(snapshot: Snapshot, record: any, offset: number, bytes: number) {
    const p = record.payload ?? {},
      stamp = Date.parse(record.timestamp) || 0;
    const location = { kind: 'log' as const, offset, bytes };
    if (
      record.type === 'response_item' &&
      ['function_call', 'custom_tool_call'].includes(p.type) &&
      isComputerUseCall(p)
    ) {
      const id = String(p.call_id ?? p.id ?? '');
      if (id) this.add(snapshot, computerUseStep(p, id, stamp));
    } else if (
      record.type === 'event_msg' &&
      p.type === 'item_completed' &&
      isComputerUseCall(p.item ?? {})
    ) {
      const item = p.item,
        id = String(item.id ?? '');
      if (!id) return;
      const step = computerUseStep(item, id, Number(p.started_at_ms) || stamp);
      if (p.completed_at_ms && p.started_at_ms)
        step.durationMs ??= Number(p.completed_at_ms) - Number(p.started_at_ms);
      this.add(snapshot, step, item.result, location, 1);
    } else if (
      record.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output'].includes(p.type)
    ) {
      const previous = snapshot.steps.get(p.call_id);
      if (!previous) return;
      const step = {
        ...previous.step,
        status: previous.step.status === 'failed' ? 'failed' : 'completed',
      };
      if (!step.durationMs && stamp > step.timestamp) step.durationMs = stamp - step.timestamp;
      this.add(snapshot, step, p.output, location, 2);
    }
  }
  private async load(session: InternalSession, version: string): Promise<Snapshot> {
    const file = this.rollouts.safeFile(session.file),
      stat = file ? statSync(file) : undefined;
    const identity = stat ? `${stat.dev}-${stat.ino}-${stat.birthtimeMs}` : '';
    const fingerprint = `${version}-${stat?.size}-${stat?.mtimeMs}`;
    let snapshot = this.cache.get(session.id);
    if (snapshot?.version === fingerprint) return snapshot;
    if (
      !snapshot ||
      snapshot.file !== file ||
      snapshot.identity !== identity ||
      (stat &&
        (stat.size < snapshot.size ||
          (stat.size === snapshot.size && stat.mtimeMs !== snapshot.mtime)))
    ) {
      snapshot = {
        version: '',
        file,
        identity,
        size: 0,
        mtime: 0,
        offset: 0,
        steps: new Map(),
        warnings: new Set(),
      };
    }
    if (file && stat) {
      try {
        for await (const row of computerUseRecords(file, snapshot.offset, stat.size)) {
          snapshot.offset = row.next;
          if (!row.line) {
            snapshot.warnings.add('部分记录过大，已跳过。');
            continue;
          }
          try {
            this.record(snapshot, JSON.parse(row.line), row.offset, row.bytes);
          } catch {
            snapshot.warnings.add('部分操作记录无法读取，已跳过。');
          }
        }
      } catch {
        snapshot.warnings.add('操作日志暂时不可读，请稍后刷新。');
      }
    }
    for (const table of ['thread_items', 'thread_realtime_items'] as const) {
      try {
        for (const row of this.candidates(table)?.iterate(session.id) ?? []) {
          const item = JSON.parse(String(row.item_json));
          if (!isComputerUseCall(item)) continue;
          const id = String(row.item_id),
            previous = snapshot.steps.get(id);
          const step = computerUseStep(item, id, Number(row.created_at_ms));
          if (
            !previous ||
            previous.step.status !== step.status ||
            previous.images.some((image) => image.kind === 'history' && image.table !== table)
          ) {
            const full = this.databases
              .history!.prepare(
                `SELECT item_json FROM ${table} WHERE thread_id=? AND item_id=? LIMIT 1`,
              )
              .get(session.id, id);
            const complete = full ? JSON.parse(String(full.item_json)) : item;
            step.durationMs = complete.durationMs;
            this.add(snapshot, step, complete.result, { kind: 'history', table }, 0);
          } else this.add(snapshot, step);
        }
      } catch {
        /* The append-only log remains usable when a history database is unavailable. */
      }
    }
    if (!file) snapshot.warnings.add('本地操作日志不可用，部分截图可能无法查看。');
    snapshot.size = stat?.size ?? 0;
    snapshot.mtime = stat?.mtimeMs ?? 0;
    snapshot.version = fingerprint;
    if (this.cache.size >= 8 && !this.cache.has(session.id))
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(session.id, snapshot);
    return snapshot;
  }
  private read(session: InternalSession, version: string) {
    const active = this.reading.get(session.id);
    if (active) return active;
    const promise = this.load(session, version);
    this.reading.set(session.id, promise);
    void promise
      .finally(() => {
        if (this.reading.get(session.id) === promise) this.reading.delete(session.id);
      })
      .catch(() => {});
    return promise;
  }
  async page(
    session: InternalSession,
    version: string,
    before?: number,
    limit = 100,
  ): Promise<ComputerUsePage> {
    const snapshot = await this.read(session, version);
    const steps = [...snapshot.steps.values()]
      .map((entry) => entry.step)
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const end = Math.min(before ?? steps.length, steps.length),
      start = Math.max(0, end - limit);
    return {
      sessionId: session.id,
      steps: steps.slice(start, end),
      total: steps.length,
      before: start || null,
      version: snapshot.version,
      warnings: [...snapshot.warnings],
    };
  }
  async image(session: InternalSession, version: string, id: string, index: number) {
    const snapshot = await this.read(session, version),
      location = snapshot.steps.get(id)?.images[index];
    if (!location) return null;
    let value: any;
    if (location.kind === 'history') {
      const row = this.databases.history
        ?.prepare(`SELECT item_json FROM ${location.table} WHERE thread_id=? AND item_id=? LIMIT 1`)
        .get(session.id, id);
      if (!row) return null;
      value = JSON.parse(String(row.item_json)).result;
    } else {
      const file = this.rollouts.safeFile(session.file);
      if (!file || file !== snapshot.file || location.bytes > COMPUTER_USE_LINE_LIMIT) return null;
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(location.bytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, location.offset);
        if (bytesRead !== buffer.length) return null;
        const record = JSON.parse(buffer.toString('utf8')),
          p = record.payload ?? {};
        if ((p.call_id ?? p.item?.id) !== id) return null;
        value = p.item ? p.item.result : p.output;
      } finally {
        await handle.close();
      }
    }
    const url = computerUseResult(value).images[location.index];
    return url ? screenshotMedia(url) : null;
  }
}
