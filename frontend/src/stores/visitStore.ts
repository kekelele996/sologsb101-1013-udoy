/**
 * 巡次 store（外业普查组侧）：维护每次重访的巡次台账。
 * 普查组按巡次记样带、珊瑚记录与鱼类计数；原始记录一律保留，不因档案室定案而改动。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Quarter, Visit, VisitDraft, VisitKind } from '@/types/visit'
import { createEmptyVisitDraft, quarterLabel, visitCode } from '@/types/visit'

export const useVisitStore = defineStore('visit', () => {
  const visits = ref<Visit[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const draft = ref<VisitDraft>(createEmptyVisitDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Visit>(() => db.visits).subscribe((rows) => {
      visits.value = rows
      ready.value = true
      error.value = null
    })
  }

  const visitById = computed(() => new Map(visits.value.map((visit) => [visit.id, visit])))

  function getVisit(id: string | null | undefined): Visit | null {
    if (!id) return null
    return visitById.value.get(id) ?? null
  }

  /** 巡次代码（取不到时给占位，避免界面空白） */
  function codeOf(id: string | null | undefined): string {
    return getVisit(id)?.code ?? '未归档'
  }

  /** 全部巡次按年份、季度排序（补登沉底） */
  const sortedVisits = computed<Visit[]>(() =>
    [...visits.value].sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year
      if (a.quarter !== b.quarter) return b.quarter - a.quarter
      if (a.kind !== b.kind) return a.kind === '补登' ? 1 : -1
      return a.code.localeCompare(b.code, 'zh-Hans-CN')
    })
  )

  /** 某年份的巡次（供档案室选择定案巡次） */
  function visitsOfYear(year: number): Visit[] {
    return sortedVisits.value.filter((visit) => visit.year === year && visit.kind === '常规')
  }

  /** 现有数据覆盖的年份（降序） */
  const availableYears = computed<number[]>(() => {
    const years = new Set(visits.value.map((visit) => visit.year))
    return Array.from(years).sort((a, b) => b - a)
  })

  /** 巡次是否已被样带引用（删除前校验） */
  async function isVisitUsed(id: string): Promise<boolean> {
    return (await db.belts.where('visitId').equals(id).count()) > 0
  }

  function resetDraft(): void {
    draft.value = createEmptyVisitDraft()
  }

  async function createVisit(payload: VisitDraft, kind: VisitKind = '常规'): Promise<Visit> {
    const now = Date.now()
    const code = visitCode(payload.year, payload.quarter as Quarter, kind)
    const existing = visits.value.find((visit) => visit.code === code)
    if (existing) return existing
    const row: Visit = {
      id: createId('visit'),
      year: payload.year,
      quarter: payload.quarter as Quarter,
      code,
      kind,
      startedOn: payload.startedOn,
      note: payload.note.trim(),
      createdAt: now,
      updatedAt: now
    }
    await db.visits.put(row)
    return row
  }

  async function updateVisit(id: string, patch: Partial<Omit<Visit, 'id' | 'kind'>>): Promise<void> {
    const current = visitById.value.get(id)
    const year = patch.year ?? current?.year
    const quarter = patch.quarter ?? current?.quarter
    const nextPatch: Partial<Visit> = { ...patch, updatedAt: Date.now() }
    if (current && year !== undefined && quarter !== undefined) {
      nextPatch.code = visitCode(year, quarter as Quarter, current.kind)
    }
    await db.visits.update(id, nextPatch as never)
  }

  async function removeVisit(id: string): Promise<void> {
    // 普查组删巡次：仅删空巡次；有样带的巡次不允许删除（避免把记录变成孤儿）
    const used = await isVisitUsed(id)
    if (used) throw new Error('该巡次下仍有样带，不能删除；请先处理样带')
    await db.visits.delete(id)
  }

  return {
    visits,
    ready,
    error,
    draft,
    sortedVisits,
    availableYears,
    start,
    getVisit,
    codeOf,
    visitsOfYear,
    isVisitUsed,
    resetDraft,
    createVisit,
    updateVisit,
    removeVisit,
    quarterLabel
  }
})
