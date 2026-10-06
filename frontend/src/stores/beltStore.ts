/**
 * 样带 store：维护样带布设草稿、朝向排序与站位下的样带列表。
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

  /** 某站位下的样带：先按朝向（北→东→南→西）再按编号排序（含全部巡次） */
  function beltsOfSite(siteId: string | null | undefined): Belt[] {
    if (!siteId) return []
    return belts.value
      .filter((belt) => belt.siteId === siteId)
      .sort((a, b) => {
        const orderDiff = ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
        if (orderDiff !== 0) return orderDiff
        return a.no.localeCompare(b.no, 'zh-Hans-CN')
      })
  }

  /** 某站位某次巡访下的样带（重访时同编号样带各属各的巡次，互不冲突） */
  function beltsOfSiteVisit(siteId: string | null | undefined, visitId: string | null): Belt[] {
    return beltsOfSite(siteId).filter((belt) => belt.visitId === visitId)
  }

  const currentBelt = computed<Belt | null>(
    () => belts.value.find((belt) => belt.id === currentBeltId.value) ?? null
  )

  /** 站位 id → 样带数与总长度（全部巡次） */
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
   * 朝向 + 编号重复校验：同一站位「同一次巡访」内不可重复；
   * 不同巡次（重访）允许同编号样带并存。
   */
  function findBeltConflicts(siteId: string | null | undefined, visitId?: string | null): string[] {
    if (!siteId) return []
    const scope = beltsOfSite(siteId).filter((belt) =>
      visitId === undefined ? true : belt.visitId === visitId
    )
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    scope.forEach((belt) => {
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
    payload: Omit<Belt, 'id' | 'createdAt' | 'updatedAt' | 'siteId'>
  ): Promise<Belt> {
    const now = Date.now()
    const row: Belt = { ...payload, siteId, id: createId('belt'), createdAt: now, updatedAt: now }
    await db.belts.put(row)
    return row
  }

  async function updateBelt(id: string, patch: Partial<Belt>): Promise<void> {
    await db.belts.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除样带：级联删除其珊瑚记录与鱼类计数 */
  async function removeBelt(id: string): Promise<void> {
    await db.transaction('rw', [db.belts, db.corals, db.fishes], async () => {
      await db.corals.where('beltId').equals(id).delete()
      await db.fishes.where('beltId').equals(id).delete()
      await db.belts.delete(id)
    })
    if (currentBeltId.value === id) selectBelt(null)
  }

  /** 批量改写朝向（同站位多条样带统一方向） */
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
    draft,
    siteBeltStats,
    orientationStats,
    start,
    beltsOfSite,
    beltsOfSiteVisit,
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
