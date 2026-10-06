import type { Quarter } from '@/types/visit'

/**
 * 年度定案（ReefFinalization）：礁区档案室对「某礁区某一年」定下的权威巡次。
 * - 由档案室从该礁区该年的普查巡次里选定一条 visitId；
 * - 定下后，礁区覆盖率、白化指数与导出结论只按该次重出，普查组原始记录照旧保留。
 */
export interface ReefFinalization {
  id: string
  /** 礁区 id */
  reefId: string
  /** 定案年份 */
  year: number
  /** 定案采用的巡次 id（档案室选定，不随普查侧重跑回退） */
  visitId: string
  /** 定案时的季度（冗余快照，便于列表展示） */
  quarter: Quarter
  /** 定案人 / 审核人 */
  decidedBy: string
  /** 定案说明 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 生成定案主键：礁区 + 年份，保证一礁区一年只有一条定案 */
export function finalizationId(reefId: string, year: number): string {
  return `fin_${reefId}_${year}`
}

export interface FinalizationDraft {
  reefId: string
  year: number
  visitId: string
  decidedBy: string
  note: string
}
