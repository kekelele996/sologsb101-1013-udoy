/**
 * 巡次对账与统一评定口径（外业普查组 / 礁区档案室共用）。
 *
 * 两边按「站位编号 + 样带编号」对账。同一编号样带在多次巡访里对不上时：
 *   口径 = 取后一次（调查日期最晚的那次巡访），不取平均；
 *   礁区档案室已定案某年巡次的，一律以定案巡次为准。
 * 覆盖率、白化指数、白化定级、礁区汇总与导出结论全部走 buildCanonicalLines，
 * 保证「评定和导出用同一个口径」。对不上的巡次不丢弃，进 reconcileMismatches 单列；
 * 旧数据补不出巡次的样带进 unassignedBelts 单列。
 *
 * 重要约束：本模块只读数、重算，绝不回退或修改档案室已定案的巡次。
 */
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord, BleachLevel } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Visit, Quarter } from '@/types/visit'
import { QUARTERS } from '@/types/visit'
import type { AnnualFinalization } from '@/types/finalization'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  round
} from '@/utils/bleach'

/** 评定 / 导出唯一口径：取后一次巡访，绝不取平均（礁区已定案时以定案巡次为准） */
export const RESOLUTION_POLICY = {
  id: 'latest-visit',
  label: '取后一次巡访（不做多次平均；礁区已定案时以定案巡次为准）'
} as const

/** 一次评定 / 对账所需的完整数据集合 */
export interface CanonicalDataset {
  reefs: Reef[]
  sites: Site[]
  visits: Visit[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  finalizations: AnnualFinalization[]
}

/** 某条样带的原始量化指标 */
export interface BeltMetrics {
  coralCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

/** 某次巡访里某编号样带的观测（对账表的一列） */
export interface VisitObservation extends BeltMetrics {
  beltId: string
  visitId: string | null
  visitName: string
  surveyDate: string
  observer: string
  lengthM: number
  orientation: string
  /** 是否为后一次巡访 */
  isLatest: boolean
  /** 是否为定案巡访 */
  isFinalized: boolean
}

/** 口径状态：定案一致 / 定案与其他巡访有分歧 / 定案缺测以后一次补 / 多次巡访取后一次 / 单次 */
export type CanonicalStatus =
  | 'finalized-ok'
  | 'finalized-divergent'
  | 'gap-filled'
  | 'latest-wins'
  | 'single'

export const CANONICAL_STATUS_LABEL: Record<CanonicalStatus, string> = {
  'finalized-ok': '定案巡次',
  'finalized-divergent': '定案巡次（与其他巡访不一致，已按定案）',
  'gap-filled': '定案巡次缺测，取后一次巡访补齐',
  'latest-wins': '多次巡访不一致，取后一次',
  single: '单次巡访'
}

/** 评定口径下每个「站位 + 样带编号」的唯一结论行（覆盖率 / 白化 / 导出共用） */
export interface CanonicalLine extends BeltMetrics {
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  beltNo: string
  beltId: string
  visitId: string | null
  visitName: string
  year: number | null
  quarter: Quarter | null
  surveyDate: string
  observer: string
  lengthM: number
  orientation: string
  status: CanonicalStatus
  /** 同编号样带一共出现过几次巡访 */
  visitCount: number
  conclusion: string
}

/** 对账差异行：对不上的巡次单列（不影响定案，只提示外业这侧重跑） */
export interface ReconcileMismatch {
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  beltNo: string
  status: CanonicalStatus
  /** 定案巡次的观测（未定案或定案缺测时为 null） */
  finalized: VisitObservation | null
  /** 后一次巡访的观测 */
  latest: VisitObservation | null
  /** 该编号样带的全部巡访观测，按时间先后 */
  observations: VisitObservation[]
}

/** 礁区年度汇总（按口径行重出） */
export interface CanonicalReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  year: number
  finalizedVisitId: string | null
  finalizedVisitName: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgCoveragePct: number
  avgBleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  fishTotal: number
  mismatchCount: number
}

const EMPTY_DISTRIBUTION = (): Record<BleachLevel, number> => ({ 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 })
const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 计算单条样带的全部量化指标 */
export function computeBeltMetrics(
  belt: Belt,
  corals: CoralRecord[],
  fishes: FishCount[]
): BeltMetrics {
  const coverCmTotal = round(
    corals.reduce((sum, coral) => sum + Math.max(0, coral.coverCm), 0),
    1
  )
  const index = bleachIndex(corals)
  const distribution = EMPTY_DISTRIBUTION()
  BLEACH_LEVELS.forEach((level) => {
    distribution[level] = round(
      corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
  })
  const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
  const invertebrateTotal = fishes
    .filter((fish) => fish.category === '无脊椎动物')
    .reduce((sum, fish) => sum + fish.count, 0)
  return {
    coralCount: corals.length,
    coverCmTotal,
    coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(corals),
    distribution,
    fishTotal,
    invertebrateTotal,
    fishDensity: fishDensity(fishTotal, belt.lengthM)
  }
}

/** 巡次排序键：年份 → 季度 → 调查日期，越晚越大 */
function visitTimeKey(belt: Belt, visit: Visit | undefined, quarter: Quarter | null): number {
  const year = visit?.year ?? 0
  const q = visit ? QUARTERS.indexOf(visit.quarter) : quarter ? QUARTERS.indexOf(quarter) : 0
  const dateMs = Date.parse(`${belt.surveyDate}T00:00:00Z`)
  return year * 10000 + (q + 1) * 100 + (Number.isFinite(dateMs) ? dateMs / 1e10 : 0)
}

/** 组装一次巡访观测列 */
function toObservation(
  belt: Belt,
  metrics: BeltMetrics,
  visit: Visit | undefined,
  isLatest: boolean,
  isFinalized: boolean
): VisitObservation {
  return {
    ...metrics,
    beltId: belt.id,
    visitId: belt.visitId,
    visitName: visit?.name ?? '未挂巡次（待补登）',
    surveyDate: belt.surveyDate,
    observer: belt.observer,
    lengthM: belt.lengthM,
    orientation: belt.orientation,
    isLatest,
    isFinalized
  }
}

/**
 * 按年度构建口径结论行。
 * @param data 全量数据
 * @param year 评定年度（只取该年度巡访；定案巡次若落在该年度也按它）
 */
export function buildCanonicalLines(data: CanonicalDataset, year: number): CanonicalLine[] {
  const { groups, reefById, siteById, visitById, coralsByBelt, fishesByBelt } = groupIndex(data)
  const finalizedByReef = new Map(
    data.finalizations.filter((item) => item.year === year).map((item) => [item.reefId, item])
  )
  const inScopeVisitIds = new Set(data.visits.filter((visit) => visit.year === year).map((visit) => visit.id))

  const lines: CanonicalLine[] = []
  groups.forEach((group) => {
    const site = siteById.get(group.siteId)
    const reef = site ? reefById.get(site.reefId) : undefined
    if (!site || !reef) return
    const finalization = finalizedByReef.get(reef.id)
    const finalizedVisitId = finalization?.visitId ?? null

    // 仅该年度的巡访参与评定（未挂巡次的样带不进口径，走单列）
    const scoped = group.belts.filter(
      (belt) => belt.visitId !== null && inScopeVisitIds.has(belt.visitId)
    )
    if (scoped.length === 0) return

    const annotated = scoped.map((belt) => {
      const visit = belt.visitId ? visitById.get(belt.visitId) : undefined
      return {
        belt,
        visit,
        metrics: computeBeltMetrics(belt, coralsByBelt.get(belt.id) ?? [], fishesByBelt.get(belt.id) ?? [])
      }
    })
    // 后一次：年份 / 季度 / 调查日期最晚
    const latest = annotated.reduce((a, b) =>
      visitTimeKey(b.belt, b.visit, b.visit?.quarter ?? null) >
      visitTimeKey(a.belt, a.visit, a.visit?.quarter ?? null)
        ? b
        : a
    )
    const finalizedEntry = finalizedVisitId
      ? annotated.find((item) => item.belt.visitId === finalizedVisitId)
      : undefined

    const chosen = finalizedEntry ?? latest
    const distinctVisits = new Set(annotated.map((item) => item.belt.visitId)).size
    let status: CanonicalStatus
    if (finalizedEntry) {
      status = distinctVisits > 1 ? 'finalized-divergent' : 'finalized-ok'
    } else if (finalizedVisitId) {
      status = 'gap-filled'
    } else {
      status = distinctVisits > 1 ? 'latest-wins' : 'single'
    }

    const m = chosen.metrics
    lines.push({
      reefId: reef.id,
      reefName: reef.name,
      siteId: site.id,
      siteNo: site.no,
      beltNo: group.beltNo,
      beltId: chosen.belt.id,
      visitId: chosen.belt.visitId,
      visitName: chosen.visit?.name ?? '未挂巡次',
      year: chosen.visit?.year ?? null,
      quarter: chosen.visit?.quarter ?? null,
      surveyDate: chosen.belt.surveyDate,
      observer: chosen.belt.observer,
      lengthM: chosen.belt.lengthM,
      orientation: chosen.belt.orientation,
      status,
      visitCount: distinctVisits,
      ...m,
      conclusion:
        m.coralCount === 0
          ? `该样带（${CANONICAL_STATUS_LABEL[status]}）尚未录入珊瑚记录`
          : m.grade === '无'
            ? `珊瑚覆盖率 ${m.coveragePct}%，未见白化（${CANONICAL_STATUS_LABEL[status]}）`
            : `珊瑚覆盖率 ${m.coveragePct}%，白化指数 ${m.bleachIndex}（${m.grade}），白化占比 ${m.bleachedSharePct}%（${CANONICAL_STATUS_LABEL[status]}）`
    })
  })

  return lines.sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总口径行：定案后礁区覆盖率 / 白化指数按那次重出 */
export function buildCanonicalReefSummaries(
  data: CanonicalDataset,
  year: number,
  lines: CanonicalLine[]
): CanonicalReefSummary[] {
  const visitById = new Map(data.visits.map((visit) => [visit.id, visit]))
  return data.reefs.map((reef) => {
    const finalization = data.finalizations.find((item) => item.reefId === reef.id && item.year === year)
    const reefLines = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      reefLines.length === 0
        ? 0
        : round(
            reefLines.reduce((sum, line) => sum + line.bleachIndex, 0) / reefLines.length,
            2
          )
    const avgCoveragePct =
      reefLines.length === 0
        ? 0
        : round(
            reefLines.reduce((sum, line) => sum + line.coveragePct, 0) / reefLines.length,
            2
          )
    // 白化占比按覆盖长度加权重算（与样带页一致），不做百分比的平均
    const coverTotal = reefLines.reduce((sum, line) => sum + line.coverCmTotal, 0)
    const bleachedCover = reefLines.reduce((sum, line) => {
      const share = line.bleachedSharePct / 100
      return sum + line.coverCmTotal * share
    }, 0)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      year,
      finalizedVisitId: finalization?.visitId ?? null,
      finalizedVisitName: finalization ? visitById.get(finalization.visitId)?.name ?? '（定案巡次已缺失）' : '',
      siteCount: new Set(reefLines.map((line) => line.siteId)).size,
      beltCount: reefLines.length,
      coralCount: reefLines.reduce((sum, line) => sum + line.coralCount, 0),
      coverCmTotal: round(coverTotal, 1),
      avgCoveragePct,
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      bleachedSharePct: coverTotal > 0 ? round((bleachedCover / coverTotal) * 100, 1) : 0,
      fishTotal: reefLines.reduce((sum, line) => sum + line.fishTotal, 0),
      mismatchCount: reefLines.filter(
        (line) => line.status === 'finalized-divergent' || line.status === 'gap-filled' || line.status === 'latest-wins'
      ).length
    }
  })
}

/**
 * 对不上的巡次单列：同一站位 + 样带编号出现多次巡访、或定案巡次缺测。
 * 只出差异清单，供外业普查组这侧重跑；档案室定的巡次不回退。
 */
export function reconcileMismatches(data: CanonicalDataset, year: number): ReconcileMismatch[] {
  const { groups, reefById, siteById, visitById, coralsByBelt, fishesByBelt } = groupIndex(data)
  const finalizedByReef = new Map(
    data.finalizations.filter((item) => item.year === year).map((item) => [item.reefId, item])
  )
  const inScopeVisitIds = new Set(data.visits.filter((visit) => visit.year === year).map((visit) => visit.id))
  const result: ReconcileMismatch[] = []

  groups.forEach((group) => {
    const site = siteById.get(group.siteId)
    const reef = site ? reefById.get(site.reefId) : undefined
    if (!site || !reef) return
    const finalization = finalizedByReef.get(reef.id)
    const finalizedVisitId = finalization?.visitId ?? null
    const scoped = group.belts.filter(
      (belt) => belt.visitId !== null && inScopeVisitIds.has(belt.visitId)
    )
    if (scoped.length === 0) return

    const annotated = scoped.map((belt) => {
      const visit = belt.visitId ? visitById.get(belt.visitId) : undefined
      return {
        belt,
        visit,
        metrics: computeBeltMetrics(belt, coralsByBelt.get(belt.id) ?? [], fishesByBelt.get(belt.id) ?? [])
      }
    })
    const latest = annotated.reduce((a, b) =>
      visitTimeKey(b.belt, b.visit, b.visit?.quarter ?? null) >
      visitTimeKey(a.belt, a.visit, a.visit?.quarter ?? null)
        ? b
        : a
    )
    const finalizedEntry = finalizedVisitId
      ? annotated.find((item) => item.belt.visitId === finalizedVisitId)
      : undefined
    const distinctVisits = new Set(annotated.map((item) => item.belt.visitId)).size

    let status: CanonicalStatus
    if (finalizedEntry) status = distinctVisits > 1 ? 'finalized-divergent' : 'finalized-ok'
    else if (finalizedVisitId) status = 'gap-filled'
    else status = distinctVisits > 1 ? 'latest-wins' : 'single'
    if (status === 'finalized-ok' || status === 'single') return

    const observations = annotated
      .sort(
        (a, b) =>
          visitTimeKey(a.belt, a.visit, a.visit?.quarter ?? null) -
          visitTimeKey(b.belt, b.visit, b.visit?.quarter ?? null)
      )
      .map((item) =>
        toObservation(
          item.belt,
          item.metrics,
          item.visit,
          item.belt.id === latest.belt.id,
          item.belt.visitId === finalizedVisitId
        )
      )

    result.push({
      reefId: reef.id,
      reefName: reef.name,
      siteId: site.id,
      siteNo: site.no,
      beltNo: group.beltNo,
      status,
      finalized: finalizedEntry
        ? toObservation(
            finalizedEntry.belt,
            finalizedEntry.metrics,
            finalizedEntry.visit,
            finalizedEntry.belt.id === latest.belt.id,
            true
          )
        : null,
      latest: toObservation(latest.belt, latest.metrics, latest.visit, true, latest.belt.visitId === finalizedVisitId),
      observations
    })
  })

  return result.sort((a, b) => a.reefName.localeCompare(b.reefName, 'zh-Hans-CN') || a.siteNo.localeCompare(b.siteNo) || a.beltNo.localeCompare(b.beltNo))
}

/** 旧数据补不出巡次的样带（visitId 为 null）：单列，带原始指标 */
export interface UnassignedBeltRow extends BeltMetrics {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
}

export function listUnassignedBelts(data: CanonicalDataset): UnassignedBeltRow[] {
  const siteById = new Map(data.sites.map((site) => [site.id, site]))
  const reefById = new Map(data.reefs.map((reef) => [reef.id, reef]))
  const coralsByBelt = new Map<string, CoralRecord[]>()
  data.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, FishCount[]>()
  data.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })
  return data.belts
    .filter((belt) => belt.visitId === null)
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        ...computeBeltMetrics(belt, coralsByBelt.get(belt.id) ?? [], fishesByBelt.get(belt.id) ?? [])
      }
    })
}

/* ------------------------------- 内部索引 ------------------------------- */

interface BeltGroup {
  reefId: string
  siteId: string
  beltNo: string
  belts: Belt[]
}

function groupIndex(data: CanonicalDataset) {
  const reefById = new Map(data.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(data.sites.map((site) => [site.id, site]))
  const visitById = new Map(data.visits.map((visit) => [visit.id, visit]))
  const coralsByBelt = new Map<string, CoralRecord[]>()
  data.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, FishCount[]>()
  data.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })
  const groupMap = new Map<string, BeltGroup>()
  data.belts.forEach((belt) => {
    const site = siteById.get(belt.siteId)
    if (!site) return
    const key = `${site.reefId}::${site.id}::${belt.no}`
    const group = groupMap.get(key) ?? { reefId: site.reefId, siteId: site.id, beltNo: belt.no, belts: [] }
    group.belts.push(belt)
    groupMap.set(key, group)
  })
  return { groups: groupMap, reefById, siteById, visitById, coralsByBelt, fishesByBelt }
}

/** 可选年度（取巡次年份与定案年份的并集，降序） */
export function availableYears(data: CanonicalDataset): number[] {
  const years = new Set<number>([
    ...data.visits.map((visit) => visit.year),
    ...data.finalizations.map((item) => item.year)
  ])
  return Array.from(years).sort((a, b) => b - a)
}
