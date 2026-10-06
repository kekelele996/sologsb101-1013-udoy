/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据
 *   （礁区 → 站位 → 巡次 → 样带 → 珊瑚记录/鱼类计数；档案室定案 + 对账记录）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Visit, Quarter } from '@/types/visit'
import { quarterOfDate, visitCode } from '@/types/visit'
import type { ReefFinalization } from '@/types/reefFinalization'
import { finalizationId } from '@/types/reefFinalization'
import type { ReconciliationRun } from '@/types/reconciliation'
import { reconcileReefYear } from '@/utils/reconcile'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 补登（无巡次标记 / 归不进季度）样带兜底巡次代码 */
export const LEGACY_FALLBACK_CODE = '*未分季'

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  visits: Visit[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  finalizations: ReefFinalization[]
  reconciliations: ReconciliationRun[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  visits!: Table<Visit, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  finalizations!: Table<ReefFinalization, string>
  reconciliations!: Table<ReconciliationRun, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引
    this.version(2).stores({
      reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
      sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
      belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
      corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
      fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
    })

    // v3：巡次分离普查组每次重访；档案室另立年度定案与对账记录
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        visits: 'id, year, quarter, code, kind, startedOn, updatedAt',
        belts: 'id, siteId, visitId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        finalizations: 'id, reefId, year, visitId, updatedAt',
        reconciliations: 'id, finalizationId, reefId, year, visitId, status, runAt'
      })
      .upgrade(async (tx) => {
        // v2 迁移：历史表补齐时间戳与必填字段
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }

        // 旧数据没有巡次标记：按调查日期归入季度巡次；补不出的样带单列进补登巡次
        const beltsTable = tx.table<Belt, string>('belts')
        const legacyBelts = await beltsTable.toArray()
        const { visits } = groupLegacyIntoVisits(legacyBelts)
        if (visits.length > 0) await tx.table<Visit, string>('visits').bulkPut(visits)
        // toArray() 返回的是副本：按 id 建映射后通过 modify 写回 visitId
        const visitIdByBelt = new Map(legacyBelts.map((belt) => [belt.id, belt.visitId]))
        await beltsTable.toCollection().modify((belt: Belt) => {
          const visitId = visitIdByBelt.get(belt.id)
          if (visitId) belt.visitId = visitId
        })
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 严格解析调查日期，非法返回 null */
function parseSurveyDate(date: unknown): Date | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * 旧数据升级 / 旧备份导入共用：把没有巡次标记的样带按调查日期归入季度巡次。
 * - 调查日期合法 → 归入「该年该季度」常规巡次（同年同季只建一条）；
 * - 日期缺失/非法 → 归不进季度，单列入 *未分季 补登巡次。
 * 就地给每条 belt 写 visitId，并返回需要新建的巡次。
 */
export function groupLegacyIntoVisits(belts: Array<Partial<Belt> & { visitId?: string }>): { visits: Visit[] } {
  const now = Date.now()
  const regular = new Map<string, Visit>()
  let fallback: Visit | null = null

  belts.forEach((belt) => {
    if (typeof belt.visitId === 'string' && belt.visitId.length > 0) return
    const parsed = parseSurveyDate(belt.surveyDate)
    if (parsed) {
      const { year, quarter } = quarterOfDate(belt.surveyDate as string)
      const key = `${year}-${quarter}`
      let visit = regular.get(key)
      if (!visit) {
        visit = {
          id: `visit_${year}q${quarter}`,
          year,
          quarter,
          code: visitCode(year, quarter),
          kind: '常规',
          startedOn: belt.surveyDate as string,
          note: '升级旧数据时按调查日期归入季度巡次',
          createdAt: now,
          updatedAt: now
        }
        regular.set(key, visit)
      } else if (belt.surveyDate && belt.surveyDate < visit.startedOn) {
        visit.startedOn = belt.surveyDate as string
      }
      belt.visitId = visit.id
    } else {
      if (!fallback) {
        const d = new Date()
        fallback = {
          id: 'visit_legacy_unassigned',
          year: d.getFullYear(),
          quarter: 1 as Quarter,
          code: LEGACY_FALLBACK_CODE,
          kind: '补登',
          startedOn: '',
          note: '旧数据缺合法调查日期，补不出季度巡次，单列保留',
          createdAt: now,
          updatedAt: now
        }
      }
      belt.visitId = fallback.id
    }
  })

  return { visits: [...regular.values(), ...(fallback ? [fallback] : [])] }
}

/**
 * 备份导入兜底：补齐缺失的巡次归属。
 * - 旧版备份（无 visits 表）：按调查日期归入季度巡次；
 * - 有 visits 但某样带 visitId 指向不存在的巡次：归入 *未分季 补登巡次。
 * 就地改写 payload，幂等。
 */
export function ensurePayloadVisits(payload: BackupPayload): BackupPayload {
  if (!Array.isArray(payload.visits)) payload.visits = []
  if (!Array.isArray(payload.finalizations)) payload.finalizations = []
  if (!Array.isArray(payload.reconciliations)) payload.reconciliations = []

  const known = new Set(payload.visits.map((visit) => visit.id))
  const needLegacyGroup = payload.visits.length === 0 && payload.belts.some((belt) => !belt.visitId)
  if (needLegacyGroup) {
    const { visits } = groupLegacyIntoVisits(payload.belts)
    payload.visits.push(...visits)
    visits.forEach((visit) => known.add(visit.id))
  }

  const orphaned = payload.belts.filter((belt) => !belt.visitId || !known.has(belt.visitId))
  if (orphaned.length > 0) {
    let fallback = payload.visits.find((visit) => visit.code === LEGACY_FALLBACK_CODE)
    if (!fallback) {
      const d = new Date()
      fallback = {
        id: 'visit_legacy_unassigned',
        year: d.getFullYear(),
        quarter: 1 as Quarter,
        code: LEGACY_FALLBACK_CODE,
        kind: '补登',
        startedOn: '',
        note: '导入备份中补不出巡次归属的样带，单列保留',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      payload.visits.push(fallback)
    }
    orphaned.forEach((belt) => {
      belt.visitId = fallback!.id
    })
  }
  return payload
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  visitId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：
 * 3 个礁区 / 4 个站位 / 2026 年 Q1、Q2、Q3 三个季度巡次 + 1 个 2025 年补登巡次 /
 * 13 条样带（同编号样带在不同季度各成一条）/ 珊瑚与鱼类计数；
 * 清澜湾、永兴岛两个礁区档案室已定案 2026 年度（Q3），大洲岛未定案。
 * 对账覆盖：定案覆盖、跨巡次补位、整巡次对不上、补登未归位、定案编号重复全部情形。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    { id: 'site_ql_01', reefId: 'reef_ql01', no: 'S-01', lat: 19.5621, lng: 110.7924, depthM: 4.2, substrate: '珊瑚礁石' },
    { id: 'site_ql_02', reefId: 'reef_ql01', no: 'S-02', lat: 19.5487, lng: 110.8103, depthM: 8.6, substrate: '礁砂' },
    { id: 'site_yr_01', reefId: 'reef_yr02', no: 'S-01', lat: 16.8342, lng: 112.3286, depthM: 12.4, substrate: '砾石' },
    { id: 'site_dz_01', reefId: 'reef_dz03', no: 'S-01', lat: 18.6712, lng: 110.4913, depthM: 6.8, substrate: '岩礁' }
  ]

  const visits: Array<Omit<Visit, 'createdAt' | 'updatedAt'>> = [
    { id: 'visit_2025q4_legacy', year: 2025, quarter: 4, code: '*2025Q4', kind: '补登', startedOn: '2025-11-10', note: '历史纸档电子化，样带补不进 2026 年度巡次，单列' },
    { id: 'visit_2026q1', year: 2026, quarter: 1, code: '2026Q1', kind: '常规', startedOn: '2026-02-18', note: '春季季度普查' },
    { id: 'visit_2026q2', year: 2026, quarter: 2, code: '2026Q2', kind: '常规', startedOn: '2026-05-20', note: '夏季季度普查' },
    { id: 'visit_2026q3', year: 2026, quarter: 3, code: '2026Q3', kind: '常规', startedOn: '2026-08-22', note: '秋季季度普查' }
  ]

  const belts: SeedBelt[] = [
    /* ---------------- 清澜湾 reef_ql01 ---------------- */
    {
      id: 'belt_ql01_a_q3',
      siteId: 'site_ql_01',
      visitId: 'visit_2026q3',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: '2026-08-22',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_q3_1', beltId: 'belt_ql01_a_q3', genus: '鹿角珊瑚属', form: '枝状', coverCm: 900, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_q3_2', beltId: 'belt_ql01_a_q3', genus: '杯形珊瑚属', form: '枝状', coverCm: 480, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_q3_3', beltId: 'belt_ql01_a_q3', genus: '滨珊瑚属', form: '块状', coverCm: 1180, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_q3_4', beltId: 'belt_ql01_a_q3', genus: '软珊瑚属', form: '软珊瑚', coverCm: 360, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_q3_1', beltId: 'belt_ql01_a_q3', family: '雀鲷科', count: 48, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_q3_2', beltId: 'belt_ql01_a_q3', family: '蝴蝶鱼科', count: 20, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_q3_3', beltId: 'belt_ql01_a_q3', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      // 定案巡次内编号重复：08-22 一条、08-24 一条，取后一次，本条单列
      id: 'belt_ql01_b_q3',
      siteId: 'site_ql_01',
      visitId: 'visit_2026q3',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: '2026-08-22',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_q3_1', beltId: 'belt_ql01_b_q3', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 700, bleachLevel: '中', remark: '重复编号的较早一条' },
        { id: 'cor_ql01b_q3_2', beltId: 'belt_ql01_b_q3', genus: '鹿角珊瑚属', form: '枝状', coverCm: 400, bleachLevel: '重', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01b_q3_1', beltId: 'belt_ql01_b_q3', family: '隆头鱼科', count: 20, sizeClass: '11-20cm', category: '鱼类' }
      ]
    },
    {
      id: 'belt_ql01_b2_q3',
      siteId: 'site_ql_01',
      visitId: 'visit_2026q3',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: '2026-08-24',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b2_q3_1', beltId: 'belt_ql01_b2_q3', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 740, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b2_q3_2', beltId: 'belt_ql01_b2_q3', genus: '蜂巢珊瑚属', form: '块状', coverCm: 1000, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b2_q3_3', beltId: 'belt_ql01_b2_q3', genus: '鹿角珊瑚属', form: '枝状', coverCm: 420, bleachLevel: '无', remark: '复测恢复' }
      ],
      fishes: [
        { id: 'fsh_ql01b2_q3_1', beltId: 'belt_ql01_b2_q3', family: '隆头鱼科', count: 24, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b2_q3_2', beltId: 'belt_ql01_b2_q3', family: '刺尾鱼科', count: 16, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b2_q3_3', beltId: 'belt_ql01_b2_q3', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a_q3',
      siteId: 'site_ql_02',
      visitId: 'visit_2026q3',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: '2026-08-22',
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_q3_1', beltId: 'belt_ql02_a_q3', genus: '滨珊瑚属', form: '块状', coverCm: 1260, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_q3_2', beltId: 'belt_ql02_a_q3', genus: '陀螺珊瑚属', form: '块状', coverCm: 240, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_q3_1', beltId: 'belt_ql02_a_q3', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_q3_2', beltId: 'belt_ql02_a_q3', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      // Q1 同编号样带：定案覆盖 Q3，Q1 原始记录保留但不进评定
      id: 'belt_ql01_a_q1',
      siteId: 'site_ql_01',
      visitId: 'visit_2026q1',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: '2026-02-18',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_q1_1', beltId: 'belt_ql01_a_q1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 800, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_q1_2', beltId: 'belt_ql01_a_q1', genus: '滨珊瑚属', form: '块状', coverCm: 1050, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_q1_1', beltId: 'belt_ql01_a_q1', family: '雀鲷科', count: 40, sizeClass: '0-10cm', category: '鱼类' }
      ]
    },
    {
      id: 'belt_ql02_a_q1',
      siteId: 'site_ql_02',
      visitId: 'visit_2026q1',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: '2026-02-18',
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_q1_1', beltId: 'belt_ql02_a_q1', genus: '滨珊瑚属', form: '块状', coverCm: 1200, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_q1_2', beltId: 'belt_ql02_a_q1', genus: '陀螺珊瑚属', form: '块状', coverCm: 300, bleachLevel: '重', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql02a_q1_1', beltId: 'belt_ql02_a_q1', family: '石斑鱼科', count: 3, sizeClass: '>30cm', category: '鱼类' }
      ]
    },
    {
      // Q2 巡次只测了 T-07：与 Q3 定案零交集，整条巡次单列
      id: 'belt_ql01_t07_q2',
      siteId: 'site_ql_01',
      visitId: 'visit_2026q2',
      no: 'T-07',
      lengthM: 50,
      orientation: '西',
      surveyDate: '2026-05-20',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01t07_q2_1', beltId: 'belt_ql01_t07_q2', genus: '鹿角珊瑚属', form: '枝状', coverCm: 600, bleachLevel: '中', remark: '临时加布的一条方向样带' }
      ],
      fishes: [
        { id: 'fsh_ql01t07_q2_1', beltId: 'belt_ql01_t07_q2', family: '雀鲷科', count: 30, sizeClass: '0-10cm', category: '鱼类' }
      ]
    },
    {
      // 2025 补登巡次样带：补不进 2026 定案编号，单列
      id: 'belt_ql01_t99_legacy',
      siteId: 'site_ql_01',
      visitId: 'visit_2025q4_legacy',
      no: 'T-99',
      lengthM: 50,
      orientation: '西',
      surveyDate: '2025-11-10',
      observer: '旧档整理',
      corals: [
        { id: 'cor_ql01t99_1', beltId: 'belt_ql01_t99_legacy', genus: '蜂巢珊瑚属', form: '块状', coverCm: 500, bleachLevel: '中', remark: '纸档电子化' }
      ],
      fishes: [
        { id: 'fsh_ql01t99_1', beltId: 'belt_ql01_t99_legacy', family: '海星科', count: 4, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    },

    /* ---------------- 永兴岛 reef_yr02（对账通过） ---------------- */
    {
      id: 'belt_yr01_a_q1',
      siteId: 'site_yr_01',
      visitId: 'visit_2026q1',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: '2026-02-18',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_q1_1', beltId: 'belt_yr01_a_q1', genus: '星珊瑚属', form: '块状', coverCm: 1500, bleachLevel: '无', remark: '' },
        { id: 'cor_yr01a_q1_2', beltId: 'belt_yr01_a_q1', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 600, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_q1_1', beltId: 'belt_yr01_a_q1', family: '笛鲷科', count: 24, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_q1_2', beltId: 'belt_yr01_a_q1', family: '篮子鱼科', count: 10, sizeClass: '11-20cm', category: '鱼类' }
      ]
    },
    {
      id: 'belt_yr01_a_q2',
      siteId: 'site_yr_01',
      visitId: 'visit_2026q2',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: '2026-05-20',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_q2_1', beltId: 'belt_yr01_a_q2', genus: '星珊瑚属', form: '块状', coverCm: 1540, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_q2_2', beltId: 'belt_yr01_a_q2', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 620, bleachLevel: '中', remark: '水流较强' },
        { id: 'cor_yr01a_q2_3', beltId: 'belt_yr01_a_q2', genus: '石芝珊瑚属', form: '叶状', coverCm: 470, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_q2_1', beltId: 'belt_yr01_a_q2', family: '笛鲷科', count: 26, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_q2_2', beltId: 'belt_yr01_a_q2', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      // 定案 Q3 没有 T-02：从同年 Q2 同编号跨巡次补位（取后一次，不平均）
      id: 'belt_yr01_t02_q2',
      siteId: 'site_yr_01',
      visitId: 'visit_2026q2',
      no: 'T-02',
      lengthM: 50,
      orientation: '北',
      surveyDate: '2026-05-20',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01t02_q2_1', beltId: 'belt_yr01_t02_q2', genus: '鹿角珊瑚属', form: '枝状', coverCm: 800, bleachLevel: '轻', remark: 'Q3 未重测该号，按 Q2 补位' }
      ],
      fishes: [
        { id: 'fsh_yr01t02_q2_1', beltId: 'belt_yr01_t02_q2', family: '雀鲷科', count: 30, sizeClass: '0-10cm', category: '鱼类' }
      ]
    },
    {
      id: 'belt_yr01_a_q3',
      siteId: 'site_yr_01',
      visitId: 'visit_2026q3',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: '2026-08-22',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_q3_1', beltId: 'belt_yr01_a_q3', genus: '星珊瑚属', form: '块状', coverCm: 1600, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_q3_2', beltId: 'belt_yr01_a_q3', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_q3_3', beltId: 'belt_yr01_a_q3', genus: '石芝珊瑚属', form: '叶状', coverCm: 500, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_q3_1', beltId: 'belt_yr01_a_q3', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_q3_2', beltId: 'belt_yr01_a_q3', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_q3_3', beltId: 'belt_yr01_a_q3', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_t03_q3',
      siteId: 'site_yr_01',
      visitId: 'visit_2026q3',
      no: 'T-03',
      lengthM: 50,
      orientation: '东',
      surveyDate: '2026-08-22',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01t03_q3_1', beltId: 'belt_yr01_t03_q3', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 700, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01t03_q3_1', beltId: 'belt_yr01_t03_q3', family: '刺尾鱼科', count: 12, sizeClass: '11-20cm', category: '鱼类' }
      ]
    },

    /* ---------------- 大洲岛 reef_dz03（未定案） ---------------- */
    {
      id: 'belt_dz01_a_q3',
      siteId: 'site_dz_01',
      visitId: 'visit_2026q3',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: '2026-08-22',
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_q3_1', beltId: 'belt_dz01_a_q3', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_q3_2', beltId: 'belt_dz01_a_q3', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_q3_1', beltId: 'belt_dz01_a_q3', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_q3_2', beltId: 'belt_dz01_a_q3', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  // 档案室年度定案：清澜湾、永兴岛均定 2026 年 Q3
  const finalizations: Array<Omit<ReefFinalization, 'createdAt' | 'updatedAt'>> = [
    {
      id: finalizationId('reef_ql01', 2026),
      reefId: 'reef_ql01',
      year: 2026,
      visitId: 'visit_2026q3',
      quarter: 3,
      decidedBy: '档案室·周审',
      note: '以秋季季度普查为年度定案'
    },
    {
      id: finalizationId('reef_yr02', 2026),
      reefId: 'reef_yr02',
      year: 2026,
      visitId: 'visit_2026q3',
      quarter: 3,
      decidedBy: '档案室·周审',
      note: '以秋季季度普查为年度定案'
    }
  ]

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.visits, db.belts, db.corals, db.fishes, db.finalizations, db.reconciliations],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.visits.bulkPut(visits.map((visit, index) => ({ ...visit, ...stamp(150 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals: _corals, fishes: _fishes, ...rest } = belt
          void _corals
          void _fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(500 + beltIndex * 100 + fishIndex) }))
        )
      )
      await db.finalizations.bulkPut(finalizations.map((fin, index) => ({ ...fin, ...stamp(600 + index) })))
    }
  )

  // 定案后按同一口径重出对账记录（只读取普查侧，不回改定案）
  const allCorals = belts.flatMap((belt) => belt.corals)
  const allFishes = belts.flatMap((belt) => belt.fishes)
  const [stampedReefs, stampedSites, stampedVisits, stampedBelts] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.visits.toArray(),
    db.belts.toArray()
  ])
  const runs: ReconciliationRun[] = []
  for (const fin of finalizations) {
    const reef = stampedReefs.find((item) => item.id === fin.reefId)
    if (!reef) continue
    const result = reconcileReefYear({
      reef,
      year: fin.year,
      visitId: fin.visitId,
      visits: stampedVisits,
      sites: stampedSites,
      belts: stampedBelts,
      corals: allCorals as CoralRecord[],
      fishes: allFishes as FishCount[]
    })
    runs.push({
      id: createId('rec'),
      finalizationId: fin.id,
      reefId: fin.reefId,
      year: fin.year,
      visitId: fin.visitId,
      quarter: fin.quarter,
      policy: result.policy,
      resolvedBeltCount: result.lines.length,
      mismatchCount: result.mismatches.length,
      status: result.status,
      mismatches: result.mismatches,
      runAt: now
    })
  }
  if (runs.length > 0) await db.reconciliations.bulkPut(runs)
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.visits, db.belts, db.corals, db.fishes, db.finalizations, db.reconciliations],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.visits.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.finalizations.clear(),
        db.reconciliations.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, visits, belts, corals, fishes, finalizations, reconciliations] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.visits.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count(),
    db.finalizations.count(),
    db.reconciliations.count()
  ])
  return { reefs, sites, visits, belts, corals, fishes, finalizations, reconciliations }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
