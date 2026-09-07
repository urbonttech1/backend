// ── Container-aware process metrics ───────────────────────────────────────────
// Node's own numbers are about the process, not the container it runs in:
// `process.memoryUsage()` has no idea ECS granted it 1 GB, and there is no
// built-in CPU percentage at all.
//
// Reporting heapUsed/heapTotal as "memory used" is the trap this module exists
// to avoid — that ratio sits at 80-90% permanently because V8 grows the heap on
// demand, so a dashboard built on it shows a red bar on an idle server.
//
// Limits are read once from the ECS task metadata endpoint, falling back to
// cgroup and finally to the host. CPU percentage comes from sampling
// process.cpuUsage() between calls, normalised against the allocated vCPU.

import fs from 'fs';
import os from 'os';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('METRICS');

export interface MemoryInfo {
  /** Resident set size in MB — what the container actually holds. */
  usedMb: number;
  /** Container limit in MB. */
  limitMb: number;
  /** usedMb over limitMb. The number a dashboard should show. */
  percent: number;
  /** V8 heap, kept for diagnostics. Not a capacity signal. */
  heapUsedMb: number;
  heapTotalMb: number;
}

export interface CpuInfo {
  /** Percentage of the allocated CPU, 0-100. Null until a second sample exists. */
  percent: number | null;
  /** vCPU granted to the task. */
  vcpu: number;
}

// ── Limits, resolved once ─────────────────────────────────────────────────────

interface Limits { memoryBytes: number; vcpu: number; source: string; }
let cached: Limits | null = null;
let resolving: Promise<Limits> | null = null;

function fromCgroup(): number | null {
  // cgroup v2 first, then v1. "max" means unlimited.
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw === 'max') continue;
      const n = Number(raw);
      // v1 reports a huge sentinel when unlimited; ignore anything over 1 TB.
      if (Number.isFinite(n) && n > 0 && n < 1024 ** 4) return n;
    } catch { /* not present on this platform */ }
  }
  return null;
}

async function fromEcsMetadata(): Promise<Limits | null> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return null;
  try {
    const ctl = AbortSignal.timeout(1500);
    const r = await fetch(`${base}/task`, { signal: ctl });
    if (!r.ok) return null;
    const task = await r.json() as { Limits?: { CPU?: number; Memory?: number } };
    const cpu = task.Limits?.CPU;
    const mem = task.Limits?.Memory;
    if (!cpu || !mem) return null;
    return { vcpu: cpu, memoryBytes: mem * 1024 * 1024, source: 'ecs-metadata' };
  } catch {
    return null;
  }
}

async function getLimits(): Promise<Limits> {
  if (cached) return cached;
  if (resolving) return resolving;

  resolving = (async () => {
    const ecs = await fromEcsMetadata();
    if (ecs) {
      log.info({ vcpu: ecs.vcpu, memoryMb: Math.round(ecs.memoryBytes / 1048576) }, 'Task limits read from ECS metadata');
      cached = ecs;
      return ecs;
    }

    const cg = fromCgroup();
    const fallback: Limits = {
      memoryBytes: cg ?? os.totalmem(),
      // No reliable CPU quota outside ECS; assume the host's cores.
      vcpu: os.cpus().length || 1,
      source: cg ? 'cgroup' : 'host',
    };
    log.info({ source: fallback.source }, 'Task limits resolved without ECS metadata');
    cached = fallback;
    return fallback;
  })();

  return resolving;
}

// ── CPU sampling ──────────────────────────────────────────────────────────────

let prevCpu = process.cpuUsage();
let prevAt = Date.now();

/**
 * CPU used since the previous call, as a percentage of the allocated vCPU.
 * Returns null on the first call and when two calls land too close together
 * for the delta to mean anything.
 */
export async function getCpu(): Promise<CpuInfo> {
  const { vcpu } = await getLimits();
  const now = Date.now();
  const elapsedMs = now - prevAt;

  if (elapsedMs < 500) return { percent: null, vcpu };

  const cur = process.cpuUsage();
  const usedMs = ((cur.user - prevCpu.user) + (cur.system - prevCpu.system)) / 1000;
  prevCpu = cur;
  prevAt = now;

  // usedMs/elapsedMs is share of ONE core; divide by vcpu to get share of the
  // allocation. Clamped because a burst can briefly exceed the quota.
  const percent = Math.min(100, (usedMs / elapsedMs / vcpu) * 100);
  return { percent: Math.round(percent * 10) / 10, vcpu };
}

export async function getMemory(): Promise<MemoryInfo> {
  const { memoryBytes } = await getLimits();
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round(b / 1048576);
  const usedMb = mb(m.rss);
  const limitMb = mb(memoryBytes);
  return {
    usedMb,
    limitMb,
    percent: limitMb > 0 ? Math.round((usedMb / limitMb) * 1000) / 10 : 0,
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
  };
}
