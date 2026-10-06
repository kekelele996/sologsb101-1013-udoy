/**
 * 样带 store（外业普查组侧）：维护样带布设草稿、朝向排序与站位下的样带列表。
 * 样带按巡次（visitId）隔离：同编号样带在不同巡次里各是一条，
 * 列表与冲突校验默认按「当前巡次 + 站位」范围，覆盖率/白化指数不跨巡次混算。
 * 样带按朝向顺序（北→东→南→西）再按编号排序，便于外业按方向逐条普查。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Belt, BeltDraft, Orientation } from '@/types/belt'
import { ORIENTATIONS, createEmptyBeltDraft } from '@/types/belt'

/** 朝向排序权重：北 → 东 → 南 → 西 */
export const ORIENTATION_ORDER: Record<Orientation, number> = {
  北: 0,
  东: 1,
  南: 2,
  西: 3
}

export const useBeltStore = defineStore('belt', () => {
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentBeltId = ref<string | null>(null)
  /** 当前外业正在录入的巡次（样带布设页选择，决定新增样带挂到哪次重访） */
  const currentVisitId = ref<string | null>(null)
  const draft = ref<BeltDraft>(createEmptyBeltDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
      ready.value = true
      error.value = null
    })
  }

  function selectVisit(visitId: string | null): void {
    currentVisitId.value = visitId
  }

  /**
   * 某站位下的样带（普查组按巡次记）：
   * 传 visitId 时只看该次重访；不传时返回该站位全部巡次的样带（跨巡次对照用）。
   * 先按朝向（北→东→南→西）再按编号、调查日期排序。
   */
  function beltsOfSite(siteId: string | null | undefined, visitId?: string | null): Belt[] {
    if (!siteId) return []
    return belts.value
      .filter((belt) => belt.siteId === siteId)
      .filter((belt) => (visitId ? belt.visitId === visitId : true))
      .sort((a, b) => {
        const orderDiff = ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
        if (orderDiff !== 0) return orderDiff
        const noDiff = a.no.localeCompare(b.no, 'zh-Hans-CN')
        if (noDiff !== 0) return noDiff
        return a.surveyDate.localeCompare(b.surveyDate)
      })
  }

  const currentBelt = computed<Belt | null>(
    () => belts.value.find((belt) => belt.id === currentBeltId.value) ?? null
  )

  /** 站位 id → 样带数与总长度（全部巡次合计） */
  const siteBeltStats = computed<Record<string, { count: number; totalLengthM: number }>>(() => {
    const stats: Record<string, { count: number; totalLengthM: number }> = {}
    belts.value.forEach((belt) => {
      const bucket = stats[belt.siteId] ?? { count: 0, totalLengthM: 0 }
      bucket.count += 1
      bucket.totalLengthM += belt.lengthM
      stats[belt.siteId] = bucket
    })
    return stats
  })

  /** 朝向分布统计（按样带条数） */
  const orientationStats = computed<Record<Orientation, number>>(() => {
    const stats: Record<Orientation, number> = { 北: 0, 东: 0, 南: 0, 西: 0 }
    belts.value.forEach((belt) => {
      stats[belt.orientation] += 1
    })
    return stats
  })

  /**
   * 朝向 + 编号排序校验：同一巡次同一站位内「朝向 + 编号」重复时返回提示。
   * 跨巡次的同编号样带不算冲突（本就是不同次重访）。
   */
  function findBeltConflicts(siteId: string | null | undefined, visitId?: string | null): string[] {
    if (!siteId) return []
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    beltsOfSite(siteId, visitId).forEach((belt) => {
      const key = `${belt.orientation}-${belt.no}`
      if (seen.has(key)) conflicts.push(`${belt.orientation}向 ${belt.no}`)
      else seen.set(key, belt.id)
    })
    return conflicts
  }

  function resetDraft(no = ''): void {
    draft.value = createEmptyBeltDraft(no)
  }

  function selectBelt(id: string | null): void {
    currentBeltId.value = id
  }

  function beltById(id: string | null | undefined): Belt | null {
    if (!id) return null
    return belts.value.find((belt) => belt.id === id) ?? null
  }

  async function createBelt(
    siteId: string,
    visitId: string,
    payload: Omit<Belt, 'id' | 'createdAt' | 'updatedAt' | 'siteId' | 'visitId'>
  ): Promise<Belt> {
    const now = Date.now()
    const row: Belt = { ...payload, siteId, visitId, id: createId('belt'), createdAt: now, updatedAt: now }
    await db.belts.put(row)
    return row
  }

  async function updateBelt(id: string, patch: Partial<Belt>): Promise<void> {
    await db.belts.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除样带：级联删除其珊瑚记录与鱼类计数（只动普查侧该次记录） */
  async function removeBelt(id: string): Promise<void> {
    await db.transaction('rw', [db.belts, db.corals, db.fishes], async () => {
      await db.corals.where('beltId').equals(id).delete()
      await db.fishes.where('beltId').equals(id).delete()
      await db.belts.delete(id)
    })
    if (currentBeltId.value === id) selectBelt(null)
  }

  /** 批量改写朝向（同站位同巡次多条样带统一方向） */
  async function bulkSetOrientation(ids: string[], orientation: Orientation): Promise<number> {
    const now = Date.now()
    await db.belts
      .where('id')
      .anyOf(ids)
      .modify((belt) => {
        belt.orientation = orientation
        belt.updatedAt = now
      })
    return ids.length
  }

  return {
    belts,
    ready,
    error,
    currentBeltId,
    currentBelt,
    currentVisitId,
    draft,
    siteBeltStats,
    orientationStats,
    start,
    selectVisit,
    beltsOfSite,
    findBeltConflicts,
    resetDraft,
    selectBelt,
    beltById,
    createBelt,
    updateBelt,
    removeBelt,
    bulkSetOrientation,
    orientations: ORIENTATIONS
  }
})
