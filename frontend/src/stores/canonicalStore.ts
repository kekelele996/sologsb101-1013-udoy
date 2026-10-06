/**
 * 评定口径 store（只读派生）。
 * 汇总七张表，按选定年度用 utils/reconcile.ts 的唯一口径产出：
 * 口径结论行、礁区年度汇总、对账差异、未挂巡次样带。
 * 档案室定案页与覆盖度 / 导出页都从这里取数，保证评定与导出永远同一口径。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Visit } from '@/types/visit'
import type { AnnualFinalization } from '@/types/finalization'
import {
  availableYears,
  buildCanonicalLines,
  buildCanonicalReefSummaries,
  listUnassignedBelts,
  reconcileMismatches,
  type CanonicalDataset,
  type CanonicalLine,
  type CanonicalReefSummary,
  type ReconcileMismatch,
  type UnassignedBeltRow
} from '@/utils/reconcile'

export const useCanonicalStore = defineStore('canonical', () => {
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const visits = ref<Visit[]>([])
  const finalizations = ref<AnnualFinalization[]>([])
  const belts = ref<Belt[]>([])
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const ready = ref(false)

  /** 评定年度（默认最近一个有巡访 / 定案的年度） */
  const year = ref<number>(new Date().getFullYear())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Reef>(() => db.reefs).subscribe((rows) => (reefs.value = rows))
    watchTable<Site>(() => db.sites).subscribe((rows) => (sites.value = rows))
    watchTable<Visit>(() => db.visits).subscribe((rows) => (visits.value = rows))
    watchTable<AnnualFinalization>(() => db.finalizations).subscribe((rows) => (finalizations.value = rows))
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
      ready.value = true
      const years = availableYears(dataset.value)
      if (years.length > 0 && !years.includes(year.value)) year.value = years[0]
    })
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => (corals.value = rows))
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => (fishes.value = rows))
  }

  const dataset = computed<CanonicalDataset>(() => ({
    reefs: reefs.value,
    sites: sites.value,
    visits: visits.value,
    finalizations: finalizations.value,
    belts: belts.value,
    corals: corals.value,
    fishes: fishes.value
  }))

  const years = computed<number[]>(() => availableYears(dataset.value))

  function selectYear(next: number): void {
    year.value = next
  }

  /** 口径结论行（评定 / 导出共用） */
  const lines = computed<CanonicalLine[]>(() => buildCanonicalLines(dataset.value, year.value))

  /** 礁区年度汇总（定案后按那次重出） */
  const reefSummaries = computed<CanonicalReefSummary[]>(() =>
    buildCanonicalReefSummaries(dataset.value, year.value, lines.value)
  )

  /** 对不上的巡次（单列，不回退定案） */
  const mismatches = computed<ReconcileMismatch[]>(() => reconcileMismatches(dataset.value, year.value))

  /** 补不出巡次的旧样带（单列） */
  const unassignedBelts = computed<UnassignedBeltRow[]>(() => listUnassignedBelts(dataset.value))

  /** 指定礁区的口径结论行 */
  function linesOfReef(reefId: string): CanonicalLine[] {
    return lines.value.filter((line) => line.reefId === reefId)
  }

  return {
    ready,
    year,
    years,
    dataset,
    lines,
    reefSummaries,
    mismatches,
    unassignedBelts,
    start,
    selectYear,
    linesOfReef
  }
})
