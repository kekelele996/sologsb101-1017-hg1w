/**
 * 退火（Anneal）——排产账
 * 窑务排产员独管：窑位、曲线段、入窑 / 出炉时刻、退火轮次。
 * 窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 * 重烧另开一条记录（round + 1），原始炉次排位永久保留、不复用。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1 */
  kilnSlot: string
  /** 曲线段 */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 退火轮次：1 = 首烧，2 起为第 N 次重烧（重烧另开一条，不覆盖原炉排位） */
  round: number
  /** 由哪张重烧单开窑（仅重烧记录有值，首烧为空串） */
  sourceRefireId: string
  /** 重烧追溯的上一炉退火记录（仅重烧记录有值） */
  sourceAnnealId: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿（轮次与重烧链由排产动作自动赋值，不在表单里手填） */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
}
