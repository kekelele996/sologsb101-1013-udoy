/**
 * 礁区档案室 store。
 * 管礁区与「年度定案巡次」：每个礁区每个年份只定一次，引用外业普查组登记的某条巡次。
 * 定案定下后，礁区覆盖率 / 白化指数 / 导出结论由 utils/reconcile.ts 按那次重出。
 * 定案可改选（重出结论），但永远不会回退或删除普查组的巡访原始记录。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import { finalizationId, type AnnualFinalization, type FinalizationDraft } from '@/types/finalization'
import type { Visit } from '@/types/visit'

export const useArchiveStore = defineStore('archive', () => {
  const finalizations = ref<AnnualFinalization[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<AnnualFinalization>(() => db.finalizations).subscribe((rows) => {
      finalizations.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 某礁区某年的定案（可能没有） */
  function finalizationOf(reefId: string, year: number): AnnualFinalization | null {
    return finalizations.value.find((item) => item.reefId === reefId && item.year === year) ?? null
  }

  /** 某礁区全部年度定案（年份降序） */
  function finalizationsOfReef(reefId: string): AnnualFinalization[] {
    return finalizations.value
      .filter((item) => item.reefId === reefId)
      .sort((a, b) => b.year - a.year)
  }

  /** 某条巡次被哪些定案引用（删巡次提示用） */
  const reefIdsByVisit = computed<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {}
    finalizations.value.forEach((item) => {
      const list = map[item.visitId] ?? []
      list.push(`${item.reefId}@${item.year}`)
      map[item.visitId] = list
    })
    return map
  })

  /**
   * 定案 / 改选定案巡次。同礁区同年幂等 upsert；
   * 只写 finalizations 表，不触碰 visits / belts / corals / fishes。
   */
  async function upsertFinalization(
    payload: FinalizationDraft,
    visits: Visit[]
  ): Promise<AnnualFinalization> {
    const exists = finalizationOf(payload.reefId, payload.year)
    const now = Date.now()
    const row: AnnualFinalization = {
      id: finalizationId(payload.reefId, payload.year),
      reefId: payload.reefId,
      year: payload.year,
      visitId: payload.visitId,
      archivist: payload.archivist.trim(),
      opinion: payload.opinion.trim(),
      finalizedAt: exists ? exists.finalizedAt : now,
      createdAt: exists?.createdAt ?? now,
      updatedAt: now
    }
    // 引用的巡次必须真实存在（档案室只能从外业已登记的巡次里选）
    if (!visits.some((visit) => visit.id === payload.visitId)) {
      throw new Error('所选定案巡次不存在，无法定案')
    }
    await db.finalizations.put(row)
    return row
  }

  /** 撤销某年定案（仅撤销档案室这侧的定案标记，普查组记录原样保留） */
  async function removeFinalization(reefId: string, year: number): Promise<void> {
    await db.finalizations.delete(finalizationId(reefId, year))
  }

  return {
    finalizations,
    ready,
    error,
    reefIdsByVisit,
    start,
    finalizationOf,
    finalizationsOfReef,
    upsertFinalization,
    removeFinalization
  }
})
