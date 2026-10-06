/**
 * 巡次（外业普查组侧）。
 * 同一站位每季度重访一次：同编号样带在不同巡次里是各自独立的一条，
 * 覆盖率与白化指数按巡次分开记，绝不把几次巡访混算。
 * 巡次由外业普查组登记并维护；礁区档案室只引用它来做年度定案，不回写。
 */

/** 季度：Q1 春（1-3 月）/ Q2 夏（4-6 月）/ Q3 秋（7-9 月）/ Q4 冬（10-12 月） */
export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4'

export const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4']

/** 巡次：外业普查组对某礁区在某一年某一季度开展的一次重访 */
export interface Visit {
  id: string
  /** 所属礁区（按礁区组织季度巡访） */
  reefId: string
  /** 年份，如 2026 */
  year: number
  /** 季度 */
  quarter: Quarter
  /** 巡次名称（可改，默认「2026 Q3 秋季巡访」） */
  name: string
  /** 领队 / 联系人 */
  leader: string
  /** 备注（海况、台风扰动等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 巡次录入草稿（存于 visitStore） */
export interface VisitDraft {
  reefId: string
  year: number
  quarter: Quarter
  name: string
  leader: string
  remark: string
}

/** 当前自然年份，供表单默认值 */
export function currentYear(): number {
  return new Date().getFullYear()
}

/** 月份（1-12）→ 季度 */
export function monthToQuarter(month: number): Quarter {
  if (month <= 3) return 'Q1'
  if (month <= 6) return 'Q2'
  if (month <= 9) return 'Q3'
  return 'Q4'
}

/** 调查日期（YYYY-MM-DD）→ 年份；非法日期返回 null */
export function yearOfDate(surveyDate: string): number | null {
  const match = /^(\d{4})-/.exec(surveyDate ?? '')
  if (!match) return null
  const year = Number(match[1])
  return Number.isFinite(year) && year > 1900 && year < 3000 ? year : null
}

/** 调查日期（YYYY-MM-DD）→ 季度；非法日期返回 null */
export function quarterOfDate(surveyDate: string): Quarter | null {
  const match = /^\d{4}-(\d{2})-/.exec(surveyDate ?? '')
  if (!match) return null
  const month = Number(match[1])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return monthToQuarter(month)
}

/** 季度中文名 */
export const QUARTER_LABEL: Record<Quarter, string> = {
  Q1: '春季（1-3月）',
  Q2: '夏季（4-6月）',
  Q3: '秋季（7-9月）',
  Q4: '冬季（10-12月）'
}

/** 生成默认巡次名 */
export function defaultVisitName(year: number, quarter: Quarter): string {
  return `${year} ${quarter} 季度巡访`
}

/**
 * 旧数据升级：按调查日期归入季度巡次时使用的补录巡次 id。
 * 同一礁区 + 年份 + 季度只补一条。
 */
export function legacyVisitId(reefId: string, year: number, quarter: Quarter): string {
  return `visit_legacy_${reefId}_${year}_${quarter}`
}

/** 补不出巡次（调查日期缺失 / 非法）的样带统一挂到该标记，对账页单列 */
export const UNASSIGNED_VISIT_ID = 'visit_unassigned'

export function createEmptyVisitDraft(reefId = '', year = currentYear()): VisitDraft {
  return {
    reefId,
    year,
    quarter: monthToQuarter(new Date().getMonth() + 1),
    name: '',
    leader: '',
    remark: ''
  }
}
