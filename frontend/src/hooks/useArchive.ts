/**
 * useArchive：档案室年度定案的响应式只读视图。
 * 基于三个普查/档案 store 的实时列表，用与导出完全相同的 reconcileReefYear 口径重算，
 * 保证 CoverageView 评定、档案室定案页与 JSON 导出结论三者一致。
 */
import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useVisitStore } from '@/stores/visitStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { reconcileReefYear, type ReefReconcileResult } from '@/utils/reconcile'
import type { ReefFinalization } from '@/types/reefFinalization'

export interface UseArchiveResult {
  /** 已定案年份（降序） */
  finalizedYears: ComputedRef<number[]>
  /** 某年所有礁区的定案对账结果（评定=导出口径） */
  resultsForYear: (year: number | null) => ComputedRef<ReefReconcileResult[]>
  /** 单礁区某年的定案结果（未定案返回 null） */
  resultForReef: (reefId: string, year: number | null) => ComputedRef<ReefReconcileResult | null>
  /** 某年全部对不上条目（汇总单列） */
  mismatchesForYear: (year: number | null) => ComputedRef<ReefReconcileResult['mismatches']>
  /** 某礁区最新定案结果（礁区台账卡片用） */
  latestResultForReef: (reefId: string) => ComputedRef<ReefReconcileResult | null>
}

export function useArchive(): UseArchiveResult {
  const reefStore = useReefStore()
  const beltStore = useBeltStore()
  const surveyStore = useSurveyStore()
  const visitStore = useVisitStore()
  const archiveStore = useArchiveStore()

  const { reefs, sites } = storeToRefs(reefStore)
  const { belts } = storeToRefs(beltStore)
  const { corals, fishes } = storeToRefs(surveyStore)
  const { visits } = storeToRefs(visitStore)
  const { finalizations, finalizedYears } = storeToRefs(archiveStore)

  function compute(fin: ReefFinalization): ReefReconcileResult | null {
    const reef = reefs.value.find((item) => item.id === fin.reefId)
    if (!reef) return null
    return reconcileReefYear({
      reef,
      year: fin.year,
      visitId: fin.visitId,
      visits: visits.value,
      sites: sites.value,
      belts: belts.value,
      corals: corals.value,
      fishes: fishes.value
    })
  }

  function resultsForYear(year: number | null): ComputedRef<ReefReconcileResult[]> {
    return computed(() => {
      if (year === null) return []
      return finalizations.value
        .filter((fin) => fin.year === year)
        .map(compute)
        .filter((result): result is ReefReconcileResult => result !== null)
    })
  }

  function resultForReef(reefId: string, year: number | null): ComputedRef<ReefReconcileResult | null> {
    return computed(() => {
      if (year === null) return null
      const fin = finalizations.value.find((item) => item.reefId === reefId && item.year === year)
      return fin ? compute(fin) : null
    })
  }

  function mismatchesForYear(year: number | null) {
    return computed(() =>
      year === null ? [] : resultsForYear(year).value.flatMap((result) => result.mismatches)
    )
  }

  function latestResultForReef(reefId: string): ComputedRef<ReefReconcileResult | null> {
    return computed(() => {
      const fin = archiveStore.latestFinalizationByReef.get(reefId)
      return fin ? compute(fin) : null
    })
  }

  return {
    finalizedYears,
    resultsForYear,
    resultForReef,
    mismatchesForYear,
    latestResultForReef
  }
}
