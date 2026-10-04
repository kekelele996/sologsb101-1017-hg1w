/**
 * 出炉检验（Inspect）—— 质检台账
 * 按作品挂到「那一炉」退火记录上（annealId + kilnSlot），与排产台账（Anneal）按作品和窑位对账。
 * 判定不合格时生成返工提示并保留原始工序记录；对不上窑位的老记录只读。
 */

/** 检验结果：合格 / 裂纹 / 气泡 / 变形 */
export type InspectResult = '合格' | '裂纹' | '气泡' | '变形'

export const INSPECT_RESULT_OPTIONS: InspectResult[] = ['合格', '裂纹', '气泡', '变形']

/** 是否需要返工：合格以外的结果都触发重烧 */
export function needsRework(result: InspectResult): boolean {
  return result !== '合格'
}

export interface Inspect {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 被检验的那一炉（退火记录 id）；老数据升级前可能为空串 */
  annealId: string
  /** 对账用窑位（从退火记录冗余）；老数据对不上时为空串 */
  kilnSlot: string
  /** 检验结果 */
  result: InspectResult
  /** 缺陷说明 */
  defectNote: string
  /** 检验人 */
  inspector: string
  /** 检验日期 YYYY-MM-DD */
  date: string
  /**
   * 老数据升级后对不上窑位时为 true：只读，不可编辑 / 删除，也不参与对账写回。
   * 新登记的检验一律为 false。
   */
  readonly: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑出炉检验的表单草稿 */
export interface InspectDraft {
  pieceId: string
  /** 被检验的那一炉（退火记录 id） */
  annealId: string
  result: InspectResult
  defectNote: string
  inspector: string
  date: string
}
