/** 季度（普查以季度为巡次周期） */
export type Quarter = 1 | 2 | 3 | 4

export const QUARTERS: Quarter[] = [1, 2, 3, 4]

/**
 * 巡次类型：
 * - 常规：外业普查组每次季度重访开立的巡次
 * - 补登：升级旧数据时按调查日期归入季度巡次后，补不出归属样带而单列的兜底巡次
 */
export type VisitKind = '常规' | '补登'

export const VISIT_KINDS: VisitKind[] = ['常规', '补登']

/**
 * 巡次（Visit）：外业普查组对一次重访的记录单元。
 * 同编号样带在不同巡次里各是一条独立样带（各有自己的珊瑚记录与鱼类计数），
 * 覆盖率与白化指数按巡次分别计算，不跨巡次混算。
 */
export interface Visit {
  id: string
  /** 年份（该次重访所在年份） */
  year: number
  /** 季度（1 ~ 4） */
  quarter: Quarter
  /** 巡次代码，如 2026Q2；补登巡次带 * 前缀，如 *2025Q1 */
  code: string
  kind: VisitKind
  /** 该次重访开始/记录日期（YYYY-MM-DD） */
  startedOn: string
  /** 备注（天气、潮汐、补登说明等） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 巡次创建草稿（存于 visitStore） */
export interface VisitDraft {
  year: number
  quarter: Quarter
  startedOn: string
  note: string
}

/** 生成巡次代码：常规 2026Q2；补登 *2026Q2 */
export function visitCode(year: number, quarter: Quarter, kind: VisitKind = '常规'): string {
  return `${kind === '补登' ? '*' : ''}${year}Q${quarter}`
}

export function createEmptyVisitDraft(now = new Date()): VisitDraft {
  return {
    year: now.getFullYear(),
    quarter: (Math.floor(now.getMonth() / 3) + 1) as Quarter,
    startedOn: now.toISOString().slice(0, 10),
    note: ''
  }
}

/** 由调查日期归入季度巡次：取年份与所属季度 */
export function quarterOfDate(date: string): { year: number; quarter: Quarter } {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date()
    return { year: fallback.getFullYear(), quarter: (Math.floor(fallback.getMonth() / 3) + 1) as Quarter }
  }
  return {
    year: parsed.getFullYear(),
    quarter: (Math.floor(parsed.getMonth() / 3) + 1) as Quarter
  }
}

/** 季度中文区间文本（档案室展示用） */
export function quarterLabel(quarter: Quarter): string {
  return ['1-3 月', '4-6 月', '7-9 月', '10-12 月'][quarter - 1]
}
