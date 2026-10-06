/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/** 样带：站位上某次巡访布设的普查样带 */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /**
   * 所属巡次（外业普查组登记）。
   * 同编号样带在不同巡次里各是一条（各自带 visitId），覆盖率 / 白化指数按巡次分开算。
   * 旧数据升级时按调查日期归入季度巡次；补不出的为 null，由「未挂巡次样带」单列。
   */
  visitId: string | null
  /** 样带编号，如 T-01 */
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
  visitId: string | null
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = '', visitId: string | null = null): BeltDraft {
  return {
    visitId,
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
