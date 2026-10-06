/**
 * 巡次 store（外业普查组侧）。
 * 登记 / 维护每一次季度巡访；样带、珊瑚记录、鱼类计数都挂在具体巡次上，
 * 同一站位重访时同编号样带在不同巡次各是一条，互不混算。
 * 礁区档案室只读这些巡次去做年度定案，不会经本 store 回退或改动任何记录。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db, watchTable } from '@/utils/db'
import type { Quarter, Visit, VisitDraft } from '@/types/visit'
import { currentYear, defaultVisitName, quarterOfDate, yearOfDate } from '@/types/visit'
import type { Belt } from '@/types/belt'

export const useVisitStore = defineStore('visit', () => {
  const visits = ref<Visit[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Visit>(() => db.visits).subscribe((rows) => {
      visits.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  function visitById(id: string | null | undefined): Visit | null {
    if (!id) return null
    return visits.value.find((visit) => visit.id === id) ?? null
  }

  /** 某礁区的全部巡访（年份、季度降序，后一次在前） */
  function visitsOfReef(reefId: string | null | undefined): Visit[] {
    if (!reefId) return []
    return visits.value
      .filter((visit) => visit.reefId === reefId)
      .sort((a, b) => b.year - a.year || a.quarter.localeCompare(b.quarter))
  }

  /** 某礁区某年的巡访 */
  function visitsOfReefYear(reefId: string | null | undefined, year: number): Visit[] {
    return visitsOfReef(reefId).filter((visit) => visit.year === year)
  }

  /** 巡次 id → 样带数 */
  const beltCountByVisit = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    belts.value.forEach((belt) => {
      if (belt.visitId) counts[belt.visitId] = (counts[belt.visitId] ?? 0) + 1
    })
    return counts
  })

  /** 补不出巡次的样带数（visitId 为 null） */
  const unassignedBeltCount = computed(() => belts.value.filter((belt) => belt.visitId === null).length)

  /** 同礁区同年同季度不可重复登记 */
  function findVisitConflict(reefId: string, year: number, quarter: Quarter, exceptId?: string | null): Visit | null {
    return (
      visits.value.find(
        (visit) =>
          visit.reefId === reefId &&
          visit.year === year &&
          visit.quarter === quarter &&
          visit.id !== (exceptId ?? null)
      ) ?? null
    )
  }

  async function createVisit(payload: VisitDraft): Promise<Visit> {
    const now = Date.now()
    const row: Visit = {
      id: createId('visit'),
      reefId: payload.reefId,
      year: payload.year,
      quarter: payload.quarter,
      name: payload.name.trim() || defaultVisitName(payload.year, payload.quarter),
      leader: payload.leader.trim(),
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now
    }
    await db.visits.put(row)
    return row
  }

  async function updateVisit(id: string, patch: Partial<Omit<Visit, 'id' | 'reefId'>>): Promise<void> {
    await db.visits.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /**
   * 删除巡次：其下样带、珊瑚、鱼类记录一并删除。
   * 注意：档案室若已用该巡次定案，删除只在普查组这侧生效，定案记录不回退（会标「定案巡次已缺失」）。
   */
  async function removeVisit(id: string): Promise<void> {
    await db.transaction('rw', [db.visits, db.belts, db.corals, db.fishes], async () => {
      const beltIds = (await db.belts.where('visitId').equals(id).toArray()).map((belt) => belt.id)
      if (beltIds.length > 0) {
        await db.corals.where('beltId').anyOf(beltIds).delete()
        await db.fishes.where('beltId').anyOf(beltIds).delete()
        await db.belts.where('visitId').equals(id).delete()
      }
      await db.visits.delete(id)
    })
  }

  /** 把补登的样带挂到指定巡次（旧数据补不出时人工补登） */
  async function assignBeltToVisit(beltId: string, visitId: string | null): Promise<void> {
    await db.belts.update(beltId, { visitId, updatedAt: Date.now() } as never)
  }

  /** 按调查日期推断应归入的巡次（同礁区同年同季度），找不到返回 null */
  function inferVisitForBelt(belt: Belt, reefId: string): Visit | null {
    const year = yearOfDate(belt.surveyDate)
    const quarter = quarterOfDate(belt.surveyDate)
    if (year === null || quarter === null) return null
    return (
      visits.value.find((visit) => visit.reefId === reefId && visit.year === year && visit.quarter === quarter) ?? null
    )
  }

  return {
    visits,
    belts,
    ready,
    error,
    beltCountByVisit,
    unassignedBeltCount,
    start,
    visitById,
    visitsOfReef,
    visitsOfReefYear,
    findVisitConflict,
    createVisit,
    updateVisit,
    removeVisit,
    assignBeltToVisit,
    inferVisitForBelt,
    currentYear
  }
})
