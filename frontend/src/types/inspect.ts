/**
 * 出炉检验（Inspect）——质检账
 * 质检员独管：检验结论与缺陷说明，按作品挂到具体那一炉退火上（annealId + 窑位快照）。
 * 判定不合格（重烧）时只开具重烧单，不触碰排产账的窑位与炉次记录。
 */

/** 检验结果：合格 / 裂纹 / 气泡 / 变形 */
export type InspectResult = '合格' | '裂纹' | '气泡' | '变形'

export const INSPECT_RESULT_OPTIONS: InspectResult[] = ['合格', '裂纹', '气泡', '变形']

/** 不合格、需要开具重烧单的结论 */
export const DEFECT_RESULTS: InspectResult[] = ['裂纹', '气泡', '变形']

export function isDefectResult(result: InspectResult): boolean {
  return result !== '合格'
}

export interface Inspect {
  id: string
  /** 所属作品 */
  pieceId: string
  /**
   * 挂账炉次：该检验挂在哪一炉退火上（排产账 anneals.id）。
   * v3 迁移按作品当时的退火记录回填；回填不上的老记录只读，保持空串。
   */
  annealId: string
  /** 挂账窑位快照（质检账自带的对账字段，排产账改动不影响本字段） */
  kilnSlot: string
  /** 挂账炉次的入窑 / 出炉时刻快照 */
  inAt: string
  outAt: string
  /** 检验结果 */
  result: InspectResult
  /** 缺陷说明 */
  defectNote: string
  /** 检验人 */
  inspector: string
  /** 检验日期 YYYY-MM-DD */
  date: string
  /** 该次判定开具的重烧单 id（合格记录为空串） */
  refireId: string
  /** v3 迁移回填不上挂账炉次的老记录只读 */
  readOnly: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑出炉检验的表单草稿（挂账炉次从该作品已出炉炉次中选择） */
export interface InspectDraft {
  pieceId: string
  annealId: string
  result: InspectResult
  defectNote: string
  inspector: string
  date: string
}
