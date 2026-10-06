/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  buildCanonicalLines,
  buildCanonicalReefSummaries,
  RESOLUTION_POLICY,
  type CanonicalDataset,
  type ReconcileMismatch
} from '@/utils/reconcile'
import type { BleachLevel } from '@/types/coralRecord'

/** 备份集合键名（七张表） */
export const BACKUP_KEYS = ['reefs', 'sites', 'visits', 'finalizations', 'belts', 'corals', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 把备份快照转成对账口径函数消费的数据集 */
export function payloadToDataset(payload: BackupPayload): CanonicalDataset {
  return {
    reefs: payload.reefs,
    sites: payload.sites,
    visits: payload.visits ?? [],
    finalizations: payload.finalizations ?? [],
    belts: payload.belts,
    corals: payload.corals,
    fishes: payload.fishes
  }
}

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, visits, finalizations, belts, corals, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.visits.toArray(),
    db.finalizations.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    visits,
    finalizations,
    belts,
    corals,
    fishes
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
  for (const key of BACKUP_KEYS) {
    // v3 新增的两表在旧备份里可能缺失，按空数组合法处理
    if ((key === 'visits' || key === 'finalizations') && obj[key] === undefined) continue
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    visits: obj.visits ?? [],
    finalizations: obj.finalizations ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    visits: payload.visits.length,
    finalizations: payload.finalizations.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
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
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.visits, db.finalizations, db.belts, db.corals, db.fishes],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.visits.bulkPut(payload.visits)
      await db.finalizations.bulkPut(payload.finalizations)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const visitMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

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
  const visits = (payload.visits ?? []).map((visit) => {
    const id = createId('visit')
    visitMap.set(visit.id, id)
    return { ...visit, id, reefId: reefMap.get(visit.reefId) ?? visit.reefId }
  })
  // 年度定案 id 由「礁区 + 年份」派生，重映射礁区后重建主键并重指巡次
  const finalizations = (payload.finalizations ?? []).map((item) => {
    const reefId = reefMap.get(item.reefId) ?? item.reefId
    return {
      ...item,
      id: `final_${reefId}_${item.year}`,
      reefId,
      visitId: visitMap.get(item.visitId) ?? item.visitId
    }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return {
      ...belt,
      id,
      siteId: siteMap.get(belt.siteId) ?? belt.siteId,
      visitId: belt.visitId ? visitMap.get(belt.visitId) ?? null : null
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
  return { ...payload, reefs, sites, visits, finalizations, belts, corals, fishes }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/**
 * 按统一口径生成某年度的导出结论文本（评定与导出同一个口径，见 utils/reconcile.ts）。
 * 定案了按定案巡次，没定案取后一次巡访；对不上的巡次在文末单列提示。
 */
export function buildConclusionText(payload: BackupPayload, year: number, mismatches?: ReconcileMismatch[]): string {
  const dataset = payloadToDataset(payload)
  const lines = buildCanonicalLines(dataset, year)
  const summaries = buildCanonicalReefSummaries(dataset, year, lines)
  const discrepancy = mismatches ?? []
  const header = [
    `珊瑚礁普查年度评定结论（${year} 年）`,
    `口径：${RESOLUTION_POLICY.label}`,
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    ''
  ]
  const reefBlocks = summaries
    .filter((summary) => summary.beltCount > 0)
    .map((summary) => {
      const finalized = summary.finalizedVisitName
        ? `定案巡次：${summary.finalizedVisitName}`
        : '未定案（取后一次巡访）'
      return [
        `【${summary.reefName}】${finalized}`,
        `  站位 ${summary.siteCount} 个 · 样带 ${summary.beltCount} 条 · 珊瑚记录 ${summary.coralCount} 条`,
        `  平均覆盖率 ${summary.avgCoveragePct}% · 平均白化指数 ${summary.avgBleachIndex}（${summary.grade}）· 白化占比 ${summary.bleachedSharePct}% · 鱼类 ${summary.fishTotal} 尾`,
        ...lines
          .filter((line) => line.reefId === summary.reefId)
          .map(
            (line) =>
              `  - 站位 ${line.siteNo} 样带 ${line.beltNo}（${line.visitName}，${line.surveyDate}）：${line.conclusion}；鱼类 ${line.fishTotal} 尾（${line.fishDensity} 尾/100m²）`
          )
      ].join('\n')
    })
  const mismatchBlock =
    discrepancy.length === 0
      ? []
      : [
          '',
          `对不上的巡次（${discrepancy.length} 处，已单列；请外业普查组核对重跑，不影响档案室已定案巡次）：`,
          ...discrepancy.map(
            (item) =>
              `  - ${item.reefName}｜站位 ${item.siteNo}｜样带 ${item.beltNo}：${item.status === 'finalized-divergent' ? '定案与其他巡访不一致，按定案' : item.status === 'gap-filled' ? '定案巡次缺测，取后一次补齐' : '多次巡访不一致，取后一次'}（共 ${item.observations.length} 次巡访）`
          )
        ]
  return [...header, ...reefBlocks, ...mismatchBlock].join('\n')
}

/** 导出某年度评定结论文本文件（.txt） */
export function downloadConclusionText(text: string, year: number): string {
  const fileName = `${DB_NAME}-conclusion-${year}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return fileName
}
