/**
 * 年度定案巡次（礁区档案室侧）。
 * 档案室管礁区与「哪一次巡访作为某年度的定案巡次」；
 * 定案巡次定下后，礁区覆盖率、白化指数与导出结论一律按那次重出。
 * 档案室只能选定 / 改选定案巡次，绝不回退或改动外业普查组的巡访原始记录。
 */
import type { Visit } from '@/types/visit'

/** 年度定案：一个礁区在一个年份只对应一条定案记录 */
export interface AnnualFinalization {
  id: string
  /** 所属礁区 */
  reefId: string
  /** 定案年份 */
  year: number
  /** 定案采用的巡次 id（指向 visits 表中外业普查组登记的某次巡访） */
  visitId: string
  /** 档案室经办人 */
  archivist: string
  /** 定案意见 */
  opinion: string
  /** 定案时间（ms 时间戳） */
  finalizedAt: number
  createdAt: number
  updatedAt: number
}

/** 年度定案草稿 */
export interface FinalizationDraft {
  reefId: string
  year: number
  visitId: string
  archivist: string
  opinion: string
}

/** 生成定案主键：同礁区同年份唯一 */
export function finalizationId(reefId: string, year: number): string {
  return `final_${reefId}_${year}`
}

export function createEmptyFinalizationDraft(reefId = '', year = new Date().getFullYear()): FinalizationDraft {
  return { reefId, year, visitId: '', archivist: '', opinion: '' }
}

/** 定案记录是否指向某条仍存在的巡次（巡次被删时定案不回退，但要标红提示） */
export function finalizationVisitStillExists(finalization: AnnualFinalization, visits: Visit[]): boolean {
  return visits.some((visit) => visit.id === finalization.visitId)
}
