/**
 * 重烧单（Refire）——质检账与排产账之间的交接单
 *
 * 质检员判定重烧后开具：只回写质检侧（inspects / refires），不动排产账。
 * 排产员接收后另开一条退火记录（round + 1），原炉次排位保留。
 *
 * 状态流：
 *   待出炉 —— 原炉次还在烧（未出炉），不打断在烧的这一炉，重烧单先挂起等待；
 *   待排   —— 原炉次确实出炉后自动转入，等排产员重新排位；
 *   已排产 —— 排产员已为它另开退火记录，等待入窑 / 出炉；
 *   已完成 —— 重烧炉次已出炉；
 *   挂起   —— 按作品与窑位对账件数对不上（或人工挂起），两边先冻结交接。
 */

/** 重烧单状态 */
export type RefireState = '待出炉' | '待排' | '已排产' | '已完成' | '挂起'

export const REFIRE_STATE_OPTIONS: RefireState[] = ['待出炉', '待排', '已排产', '已完成', '挂起']

/** 自动流转顺序（挂起除外，挂起 / 解挂由对账动作驱动） */
export const REFIRE_STATE_FLOW: RefireState[] = ['待出炉', '待排', '已排产', '已完成']

export interface Refire {
  id: string
  /** 重烧作品 */
  pieceId: string
  /** 开具重烧的检验记录 id */
  inspectId: string
  /** 被判重烧的原炉次退火记录 id（原炉排位保留不动） */
  sourceAnnealId: string
  /** 原炉次窑位（对账快照） */
  sourceKilnSlot: string
  /** 原炉次入窑时刻（对账快照） */
  sourceInAt: string
  /** 原炉次出炉时刻（出窑前可能为空串） */
  sourceOutAt: string
  /** 缺陷结论（裂纹 / 气泡 / 变形） */
  defectResult: string
  /** 缺陷说明（自检验记录复制，方便排产员不翻质检账就能看） */
  defectNote: string
  /** 排产员另开的重烧退火记录 id（未排产前为空串） */
  reAnnealId: string
  /** 重烧窑位（排产员分配后回填，用于对账） */
  reKilnSlot: string
  state: RefireState
  /** 挂起原因（对账件数不符时写入，解挂清空） */
  holdReason: string
  /** 已重试落账次数（质检侧重试计数器；只与质检账有关） */
  retryCount: number
  createdAt: string
  updatedAt: string
  revision: number
}
