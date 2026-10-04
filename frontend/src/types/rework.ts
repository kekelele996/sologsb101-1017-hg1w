/**
 * 重烧请求（ReworkRequest）
 * 质检判不合格后生成；不打断在烧的那炉，等确实出炉后再退回待排（新开一条退火记录）。
 * 原来那炉的排位保留不动，重烧另开一条 Anneal（reworkOf 指向原炉）。
 */
import type { InspectResult } from './inspect'

/** 重烧状态：待出炉（等在烧的那炉出炉）/ 已退回待排（已新开退火记录）/ 已取消 */
export type ReworkState = '待出炉' | '已退回待排' | '已取消'

export const REWORK_STATE_OPTIONS: ReworkState[] = ['待出炉', '已退回待排', '已取消']

export interface ReworkRequest {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 触发重烧的检验记录（质检台账） */
  sourceInspectId: string
  /** 原来那炉的退火记录（排产台账），排位保留不动 */
  originalAnnealId: string
  /** 重烧原因（检验结果） */
  reason: InspectResult
  /** 重烧状态 */
  state: ReworkState
  /** 退回待排后新开的退火记录 id；待出炉时为空串 */
  newAnnealId: string
  createdAt: string
  updatedAt: string
  revision: number
}
