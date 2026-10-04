/**
 * 两本账对账工具（纯函数，不触碰数据库）
 *
 * 排产账（anneals：窑位 / 曲线段 / 入出炉时刻）与质检账（inspects：结论 / 缺陷；
 * refires：重烧交接单）按「作品 + 窑位」对账：
 * - 件数对不上、重烧链断裂、窑位快照不一致 → 产出 issue；
 * - 能落到重烧单上的差错给出自动挂起建议（id → 原因），由数据层执行挂起；
 * - 老记录（v3 前检验未挂窑位）只报 info，保持只读，不参与挂起。
 */
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { Refire } from '../types/refire'

export type ReconcileIssueKind =
  | 'missing-source'
  | 'piece-mismatch'
  | 'slot-mismatch'
  | 'missing-reanneal'
  | 'chain-dangling'
  | 'duplicate-refire'
  | 'count-mismatch'
  | 'legacy-unlinked'
  | 'missing-inspect'

export interface ReconcileIssue {
  kind: ReconcileIssueKind
  level: 'error' | 'warning' | 'info'
  pieceId: string
  refireId?: string
  inspectId?: string
  annealId?: string
  message: string
}

export interface PieceLedgerCount {
  pieceId: string
  /** 排产账件数：退火炉次总数 */
  annealCount: number
  /** 质检账件数：检验记录（不含只读老记录） */
  inspectCount: number
  /** 在途重烧单（待出炉 / 待排 / 已排产，不含挂起 / 已完成） */
  activeRefireCount: number
  /** 已另开炉次的重烧单（已排产 / 已完成）—— 每张对应排产账多出一炉 */
  scheduledRefireCount: number
  mismatch: boolean
}

export interface ReconcileReport {
  issues: ReconcileIssue[]
  /** 建议自动挂起的重烧单 id 与原因 */
  holds: Record<string, string>
  countsByPiece: PieceLedgerCount[]
}

function groupByPiece(rows: Array<{ pieceId: string }>): Map<string, number> {
  const map = new Map<string, number>()
  rows.forEach((row) => map.set(row.pieceId, (map.get(row.pieceId) ?? 0) + 1))
  return map
}

/**
 * 执行对账；existingHolds 为当前已挂起重烧单集合（已挂起的不重复建议，
 * 但 issue 仍照常列出，供页面展示挂起原因）。
 */
export function reconcileLedgers(
  anneals: Anneal[],
  inspects: Inspect[],
  refires: Refire[],
): ReconcileReport {
  const issues: ReconcileIssue[] = []
  const holds: Record<string, string> = {}

  const annealById = new Map(anneals.map((row) => [row.id, row]))
  const inspectById = new Map(inspects.map((row) => [row.id, row]))

  const pushHold = (refireId: string, reason: string): void => {
    if (refireId !== '' && holds[refireId] === undefined) holds[refireId] = reason
  }

  /* ---------------- 质检账：检验记录 ↔ 挂账炉次 ---------------- */
  inspects.forEach((inspect) => {
    if (inspect.annealId === '') {
      // v3 前的老记录：升级时回填不上，只读，仅提示
      if (inspect.readOnly) {
        issues.push({
          kind: 'legacy-unlinked',
          level: 'info',
          pieceId: inspect.pieceId,
          inspectId: inspect.id,
          message: `老检验记录（${inspect.date} · ${inspect.result}）升级时未找到对应退火炉次，保持只读、不参与重烧交接。`,
        })
      } else {
        issues.push({
          kind: 'slot-mismatch',
          level: 'error',
          pieceId: inspect.pieceId,
          inspectId: inspect.id,
          message: `检验记录 ${inspect.id} 未挂窑位，无法与排产账对账。`,
        })
      }
      return
    }
    const anneal = annealById.get(inspect.annealId)
    if (anneal === undefined) {
      issues.push({
        kind: 'missing-source',
        level: 'error',
        pieceId: inspect.pieceId,
        inspectId: inspect.id,
        annealId: inspect.annealId,
        message: `检验记录挂账炉次 ${inspect.annealId} 在排产账中不存在（窑位 ${inspect.kilnSlot || '未知'}），件数对不上。`,
      })
      return
    }
    if (anneal.pieceId !== inspect.pieceId) {
      issues.push({
        kind: 'piece-mismatch',
        level: 'error',
        pieceId: inspect.pieceId,
        inspectId: inspect.id,
        annealId: anneal.id,
        message: `检验记录挂在炉次 ${anneal.id} 上，但两边作品不一致（质检账 ${inspect.pieceId} / 排产账 ${anneal.pieceId}）。`,
      })
    }
    if (inspect.kilnSlot !== '' && anneal.kilnSlot !== inspect.kilnSlot) {
      issues.push({
        kind: 'slot-mismatch',
        level: 'error',
        pieceId: inspect.pieceId,
        inspectId: inspect.id,
        annealId: anneal.id,
        message: `窑位对不上：质检账记的是 ${inspect.kilnSlot}，排产账炉次 ${anneal.id} 现为 ${anneal.kilnSlot}。`,
      })
    }
  })

  /* ---------------- 重烧链：refire ↔ 原炉次 / 重烧炉次 ---------------- */
  const sourceUsage = new Map<string, string[]>()
  refires.forEach((refire) => {
    const list = sourceUsage.get(refire.sourceAnnealId) ?? []
    list.push(refire.id)
    sourceUsage.set(refire.sourceAnnealId, list)
  })

  refires.forEach((refire) => {
    const source = annealById.get(refire.sourceAnnealId)

    // 同一炉次被多张重烧单引用：件数对不上
    const dupes = sourceUsage.get(refire.sourceAnnealId) ?? []
    if (dupes.length > 1) {
      issues.push({
        kind: 'duplicate-refire',
        level: 'error',
        pieceId: refire.pieceId,
        refireId: refire.id,
        annealId: refire.sourceAnnealId,
        message: `原炉次 ${refire.sourceAnnealId} 挂了 ${dupes.length} 张重烧单（${dupes.join('、')}），件数对不上。`,
      })
      pushHold(refire.id, `同一原炉次存在 ${dupes.length} 张重烧单，件数对不上`)
    }

    // 质检账开出的检验单本身还在不在
    if (inspectById.get(refire.inspectId) === undefined) {
      issues.push({
        kind: 'missing-inspect',
        level: 'error',
        pieceId: refire.pieceId,
        refireId: refire.id,
        message: `重烧单 ${refire.id} 对应的检验记录 ${refire.inspectId} 在质检账中缺失。`,
      })
      pushHold(refire.id, '重烧单对应的检验记录缺失')
    }

    if (source === undefined) {
      issues.push({
        kind: 'missing-source',
        level: 'error',
        pieceId: refire.pieceId,
        refireId: refire.id,
        annealId: refire.sourceAnnealId,
        message: `重烧单的原炉次 ${refire.sourceAnnealId}（窑位 ${refire.sourceKilnSlot || '未知'}）在排产账中不存在，原炉排位缺失。`,
      })
      pushHold(refire.id, '原炉次排位在排产账中缺失')
      return
    }

    if (source.pieceId !== refire.pieceId) {
      issues.push({
        kind: 'piece-mismatch',
        level: 'error',
        pieceId: refire.pieceId,
        refireId: refire.id,
        annealId: source.id,
        message: `重烧单作品 ${refire.pieceId} 与原炉次作品 ${source.pieceId} 不一致。`,
      })
      pushHold(refire.id, '重烧单与原炉次作品不一致')
    }
    if (source.kilnSlot !== refire.sourceKilnSlot) {
      issues.push({
        kind: 'slot-mismatch',
        level: 'error',
        pieceId: refire.pieceId,
        refireId: refire.id,
        annealId: source.id,
        message: `原炉窑位对不上：重烧单记 ${refire.sourceKilnSlot}，排产账为 ${source.kilnSlot}。`,
      })
      pushHold(refire.id, `原炉窑位对不上（${refire.sourceKilnSlot} ≠ ${source.kilnSlot}）`)
    }

    if (refire.reAnnealId !== '') {
      const reAnneal = annealById.get(refire.reAnnealId)
      if (reAnneal === undefined) {
        issues.push({
          kind: 'missing-reanneal',
          level: 'error',
          pieceId: refire.pieceId,
          refireId: refire.id,
          annealId: refire.reAnnealId,
          message: `重烧单标记已排产，但重烧炉次 ${refire.reAnnealId} 在排产账中不存在。`,
        })
        pushHold(refire.id, '重烧炉次在排产账中缺失')
      } else {
        if (reAnneal.pieceId !== refire.pieceId) {
          issues.push({
            kind: 'piece-mismatch',
            level: 'error',
            pieceId: refire.pieceId,
            refireId: refire.id,
            annealId: reAnneal.id,
            message: `重烧炉次 ${reAnneal.id} 的作品与重烧单不一致。`,
          })
          pushHold(refire.id, '重烧炉次作品与重烧单不一致')
        }
        if (reAnneal.sourceRefireId !== refire.id) {
          issues.push({
            kind: 'chain-dangling',
            level: 'error',
            pieceId: refire.pieceId,
            refireId: refire.id,
            annealId: reAnneal.id,
            message: `重烧炉次 ${reAnneal.id} 没有回指本重烧单（回指 ${reAnneal.sourceRefireId || '空'}），重烧链断裂。`,
          })
          pushHold(refire.id, '重烧炉次未回指重烧单，链路断裂')
        }
        if (reAnneal.round !== source.round + 1) {
          issues.push({
            kind: 'chain-dangling',
            level: 'warning',
            pieceId: refire.pieceId,
            refireId: refire.id,
            annealId: reAnneal.id,
            message: `重烧轮次不衔接：原炉第 ${source.round} 轮，重烧炉次标的是第 ${reAnneal.round} 轮。`,
          })
        }
      }
    }
  })

  // 排产账里回指了不存在的重烧单（孤儿子炉次）
  anneals.forEach((anneal) => {
    if (anneal.sourceRefireId !== '' && !refires.some((refire) => refire.id === anneal.sourceRefireId)) {
      issues.push({
        kind: 'chain-dangling',
        level: 'error',
        pieceId: anneal.pieceId,
        annealId: anneal.id,
        message: `第 ${anneal.round} 轮重烧炉次 ${anneal.id} 回指的重烧单 ${anneal.sourceRefireId} 在质检账中不存在。`,
      })
    }
  })

  /* ---------------- 按作品汇总件数 ---------------- */
  const annealCounts = groupByPiece(anneals)
  const inspectCounts = groupByPiece(inspects.filter((row) => !row.readOnly))
  const activeRefires = refires.filter((row) => row.state === '待出炉' || row.state === '待排' || row.state === '已排产')
  const activeRefireCounts = groupByPiece(activeRefires)
  const scheduledRefires = refires.filter((row) => row.state === '已排产' || row.state === '已完成')
  const scheduledRefireCounts = groupByPiece(scheduledRefires)
  const pieceIds = new Set<string>([
    ...annealCounts.keys(),
    ...inspectCounts.keys(),
    ...activeRefireCounts.keys(),
  ])

  const countsByPiece: PieceLedgerCount[] = []
  pieceIds.forEach((pieceId) => {
    const annealCount = annealCounts.get(pieceId) ?? 0
    const inspectCount = inspectCounts.get(pieceId) ?? 0
    const activeRefireCount = activeRefireCounts.get(pieceId) ?? 0
    const scheduledRefireCount = scheduledRefireCounts.get(pieceId) ?? 0
    // 排产账炉次 = 首烧一炉 + 每张已接收重烧单另开的一炉；
    // 待出炉 / 待排 / 挂起的重烧单还没另开新炉，排产账不增炉。
    const expectedAnneals = 1 + scheduledRefireCount
    // 完全没有排产账炉次的情况由挂账缺失 issue 负责，这里只核对「有炉次」作品的件数恒等式
    const mismatch = annealCount > 0 && annealCount !== expectedAnneals
    if (mismatch) {
      issues.push({
        kind: 'count-mismatch',
        level: 'error',
        pieceId,
        message: `作品 ${pieceId} 件数对不上：排产账 ${annealCount} 炉（应为 1 + ${scheduledRefireCount} 已接收重烧 = ${expectedAnneals}），先挂起该作品在途的重烧单。`,
      })
      activeRefires
        .filter((row) => row.pieceId === pieceId)
        .forEach((row) => pushHold(row.id, `作品件数对不上（排产 ${annealCount} 炉 / 应为 ${expectedAnneals} 炉）`))
    }
    countsByPiece.push({ pieceId, annealCount, inspectCount, activeRefireCount, scheduledRefireCount, mismatch })
  })

  return { issues, holds, countsByPiece }
}
