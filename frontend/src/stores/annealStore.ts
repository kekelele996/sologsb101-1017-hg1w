/**
 * 退火窑位与曲线状态管理（Pinia）——窑务排产员视角
 * 维护排产账：窑位占用表、退火曲线段、入窑 / 出炉时刻、退火轮次。
 * 窑位冲突时禁止提交；出炉即回写作品状态。
 * 重烧单由质检账开具，排产员在「待排」队列里接收：另开一条 round+1 的炉次，
 * 原炉排位保留不动。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import type { Refire } from '../types/refire'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  holdRefire,
  initDatabase,
  putAnneal,
  reconcileAndHold,
  refreshRefireStates,
  removeAnneal,
  scheduleRefire,
  unholdRefire,
} from '../utils/db'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
  /** 是否只看重烧炉次（round > 1） */
  refireOnly: boolean
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  round: number
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all', refireOnly: false }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const refires = ref<Refire[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          round: row.round,
          occupied: row.state !== '已出炉',
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  /** 质检判完、等排产员接收的重烧队列（原炉确已出炉） */
  const waitingRefires = computed<Refire[]>(() => refires.value.filter((row) => row.state === '待排'))
  /** 原炉还在烧、暂不打断在烧炉次的重烧单 */
  const firingRefires = computed<Refire[]>(() => refires.value.filter((row) => row.state === '待出炉'))
  const heldRefires = computed<Refire[]>(() => refires.value.filter((row) => row.state === '挂起'))

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (filters.refireOnly && row.round <= 1) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id)
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      await refreshRefireStates().catch(() => undefined)
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, refireRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.refires.toArray(),
          ])
          return { annealRows, pieceRows, refireRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, refireRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            refires.value = [...refireRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      // 排产员手动排位为首烧第 1 轮；重烧另开由 scheduleRefire 处理
      round: 1,
      sourceRefireId: '',
      sourceAnnealId: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value =
      existing.round > 1 ? `第 ${existing.round} 轮重烧编排已更新（原炉排位保留）` : '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除；若它是重烧炉次，对应重烧单已退回待排，原炉排位仍保留'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态与重烧单完成态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    if (next === '已出炉') {
      if (existing.round > 1) {
        lastMessage.value = '重烧炉次已出炉，重烧单标记完成；可在检验页登记复检'
      } else if (existing.sourceRefireId === '') {
        // 检查是否有等待这一炉出炉的重烧单（同作品更早轮次的缺陷单不会有，兜底对账）
        await refreshRefireStates().catch(() => undefined)
        lastMessage.value = '已登记出炉，作品状态已回写为「已退火」，可登记出炉检验'
      } else {
        lastMessage.value = '已登记出炉'
      }
    } else {
      lastMessage.value = `退火状态已推进为「${next}」`
    }
    return next
  }

  /**
   * 接收质检退回的重烧单并另开炉次（round + 1），原炉排位保留。
   * 先做窑位冲突校验（在烧炉次占着窑位时重烧只能换时段 / 换窑位，避免撞车）。
   */
  async function scheduleFromRefire(refireId: string, draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = checkSlotConflict(
      anneals.value,
      { id: '', ...draft },
      wallThicknessOf,
      '',
    )
    if (conflict.conflict) {
      lastMessage.value = `重烧排位撞车：${conflict.message}`
      return null
    }
    try {
      const { anneal } = await scheduleRefire(refireId, draft)
      revision.value += 1
      lastMessage.value = `已为重烧单另开第 ${anneal.round} 轮炉次（窑位 ${anneal.kilnSlot}），原炉排位保留不动`
      return anneal
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '重烧排产失败'
      return null
    }
  }

  async function holdRefireById(refireId: string, reason: string): Promise<void> {
    await holdRefire(refireId, reason)
    revision.value += 1
    lastMessage.value = '重烧单已挂起'
  }

  async function unholdRefireById(refireId: string): Promise<void> {
    const updated = await unholdRefire(refireId)
    revision.value += 1
    lastMessage.value = updated === null ? '重烧单不存在' : `重烧单已解挂，回到「${updated.state}」`
  }

  /** 排产侧按作品 + 窑位对账（件数对不上自动挂起） */
  async function reconcile(): Promise<void> {
    const result = await reconcileAndHold()
    const errorCount = result.issues.filter((issue) => issue.level === 'error').length
    lastMessage.value =
      errorCount === 0 ? '两本账对账一致' : `对账发现 ${errorCount} 处不符，相关重烧单已挂起`
    revision.value += 1
  }

  return {
    anneals,
    pieces,
    refires,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    waitingRefires,
    firingRefires,
    heldRefires,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    scheduleFromRefire,
    holdRefireById,
    unholdRefireById,
    reconcile,
  }
})
