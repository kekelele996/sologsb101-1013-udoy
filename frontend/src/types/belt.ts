/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/**
 * 样带：站位上某次巡访布设的普查样带。
 * 同编号样带在不同巡次（visitId）里各是一条独立记录，
 * 各自的珊瑚记录与鱼类计数分别汇总，覆盖率/白化指数不跨巡次混算。
 */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /** 所属巡访（普查组每次重访一条 Visit） */
  visitId: string
  /** 样带编号，如 T-01（编号唯一性按「巡次 + 站位」约束，跨巡次可重复） */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  createdAt: number
  updatedAt: number
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
