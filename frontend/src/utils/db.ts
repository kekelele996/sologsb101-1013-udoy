/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据
 *   礁区 → 站位 → 巡次/年度定案 → 样带（按巡次分开）→ 珊瑚记录 / 鱼类计数
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Visit, Quarter } from '@/types/visit'
import { legacyVisitId, quarterOfDate, UNASSIGNED_VISIT_ID, yearOfDate } from '@/types/visit'
import type { AnnualFinalization } from '@/types/finalization'

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

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  visits: Visit[]
  finalizations: AnnualFinalization[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  visits!: Table<Visit, string>
  finalizations!: Table<AnnualFinalization, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>

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

    // v3：外业普查组「巡次」与礁区档案室「年度定案」分开管；
    // 样带挂巡次（belts.visitId），同编号样带在不同巡次各是一条。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        visits: 'id, reefId, year, quarter, updatedAt',
        finalizations: 'id, reefId, year, visitId, finalizedAt, updatedAt',
        belts: 'id, siteId, visitId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 迁移：历史数据补齐时间戳与必填字段
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

        // v3 迁移：旧数据没有巡次标记，按调查日期归入季度巡次；补不出的样带单列（visitId = null）。
        const sites = await tx.table<Site, string>('sites').toArray()
        const siteById = new Map(sites.map((site) => [site.id, site]))
        const belts = await tx.table<Belt, string>('belts').toArray()
        // reefId|year|quarter → 补录巡次
        const legacyVisits = new Map<string, Visit>()

        belts.forEach((belt) => {
          const site = siteById.get(belt.siteId)
          const year = yearOfDate(belt.surveyDate)
          const quarter = quarterOfDate(belt.surveyDate)
          if (!site || year === null || quarter === null) {
            // 日期缺失 / 非法：补不出巡次，留空由「未挂巡次样带」单列
            belt.visitId = null
            return
          }
          const key = `${site.reefId}|${year}|${quarter}`
          if (!legacyVisits.has(key)) {
            const stamp = belt.createdAt ?? Date.now()
            legacyVisits.set(key, {
              id: legacyVisitId(site.reefId, year, quarter),
              reefId: site.reefId,
              year,
              quarter: quarter as Quarter,
              name: `${year} ${quarter} 季度巡访（旧数据归并）`,
              leader: '',
              remark: '升级时按调查日期自动归入季度巡次',
              createdAt: stamp,
              updatedAt: stamp
            })
          }
          belt.visitId = legacyVisitId(site.reefId, year, quarter)
        })

        // toArray() 拿到的是快照，改动必须显式 bulkPut 落库
        await tx.table<Visit, string>('visits').bulkPut(Array.from(legacyVisits.values()))
        await tx.table<Belt, string>('belts').bulkPut(belts)
        // 年度定案表为档案室新增职责，历史上不存在定案，留空由档案室补定。
        void UNASSIGNED_VISIT_ID
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
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
  /** 所属巡次 id；null 表示补不出巡次（旧数据单列演示） */
  visitId: string | null
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
 * 3 个礁区 / 4 个站位 / 4 次巡访 / 10 条样带（含 Q3、Q4 两次重访与 1 条补不出巡次）
 * / 约 26 条珊瑚记录 / 约 20 条计数，覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级，
 * 并同时演示「定案一致 / 定案与其他巡访分歧 / 未定案取后一次 / 补不出巡次」四种情况。
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

  // 巡次：清澜湾有 Q3、Q4 两次重访；永兴岛仅 Q3；大洲岛仅 Q3。
  const visits: Array<Omit<Visit, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'visit_ql_q3',
      reefId: 'reef_ql01',
      year: 2026,
      quarter: 'Q3',
      name: '2026 Q3 秋季巡访',
      leader: '林之遥',
      remark: '台风过后首次重访'
    },
    {
      id: 'visit_ql_q4',
      reefId: 'reef_ql01',
      year: 2026,
      quarter: 'Q4',
      name: '2026 Q4 冬季巡访',
      leader: '林之遥',
      remark: '季度普查'
    },
    {
      id: 'visit_yr_q3',
      reefId: 'reef_yr02',
      year: 2026,
      quarter: 'Q3',
      name: '2026 Q3 秋季巡访',
      leader: '陈立群',
      remark: ''
    },
    {
      id: 'visit_dz_q3',
      reefId: 'reef_dz03',
      year: 2026,
      quarter: 'Q3',
      name: '2026 Q3 秋季巡访',
      leader: '陈立群',
      remark: ''
    }
  ]

  // 档案室定案：清澜湾定 Q4（与 Q3 有分歧，演示按定案重出）；永兴岛定 Q3；大洲岛未定案（演示取后一次）。
  const finalizations: Array<Omit<AnnualFinalization, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'final_reef_ql01_2026',
      reefId: 'reef_ql01',
      year: 2026,
      visitId: 'visit_ql_q4',
      archivist: '周档案',
      opinion: 'Q4 覆盖度恢复，采用冬季定案',
      finalizedAt: now - 86400000
    },
    {
      id: 'final_reef_yr02_2026',
      reefId: 'reef_yr02',
      year: 2026,
      visitId: 'visit_yr_q3',
      archivist: '周档案',
      opinion: '本年仅一次巡访，照此定案',
      finalizedAt: now - 86400000
    }
  ]

  const belts: SeedBelt[] = [
    /* ---- 清澜湾 S-01：Q3 与 Q4 同编号样带各一条（重访对得上 / 对不上都有） ---- */
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      visitId: 'visit_ql_q4',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: '2026-12-08',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 980, bleachLevel: '无', remark: '长势恢复' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 560, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1180, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 400, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 52, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 21, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 9, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 10, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      // Q3 重访：同站位同编号 T-01，白化更重；礁区已定案 Q4，按定案 Q4 重出（本条仅对账单列）
      id: 'belt_ql01_a_q3',
      siteId: 'site_ql_01',
      visitId: 'visit_ql_q3',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: '2026-09-12',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01aq3_1', beltId: 'belt_ql01_a_q3', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '中', remark: '台风后褪色' },
        { id: 'cor_ql01aq3_2', beltId: 'belt_ql01_a_q3', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01aq3_3', beltId: 'belt_ql01_a_q3', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01aq3_4', beltId: 'belt_ql01_a_q3', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01aq3_1', beltId: 'belt_ql01_a_q3', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01aq3_2', beltId: 'belt_ql01_a_q3', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' }
      ]
    },
    {
      // Q4 新补样带：Q3 缺测，演示「定案巡次」自身新增（不进差异）
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      visitId: 'visit_ql_q4',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: '2026-12-08',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 760, bleachLevel: '轻', remark: '边缘白化消退' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 990, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 450, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 24, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 16, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      // Q3 有 T-02，Q4 同编号也有，演示定案与其他巡访不一致
      id: 'belt_ql01_b_q3',
      siteId: 'site_ql_01',
      visitId: 'visit_ql_q3',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: '2026-09-12',
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01bq3_1', beltId: 'belt_ql01_b_q3', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01bq3_2', beltId: 'belt_ql01_b_q3', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01bq3_3', beltId: 'belt_ql01_b_q3', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化' }
      ],
      fishes: [
        { id: 'fsh_ql01bq3_1', beltId: 'belt_ql01_b_q3', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' }
      ]
    },
    /* ---- 清澜湾 S-02：Q4 有，Q3 无该编号样带 → 定案缺测补齐不触发，单次即可 ---- */
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      visitId: 'visit_ql_q4',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: '2026-12-09',
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      // S-02 在 Q3 也有一条 T-01，但 Q4 定案存在 → finalized-divergent
      id: 'belt_ql02_a_q3',
      siteId: 'site_ql_02',
      visitId: 'visit_ql_q3',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: '2026-09-13',
      observer: '周渝',
      corals: [
        { id: 'cor_ql02aq3_1', beltId: 'belt_ql02_a_q3', genus: '滨珊瑚属', form: '块状', coverCm: 1200, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql02aq3_2', beltId: 'belt_ql02_a_q3', genus: '陀螺珊瑚属', form: '块状', coverCm: 300, bleachLevel: '重', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql02aq3_1', beltId: 'belt_ql02_a_q3', family: '石斑鱼科', count: 3, sizeClass: '>30cm', category: '鱼类' }
      ]
    },
    /* ---- 永兴岛 S-01：仅 Q3 一次，已定案 Q3 → finalized-ok ---- */
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      visitId: 'visit_yr_q3',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: '2026-09-20',
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    /* ---- 大洲岛 S-01：Q3 与 Q4 同编号各一条，但礁区未定案 → latest-wins（取 Q4） ---- */
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      visitId: 'visit_dz_q3',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: '2026-09-05',
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    },
    {
      // 后一次：Q4（通过 Q4 巡次；大洲岛只有 visit_dz_q3，这里借用一个 Q4 临访演示取后一次）
      id: 'belt_dz01_a_q4',
      siteId: 'site_dz_01',
      visitId: 'visit_dz_q4',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: '2026-12-15',
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01aq4_1', beltId: 'belt_dz01_a_q4', genus: '杯形珊瑚属', form: '枝状', coverCm: 560, bleachLevel: '轻', remark: '白化缓解' },
        { id: 'cor_dz01aq4_2', beltId: 'belt_dz01_a_q4', genus: '蜂巢珊瑚属', form: '块状', coverCm: 340, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01aq4_1', beltId: 'belt_dz01_a_q4', family: '雀鲷科', count: 40, sizeClass: '0-10cm', category: '鱼类' }
      ]
    },
    /* ---- 补不出巡次：调查日期缺失（旧数据），visitId = null，单列 ---- */
    {
      id: 'belt_dz01_x',
      siteId: 'site_dz_01',
      visitId: null,
      no: 'T-99',
      lengthM: 20,
      orientation: '北',
      surveyDate: '',
      observer: '佚名',
      corals: [
        { id: 'cor_dz01x_1', beltId: 'belt_dz01_x', genus: '滨珊瑚属', form: '块状', coverCm: 300, bleachLevel: '轻', remark: '旧记录，日期缺失' }
      ],
      fishes: [
        { id: 'fsh_dz01x_1', beltId: 'belt_dz01_x', family: '雀鲷科', count: 12, sizeClass: '0-10cm', category: '鱼类' }
      ]
    }
  ]

  // 大洲岛 Q4 巡次（未登记在上面的固定数组，补一条以承载 belt_dz01_a_q4）
  visits.push({
    id: 'visit_dz_q4',
    reefId: 'reef_dz03',
    year: 2026,
    quarter: 'Q4',
    name: '2026 Q4 冬季巡访',
    leader: '陈立群',
    remark: '礁区尚未定案'
  })

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.visits, db.finalizations, db.belts, db.corals, db.fishes],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.visits.bulkPut(visits.map((visit, index) => ({ ...visit, ...stamp(150 + index) })))
      await db.finalizations.bulkPut(finalizations.map((item, index) => ({ ...item, ...stamp(160 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals, fishes, ...rest } = belt
          void corals
          void fishes
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
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )
    }
  )
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
    [db.reefs, db.sites, db.visits, db.finalizations, db.belts, db.corals, db.fishes],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.visits.clear(),
        db.finalizations.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear()
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
  const [reefs, sites, visits, finalizations, belts, corals, fishes] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.visits.count(),
    db.finalizations.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count()
  ])
  return { reefs, sites, visits, finalizations, belts, corals, fishes }
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
