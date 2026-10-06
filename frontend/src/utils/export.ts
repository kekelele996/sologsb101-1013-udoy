/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及档案室年度定案的覆盖度结论生成（评定与导出共用 utils/reconcile 同一口径）。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  ensurePayloadVisits,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import { BLEACH_LEVELS, type BleachLevel } from '@/types/coralRecord'
import type { ReefFinalization } from '@/types/reefFinalization'
import type { ReconciliationRun } from '@/types/reconciliation'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  round
} from '@/utils/bleach'
import { reconcileReefYear, type ReefReconcileResult } from '@/utils/reconcile'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'reefs',
  'sites',
  'visits',
  'belts',
  'corals',
  'fishes',
  'finalizations',
  'reconciliations'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, visits, belts, corals, fishes, finalizations, reconciliations] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.visits.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.finalizations.toArray(),
    db.reconciliations.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    visits,
    belts,
    corals,
    fishes,
    finalizations,
    reconciliations
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  // v2 时期的五张表为必备；v3 起的 visits / finalizations / reconciliations 缺失时按旧备份补齐
  for (const key of ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload = ensurePayloadVisits({
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    visits: Array.isArray(obj.visits) ? obj.visits : [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    finalizations: Array.isArray(obj.finalizations) ? obj.finalizations : [],
    reconciliations: Array.isArray(obj.reconciliations) ? obj.reconciliations : []
  })
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    visits: payload.visits.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    finalizations: payload.finalizations.length,
    reconciliations: payload.reconciliations.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  await downloadJson(fileName, payload)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 导出档案室年度定案结论（只含参与评定的样带与礁区汇总，口径同评定页） */
export async function exportFinalizationJson(results: ReefReconcileResult[], year: number): Promise<{ fileName: string; reefCount: number }> {
  const exportedAt = new Date().toISOString()
  const payload = {
    app: 'gbcoralbelt',
    kind: 'finalization-conclusions',
    year,
    exportedAt,
    policy: results[0]?.policy ?? '',
    reefs: results.map((result) => ({
      reefId: result.reefId,
      year: result.year,
      visitCode: result.visitCode,
      status: result.status,
      summary: result.summary,
      lines: result.lines,
      mismatches: result.mismatches
    }))
  }
  const fileName = `${DB_NAME}-finalization-${year}-${exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`
  await downloadJson(fileName, payload)
  stampBackupTime(exportedAt)
  return { fileName, reefCount: results.length }
}

async function downloadJson(fileName: string, data: unknown): Promise<void> {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  const safe = ensurePayloadVisits(payload)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.visits, db.belts, db.corals, db.fishes, db.finalizations, db.reconciliations],
    async () => {
      await db.reefs.bulkPut(safe.reefs)
      await db.sites.bulkPut(safe.sites)
      await db.visits.bulkPut(safe.visits)
      await db.belts.bulkPut(safe.belts)
      await db.corals.bulkPut(safe.corals)
      await db.fishes.bulkPut(safe.fishes)
      await db.finalizations.bulkPut(safe.finalizations)
      await db.reconciliations.bulkPut(safe.reconciliations)
    }
  )
  return countPayload(safe)
}

/**
 * 追加式导入：为业务数据重新分配 id，避免覆盖现有档案。
 * 巡次（Visit）保持同一 code 复用，缺失才新建，使同一批重访归入同一季度巡次；
 * 档案室定案与对账记录属于“档案室侧”结论，追加导入不复制，避免污染本地定案。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  /** 巡次 code → 本地已存在巡次 id（这里只在导入集合内复用） */
  const visitCodeToId = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const visits = payload.visits.map((visit) => {
    const existingByCode = visitCodeToId.get(visit.code)
    if (existingByCode) return { ...visit, id: existingByCode }
    const id = createId('visit')
    visitCodeToId.set(visit.code, id)
    return { ...visit, id }
  })
  const visitMap = new Map(payload.visits.map((visit, index) => [visit.id, visits[index].id]))
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return {
      ...belt,
      id,
      siteId: siteMap.get(belt.siteId) ?? belt.siteId,
      visitId: visitMap.get(belt.visitId) ?? belt.visitId
    }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return {
    ...payload,
    reefs,
    sites,
    visits,
    belts,
    corals,
    fishes,
    // 档案室定案 / 对账不随追加导入复制
    finalizations: [] as ReefFinalization[],
    reconciliations: [] as ReconciliationRun[]
  }
}

/* ------------------------- 普查原始口径（导出原始备份用） ------------------------- */

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  visitId: string
  visitCode: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 普查原始口径：直接由快照逐样带重算（不经档案室定案），供原始数据导出/展示 */
export function buildCoverageLinesFromPayload(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const visitById = new Map(payload.visits.map((visit) => [visit.id, visit]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const visit = visitById.get(belt.visitId)
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
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
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        visitId: belt.visitId,
        visitCode: visit?.code ?? '未归档',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          corals.length === 0
            ? `${visit?.code ?? '未归档'}：该样带尚未录入珊瑚记录`
            : grade === '无'
              ? `${visit?.code ?? '未归档'}：珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `${visit?.code ?? '未归档'}：珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/* --------------------------- 档案室年度定案结论（评定=导出同一口径） --------------------------- */

/**
 * 按礁区列表重出年度定案结论：每个礁区取其该年定案巡次，统一走 reconcileReefYear。
 * CoverageView 的档案室评定与「导出定案结论」共用本函数，保证口径一致。
 */
export function buildFinalizedResults(
  payload: BackupPayload,
  finalizations: ReefFinalization[],
  year: number
): ReefReconcileResult[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  return finalizations
    .filter((fin) => fin.year === year)
    .map((fin) => {
      const reef = reefById.get(fin.reefId)
      if (!reef) return null
      return reconcileReefYear({
        reef,
        year: fin.year,
        visitId: fin.visitId,
        visits: payload.visits,
        sites: payload.sites,
        belts: payload.belts,
        corals: payload.corals,
        fishes: payload.fishes
      })
    })
    .filter((result): result is ReefReconcileResult => result !== null)
}
