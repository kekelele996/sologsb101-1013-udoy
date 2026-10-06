/**
 * 档案室 store：管礁区「年度定案巡次」与对账记录。
 * - 定下定案后，礁区覆盖率 / 白化指数 / 导出结论按那次重出（走 utils/reconcile 纯函数）；
 * - 对账只读取普查侧（巡次/样带/珊瑚/鱼类）重算并落一条 ReconciliationRun；
 * - 对账失败时只重跑普查侧这一侧，档案室定的巡次不回退（重跑不更新 finalization）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { ReefFinalization, FinalizationDraft } from '@/types/reefFinalization'
import { finalizationId } from '@/types/reefFinalization'
import type { MismatchItem, ReconciliationRun } from '@/types/reconciliation'
import { reconcileReefYear, RECONCILE_POLICY, type ReefReconcileResult } from '@/utils/reconcile'

export const useArchiveStore = defineStore('archive', () => {
  const finalizations = ref<ReefFinalization[]>([])
  const runs = ref<ReconciliationRun[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<ReefFinalization>(() => db.finalizations).subscribe((rows) => {
      finalizations.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<ReconciliationRun>(() => db.reconciliations).subscribe((rows) => {
      runs.value = rows
    })
  }

  const finalizedYears = computed<number[]>(() => {
    const years = new Set(finalizations.value.map((fin) => fin.year))
    return Array.from(years).sort((a, b) => b - a)
  })

  /** 最新已定案年份（没有定案返回 null） */
  const latestYear = computed<number | null>(() => finalizedYears.value[0] ?? null)

  function finalizationOf(reefId: string, year: number): ReefFinalization | null {
    return finalizations.value.find((fin) => fin.reefId === reefId && fin.year === year) ?? null
  }

  /** 每礁区最新定案（礁区台账卡片用） */
  const latestFinalizationByReef = computed<Map<string, ReefFinalization>>(() => {
    const map = new Map<string, ReefFinalization>()
    finalizations.value
      .slice()
      .sort((a, b) => b.year - a.year)
      .forEach((fin) => {
        if (!map.has(fin.reefId)) map.set(fin.reefId, fin)
      })
    return map
  })

  function runsOf(finalizationKeyValue: string): ReconciliationRun[] {
    return runs.value
      .filter((run) => run.finalizationId === finalizationKeyValue)
      .sort((a, b) => b.runAt - a.runAt)
  }

  /**
   * 重跑普查侧对账：按定案巡次重新读取普查数据计算，落一条新的对账记录。
   * 绝不修改 ReefFinalization —— 档案室定的巡次不回退。
   */
  async function rerunReconciliation(fin: ReefFinalization): Promise<ReconciliationRun> {
    const [reefs, sites, visits, belts, corals, fishes] = await Promise.all([
      db.reefs.toArray(),
      db.sites.toArray(),
      db.visits.toArray(),
      db.belts.toArray(),
      db.corals.toArray(),
      db.fishes.toArray()
    ])
    const reef = reefs.find((item) => item.id === fin.reefId)
    if (!reef) throw new Error('定案所属礁区不存在，无法对账')
    const result = reconcileReefYear({
      reef,
      year: fin.year,
      visitId: fin.visitId,
      visits,
      sites,
      belts,
      corals,
      fishes
    })
    const run: ReconciliationRun = {
      id: createId('rec'),
      finalizationId: fin.id,
      reefId: fin.reefId,
      year: fin.year,
      visitId: fin.visitId,
      quarter: fin.quarter,
      policy: RECONCILE_POLICY,
      resolvedBeltCount: result.lines.length,
      mismatchCount: result.mismatches.length,
      status: result.status,
      mismatches: result.mismatches,
      runAt: Date.now()
    }
    await db.reconciliations.put(run)
    return run
  }

  /** 直接计算对账结果（不落库），供评定页与导出共用 */
  async function computeReconciliation(fin: ReefFinalization): Promise<ReefReconcileResult> {
    const [reefs, sites, visits, belts, corals, fishes] = await Promise.all([
      db.reefs.toArray(),
      db.sites.toArray(),
      db.visits.toArray(),
      db.belts.toArray(),
      db.corals.toArray(),
      db.fishes.toArray()
    ])
    const reef = reefs.find((item) => item.id === fin.reefId)
    if (!reef) throw new Error('定案所属礁区不存在')
    return reconcileReefYear({
      reef,
      year: fin.year,
      visitId: fin.visitId,
      visits,
      sites,
      belts,
      corals,
      fishes
    })
  }

  /** 档案室定下 / 改定年度巡次，并立即跑一次普查侧对账 */
  async function decideFinalization(draft: FinalizationDraft): Promise<{ fin: ReefFinalization; run: ReconciliationRun }> {
    const now = Date.now()
    const visit = await db.visits.get(draft.visitId)
    if (!visit) throw new Error('所选巡次不存在')
    const id = finalizationId(draft.reefId, draft.year)
    const existing = await db.finalizations.get(id)
    const fin: ReefFinalization = {
      id,
      reefId: draft.reefId,
      year: draft.year,
      visitId: draft.visitId,
      quarter: visit.quarter,
      decidedBy: draft.decidedBy.trim(),
      note: draft.note.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await db.finalizations.put(fin)
    const run = await rerunReconciliation(fin)
    return { fin, run }
  }

  /**
   * 仅重跑对账（对账失败后普查组补录数据，档案室重新核对）。
   * 不改定案巡次，体现“档案室定的巡次不回退”。
   */
  async function rerunById(finalizationKeyValue: string): Promise<ReconciliationRun> {
    const fin = await db.finalizations.get(finalizationKeyValue)
    if (!fin) throw new Error('定案记录不存在')
    return rerunReconciliation(fin)
  }

  async function removeFinalization(finalizationKeyValue: string): Promise<void> {
    await db.transaction('rw', [db.finalizations, db.reconciliations], async () => {
      await db.reconciliations.where('finalizationId').equals(finalizationKeyValue).delete()
      await db.finalizations.delete(finalizationKeyValue)
    })
  }

  /** 汇总某年全部对不上条目（评定页单列区用） */
  function mismatchesOfYear(year: number): Array<{ finId: string; run: ReconciliationRun; mismatches: MismatchItem[] }> {
    return finalizations.value
      .filter((fin) => fin.year === year)
      .map((fin) => {
        const [run] = runsOf(fin.id)
        return run ? { finId: fin.id, run, mismatches: run.mismatches } : null
      })
      .filter((item): item is { finId: string; run: ReconciliationRun; mismatches: MismatchItem[] } => item !== null)
  }

  return {
    finalizations,
    runs,
    ready,
    error,
    finalizedYears,
    latestYear,
    start,
    finalizationOf,
    latestFinalizationByReef,
    runsOf,
    mismatchesOfYear,
    decideFinalization,
    computeReconciliation,
    rerunReconciliation,
    rerunById,
    removeFinalization
  }
})
