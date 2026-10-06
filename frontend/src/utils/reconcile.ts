/**
 * 定案对账（档案室口径核心）：
 *
 * 普查组按「巡次」保留每次重访的样带 / 珊瑚记录 / 鱼类计数，原始数据永不改动；
 * 档案室为「礁区 + 年份」选定一条定案巡次后，覆盖率、白化指数与导出结论
 * 统一由本模块按同一份对账结果重出。
 *
 * 口径（评定与导出共用，见 RECONCILE_POLICY）：
 * 1. 站位编号 + 样带编号对得上的样带：一律以【定案巡次】那次为准（定案覆盖），
 *    不取平均、不混入其他巡次；
 * 2. 定案巡次缺号、但同年其他常规巡次里有同编号样带的：取【后一次巡访】
 *    （调查日期最晚，日期相同取季度更新者）跨巡次补位，仍不取平均；
 * 3. 与定案巡次零交集的整条巡次、挂在补登巡次下的样带、缺失站位编号或
 *    定案巡次内编号重复的：一律【单列】为对不上条目，不参与评定与导出；
 * 4. 对账只读取普查侧重算。对账失败时只重跑普查侧，档案室定案不回退。
 */
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord, BleachLevel } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Visit, Quarter } from '@/types/visit'
import type { MismatchItem, MismatchKind, ReconciliationStatus } from '@/types/reconciliation'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  round
} from '@/utils/bleach'

/** 评定与导出共用的口径说明 */
export const RECONCILE_POLICY =
  '同编号取定案巡次那次覆盖，不平均；定案缺号时取同年后一次巡访补位，仍不平均；整巡次零交集、补登未归位、站位缺失、编号重复者单列，不参与评定与导出。'

/** 样带来源：定案覆盖 / 跨巡次补位 / 补登补位（补登补位不参与评定，仅占位展示） */
export type ResolvedSource = '定案覆盖' | '跨巡次补位'

export interface ReconcileInput {
  reef: Reef
  year: number
  /** 档案室定下的巡次 id */
  visitId: string
  visits: Visit[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
}

/** 纳入定案评定的一条样带成果 */
export interface ResolvedBeltLine {
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  visitId: string
  visitCode: string
  source: ResolvedSource
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndexValue: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensityValue: number
}

/** 礁区某年度定案的汇总评定 */
export interface ReefReefSummary {
  reefId: string
  year: number
  visitId: string
  visitCode: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgCoveragePct: number
  avgBleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  fishTotal: number
  invertebrateTotal: number
  fishDensityValue: number
  distribution: Record<BleachLevel, number>
}

export interface ReefReconcileResult {
  reefId: string
  year: number
  visitId: string
  visitCode: string
  quarter: Quarter | null
  policy: string
  status: ReconciliationStatus
  lines: ResolvedBeltLine[]
  mismatches: MismatchItem[]
  summary: ReefReefSummary
}

/** 对账用样带键：站位编号 + 样带编号（展示与对账同一口径） */
function beltKey(siteNo: string, beltNo: string): string {
  return `${siteNo}::${beltNo}`
}

interface BeltWithContext {
  belt: Belt
  visit: Visit | null
  site: Site | null
}

/** 评定单条样带（覆盖率 / 白化指数 / 分布 / 鱼类密度） */
function buildLine(
  ctx: BeltWithContext,
  corals: CoralRecord[],
  fishes: FishCount[],
  source: ResolvedSource
): ResolvedBeltLine {
  const { belt, visit, site } = ctx
  const beltCorals = corals.filter((coral) => coral.beltId === belt.id)
  const beltFishes = fishes.filter((fish) => fish.beltId === belt.id)
  const coverCmTotal = round(
    beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
    1
  )
  const index = bleachIndex(beltCorals)
  const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    distribution[level] = round(
      beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
  })
  const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
  const invertebrateTotal = beltFishes
    .filter((fish) => fish.category === '无脊椎动物')
    .reduce((sum, fish) => sum + fish.count, 0)
  return {
    beltId: belt.id,
    beltNo: belt.no,
    siteId: site?.id ?? belt.siteId,
    siteNo: site?.no ?? '—',
    visitId: visit?.id ?? '',
    visitCode: visit?.code ?? '未归档',
    source,
    lengthM: belt.lengthM,
    orientation: belt.orientation,
    surveyDate: belt.surveyDate,
    observer: belt.observer,
    coralCount: beltCorals.length,
    coverCmTotal,
    coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
    bleachIndexValue: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(beltCorals),
    distribution,
    fishTotal,
    invertebrateTotal,
    fishDensityValue: fishDensity(fishTotal, belt.lengthM)
  }
}

function mismatch(
  kind: MismatchKind,
  ctx: Partial<{ visit: Visit | null; site: Site | null; belt: Belt }>,
  detail: string
): MismatchItem {
  return {
    kind,
    visitId: ctx.visit?.id ?? '',
    visitCode: ctx.visit?.code ?? '未归档',
    siteId: ctx.site?.id ?? ctx.belt?.siteId ?? '',
    siteNo: ctx.site?.no ?? '—',
    beltId: ctx.belt?.id ?? '',
    beltNo: ctx.belt?.no ?? '整巡次',
    detail
  }
}

/** 取后一次：调查日期最晚；日期相同取季度更新；再相同取 updatedAt 更晚 */
function laterBelt(a: BeltWithContext, b: BeltWithContext): BeltWithContext {
  const da = a.belt.surveyDate
  const db = b.belt.surveyDate
  if (da !== db) return da > db ? a : b
  const qa = a.visit?.quarter ?? 0
  const qb = b.visit?.quarter ?? 0
  if (qa !== qb) return qa > qb ? a : b
  return a.belt.updatedAt >= b.belt.updatedAt ? a : b
}

/**
 * 对某礁区某年度的定案执行对账，产出评定样带行与对不上条目。
 * 纯函数：不改任何入参数据，调用方负责落库 / 展示 / 导出。
 */
export function reconcileReefYear(input: ReconcileInput): ReefReconcileResult {
  const { reef, year, visitId, visits, sites, belts, corals, fishes } = input
  const visitById = new Map(visits.map((visit) => [visit.id, visit]))
  const chosenVisit = visitById.get(visitId) ?? null
  const reefSiteIds = new Set(sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
  const siteById = new Map(sites.map((site) => [site.id, site]))

  const mismatches: MismatchItem[] = []

  // 归属本礁区站位的全部样带，并挂上巡次 / 站位上下文
  const reefContexts: BeltWithContext[] = []
  belts
    .filter((belt) => reefSiteIds.has(belt.siteId))
    .forEach((belt) => {
      reefContexts.push({
        belt,
        visit: visitById.get(belt.visitId) ?? null,
        site: siteById.get(belt.siteId) ?? null
      })
    })

  // 站位编号对不上：样带挂在一个属于该礁区、但台账中查不到的站位（数据残缺兜底）；
  // 其他礁区的站位/样带不在本礁区对账范围内，直接忽略。
  belts
    .filter((belt) => {
      if (reefSiteIds.has(belt.siteId)) return false
      const site = siteById.get(belt.siteId)
      return site !== undefined && site.reefId === reef.id
    })
    .forEach((belt) => {
      const ctx: BeltWithContext = { belt, visit: visitById.get(belt.visitId) ?? null, site: siteById.get(belt.siteId) ?? null }
      mismatches.push(mismatch('站位编号对不上', ctx, `样带 ${belt.no} 的站位在礁区「${reef.name}」台账中缺失`))
    })

  const chosenContexts = reefContexts.filter((ctx) => ctx.belt.visitId === visitId)
  const chosenKeys = new Set(chosenContexts.map((ctx) => beltKey(ctx.site?.no ?? '', ctx.belt.no)))

  // 定案巡次内站位编号 + 样带编号重复：除「后一次」外全部单列
  const chosenByKey = new Map<string, BeltWithContext>()
  chosenContexts.forEach((ctx) => {
    const key = beltKey(ctx.site?.no ?? '', ctx.belt.no)
    const existing = chosenByKey.get(key)
    if (!existing) {
      chosenByKey.set(key, ctx)
      return
    }
    const winner = laterBelt(existing, ctx)
    const loser = winner === existing ? ctx : existing
    chosenByKey.set(key, winner)
    mismatches.push(
      mismatch(
        '定案编号重复',
        loser,
        `定案巡次 ${chosenVisit?.code ?? ''} 内站位 ${loser.site?.no ?? '—'} 样带 ${loser.belt.no} 重复，已取后一次（${winner.belt.surveyDate}），本条单列`
      )
    )
  })

  // 同年其他常规巡次：按巡次判断与定案巡次是否有编号交集
  const otherVisitIds = new Set(
    visits
      .filter((visit) => visit.year === year && visit.kind === '常规' && visit.id !== visitId)
      .map((visit) => visit.id)
  )
  const otherByVisit = new Map<string, BeltWithContext[]>()
  reefContexts
    .filter((ctx) => ctx.visit && otherVisitIds.has(ctx.visit.id))
    .forEach((ctx) => {
      const list = otherByVisit.get(ctx.visit!.id) ?? []
      list.push(ctx)
      otherByVisit.set(ctx.visit!.id, list)
    })

  // 补位候选：键 → 各巡次同编号样带里「后一次」那条
  const fillCandidates = new Map<string, BeltWithContext>()
  otherByVisit.forEach((contexts, vid) => {
    const visit = visitById.get(vid)!
    const keySet = new Set(contexts.map((ctx) => beltKey(ctx.site?.no ?? '', ctx.belt.no)))
    const intersects = Array.from(keySet).some((key) => chosenKeys.has(key))
    if (!intersects) {
      // 整巡次与定案巡次零交集：整条巡次单列，不补位、不评定
      const beltsText = contexts.map((ctx) => `${ctx.site?.no ?? '—'}/${ctx.belt.no}`).join('、')
      mismatches.push(
        mismatch('巡次对不上', { visit }, `巡次 ${visit.code} 与定案巡次无任何站位/样带编号交集（${beltsText}），整条巡次单列`)
      )
      return
    }
    contexts.forEach((ctx) => {
      const key = beltKey(ctx.site?.no ?? '', ctx.belt.no)
      if (chosenKeys.has(key)) return // 定案覆盖，不以其他巡次覆盖
      const existing = fillCandidates.get(key)
      if (!existing || laterBelt(existing, ctx) === ctx) fillCandidates.set(key, ctx)
    })
  })

  // 补登巡次 / 挂不上任何巡次的样带：补不出归位，单列
  reefContexts
    .filter((ctx) => !ctx.visit || ctx.visit.kind === '补登')
    .forEach((ctx) => {
      mismatches.push(
        mismatch(
          '补登未归位',
          ctx,
          `站位 ${ctx.site?.no ?? '—'} 样带 ${ctx.belt.no}（${ctx.belt.surveyDate}）属补登/无巡次标记，归不进${year} 年定案编号，单列`
        )
      )
    })

  // 定案缺号但能从同年其他巡次补位的：取后一次（fillCandidates 已是后一次）
  const lines: ResolvedBeltLine[] = []
  chosenByKey.forEach((ctx) => lines.push(buildLine(ctx, corals, fishes, '定案覆盖')))
  fillCandidates.forEach((ctx) => {
    lines.push(buildLine(ctx, corals, fishes, '跨巡次补位'))
  })
  lines.sort((a, b) => a.siteNo.localeCompare(b.siteNo, 'zh-Hans-CN') || a.beltNo.localeCompare(b.beltNo, 'zh-Hans-CN'))

  // 礁区年度定案汇总
  const involvedSiteIds = new Set(lines.map((line) => line.siteId))
  const pooledCorals = corals.filter((coral) => lines.some((line) => line.beltId === coral.beltId))
  const pooledFishes = fishes.filter((fish) => lines.some((line) => line.beltId === fish.beltId))
  const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    distribution[level] = round(
      pooledCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    )
  })
  const totalBeltLength = lines.reduce((sum, line) => sum + line.lengthM, 0)
  const fishTotal = lines.reduce((sum, line) => sum + line.fishTotal, 0)
  const avgBleachIndex =
    lines.length === 0 ? 0 : round(lines.reduce((sum, line) => sum + line.bleachIndexValue, 0) / lines.length, 2)
  const summary: ReefReefSummary = {
    reefId: reef.id,
    year,
    visitId,
    visitCode: chosenVisit?.code ?? '未归档',
    siteCount: involvedSiteIds.size,
    beltCount: lines.length,
    coralCount: pooledCorals.length,
    coverCmTotal: round(
      pooledCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
      1
    ),
    avgCoveragePct:
      lines.length === 0 ? 0 : round(lines.reduce((sum, line) => sum + line.coveragePct, 0) / lines.length, 2),
    avgBleachIndex,
    grade: bleachGrade(avgBleachIndex),
    bleachedSharePct: bleachedSharePct(pooledCorals),
    fishTotal,
    invertebrateTotal: lines.reduce((sum, line) => sum + line.invertebrateTotal, 0),
    fishDensityValue: fishDensity(fishTotal, totalBeltLength),
    distribution
  }

  return {
    reefId: reef.id,
    year,
    visitId,
    visitCode: chosenVisit?.code ?? '未归档',
    quarter: chosenVisit?.quarter ?? null,
    policy: RECONCILE_POLICY,
    status: mismatches.length === 0 ? '通过' : '失败',
    lines,
    mismatches,
    summary
  }
}
