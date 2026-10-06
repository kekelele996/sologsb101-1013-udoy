import type { Quarter } from '@/types/visit'

/** 对账结果状态：无对不上的样带/巡次即通过，否则失败（失败只重跑普查侧，定案不回退） */
export type ReconciliationStatus = '通过' | '失败'

/**
 * 对不上条目的类别（单列展示）：
 * - 样带编号对不上：同站位样带编号仅出现在非定案巡次（跨巡次补位后仍取不到同编号）
 * - 站位编号对不上：样带所属站位在该礁区站位台账中缺失
 * - 巡次对不上：整条巡次与定案巡次没有任何站位编号+样带编号交集
 * - 补登未归位：样带挂在补登巡次下，无法归位到任一定案编号
 * - 定案编号重复：定案巡次内同一站位编号+样带编号出现多条
 */
export type MismatchKind = '样带编号对不上' | '站位编号对不上' | '巡次对不上' | '补登未归位' | '定案编号重复'

export interface MismatchItem {
  kind: MismatchKind
  visitId: string
  visitCode: string
  siteId: string
  siteNo: string
  beltId: string
  beltNo: string
  detail: string
}

/**
 * 一次对账记录：档案室选定/重跑对账时生成。
 * 对账只读取普查侧记录重算，永不修改 ReefFinalization（档案室定的巡次不回退）。
 */
export interface ReconciliationRun {
  id: string
  /** 关联定案 id */
  finalizationId: string
  reefId: string
  year: number
  /** 本次对账所依据的定案巡次（快照自 ReefFinalization.visitId） */
  visitId: string
  quarter: Quarter
  /** 对账时采用的口径说明 */
  policy: string
  /** 纳入评定的样带数（定案覆盖 + 跨巡次补位） */
  resolvedBeltCount: number
  /** 对不上条目数 */
  mismatchCount: number
  status: ReconciliationStatus
  mismatches: MismatchItem[]
  runAt: number
}

/** 生成对账记录主键 */
export function reconciliationRunId(finalizationKeyValue: string, runAt: number): string {
  return `rec_${finalizationKeyValue}_${runAt.toString(36)}`
}
