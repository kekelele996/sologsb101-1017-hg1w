/**
 * 对账工具：排产台账（Anneal）与质检台账（Inspect）按「作品 + 窑位」对账。
 * - 已出炉但无检验 → 待质检（不挂起）
 * - 有检验但无对应已出炉退火记录 → 挂起（质检有、排产无）
 * - 同作品已出炉退火数与检验数对不上 → 件数对不上，先挂起
 */
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { Piece } from '../types/piece'

export type ReconcileStatus = 'matched' | 'pending' | 'suspended'

export interface ReconcileRow {
  pieceId: string
  pieceName: string
  kilnSlot: string
  annealId: string
  inspectId: string
  status: ReconcileStatus
  /** 备注（如：件数对不上） */
  note: string
}

export interface PieceCount {
  pieceId: string
  pieceName: string
  /** 已出炉退火记录数（排产侧应检验的炉数） */
  annealCount: number
  /** 检验记录数（质检侧已检的炉数） */
  inspectCount: number
  /** 件数是否对得上 */
  match: boolean
}

export interface ReconcileResult {
  rows: ReconcileRow[]
  /** 挂起：质检有、排产无（按作品 + 窑位对不上） */
  suspended: ReconcileRow[]
  /** 待质检：已出炉但还没检验 */
  pending: ReconcileRow[]
  /** 件数对不上的作品 */
  mismatchedCounts: PieceCount[]
  /** 全部对得上（无挂起、无待质检、件数一致） */
  balanced: boolean
}

const keyOf = (pieceId: string, kilnSlot: string): string => `${pieceId}::${kilnSlot}`

export function reconcile(anneals: Anneal[], inspects: Inspect[], pieces: Piece[]): ReconcileResult {
  const pieceName = (id: string): string => pieces.find((p) => p.id === id)?.name ?? '（作品已删除）'

  // 只对「已出炉」的退火记录对账（退火中 / 待入窑还没到检验环节）
  const fired = anneals.filter((a) => a.state === '已出炉')
  const annealMap = new Map<string, Anneal>()
  fired.forEach((a) => annealMap.set(keyOf(a.pieceId, a.kilnSlot), a))

  const inspectMap = new Map<string, Inspect>()
  inspects.forEach((i) => {
    // 只读老记录可能没有窑位，用 annealId 对应的退火记录兜底
    const slot = i.kilnSlot || anneals.find((a) => a.id === i.annealId)?.kilnSlot || ''
    if (slot !== '') inspectMap.set(keyOf(i.pieceId, slot), i)
  })

  const rows: ReconcileRow[] = []
  const suspended: ReconcileRow[] = []
  const pending: ReconcileRow[] = []

  // 已出炉退火：有检验 → matched；无检验 → 待质检
  annealMap.forEach((a, key) => {
    const inspect = inspectMap.get(key)
    if (inspect) {
      rows.push({
        pieceId: a.pieceId,
        pieceName: pieceName(a.pieceId),
        kilnSlot: a.kilnSlot,
        annealId: a.id,
        inspectId: inspect.id,
        status: 'matched',
        note: '',
      })
    } else {
      const row: ReconcileRow = {
        pieceId: a.pieceId,
        pieceName: pieceName(a.pieceId),
        kilnSlot: a.kilnSlot,
        annealId: a.id,
        inspectId: '',
        status: 'pending',
        note: '已出炉待检验',
      }
      rows.push(row)
      pending.push(row)
    }
  })

  // 检验：没有对应已出炉退火 → 挂起（质检有、排产无，先挂起）
  inspectMap.forEach((i, key) => {
    if (annealMap.has(key)) return
    const row: ReconcileRow = {
      pieceId: i.pieceId,
      pieceName: pieceName(i.pieceId),
      kilnSlot: i.kilnSlot,
      annealId: i.annealId,
      inspectId: i.id,
      status: 'suspended',
      note: '质检有检验、排产无对应已出炉炉记录，先挂起',
    }
    rows.push(row)
    suspended.push(row)
  })

  // 件数对账：按作品统计已出炉退火数 vs 检验数，对不上先挂起
  const pieceIds = new Set<string>()
  fired.forEach((a) => pieceIds.add(a.pieceId))
  inspects.forEach((i) => pieceIds.add(i.pieceId))
  const mismatchedCounts: PieceCount[] = []
  pieceIds.forEach((pid) => {
    const ac = fired.filter((a) => a.pieceId === pid).length
    const ic = inspects.filter((i) => i.pieceId === pid).length
    if (ac !== ic) {
      mismatchedCounts.push({ pieceId: pid, pieceName: pieceName(pid), annealCount: ac, inspectCount: ic, match: false })
    }
  })

  const balanced = suspended.length === 0 && pending.length === 0 && mismatchedCounts.length === 0
  return { rows, suspended, pending, mismatchedCounts, balanced }
}
