/**
 * 质检账状态管理（Pinia）——质检员视角
 * 独管检验结论、缺陷说明与重烧交接单；按作品挂到那一炉退火上。
 * 质检落账走 db.submitInspect / updateInspect / removeInspect：
 * 事务只覆盖 inspects + refires，失败按本侧重试，全程不写排产账 anneals。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Inspect, InspectDraft, InspectResult } from '../types/inspect'
import { isDefectResult } from '../types/inspect'
import type { Refire, RefireState } from '../types/refire'
import type { Anneal } from '../types/anneal'
import type { Piece } from '../types/piece'
import {
  db,
  holdRefire,
  initDatabase,
  listInspects,
  listRefires,
  reconcileAndHold,
  removeInspect,
  submitInspect,
  unholdRefire,
  updateInspect,
  type QcSubmitOutcome,
} from '../utils/db'
import type { ReconcileReport } from '../utils/reconcile'

export interface InspectFilters {
  keyword: string
  result: InspectResult | 'all'
  refireState: RefireState | 'all'
}

const EMPTY_FILTERS: InspectFilters = { keyword: '', result: 'all', refireState: 'all' }

let subscribed = false

export const useInspectStore = defineStore('inspect', () => {
  const inspects = ref<Inspect[]>([])
  const refires = ref<Refire[]>([])
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  /** 最近一次落账的重试信息（attempts > 1 即发生过本侧重试） */
  const lastAttempts = ref(1)
  const report = ref<ReconcileReport | null>(null)
  const reconciling = ref(false)
  const filters = reactive<InspectFilters>({ ...EMPTY_FILTERS })

  const annealById = computed<Map<string, Anneal>>(() => new Map(anneals.value.map((row) => [row.id, row])))

  /** 某作品可挂账的炉次：只允许挂「确实出炉」的那一炉（按入窑时间倒序） */
  function outedAnnealsOfPiece(pieceId: string): Anneal[] {
    return anneals.value
      .filter((row) => row.pieceId === pieceId && row.state === '已出炉' && row.outAt !== '')
      .sort((a, b) => b.outAt.localeCompare(a.outAt))
  }

  /** 某作品全部炉次（含轮次，用于展示重烧链） */
  function annealsOfPiece(pieceId: string): Anneal[] {
    return anneals.value
      .filter((row) => row.pieceId === pieceId)
      .sort((a, b) => a.round - b.round || a.inAt.localeCompare(b.inAt))
  }

  function refireOfInspect(inspectId: string): Refire | undefined {
    const inspect = inspects.value.find((row) => row.id === inspectId)
    if (inspect === undefined || inspect.refireId === '') return undefined
    return refires.value.find((row) => row.id === inspect.refireId)
  }

  function refireById(id: string): Refire | undefined {
    return refires.value.find((row) => row.id === id)
  }

  const pendingRefires = computed<Refire[]>(() =>
    refires.value
      .filter((row) => row.state === '待出炉' || row.state === '待排')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  )
  const waitingSchedule = computed<Refire[]>(() => refires.value.filter((row) => row.state === '待排'))
  const heldRefires = computed<Refire[]>(() => refires.value.filter((row) => row.state === '挂起'))
  const activeDefectCount = computed<number>(() => refires.value.filter((row) => row.state !== '已完成').length)

  const visibleInspects = computed<Inspect[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return inspects.value.filter((row) => {
      if (filters.result !== 'all' && row.result !== filters.result) return false
      if (filters.refireState !== 'all') {
        const state = row.refireId === '' ? null : refireById(row.refireId)?.state ?? null
        if (state !== filters.refireState) return false
      }
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inspector.toLowerCase().includes(keyword) ||
        row.defectNote.toLowerCase().includes(keyword) ||
        row.kilnSlot.toLowerCase().includes(keyword)
      )
    })
  })

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [inspectRows, refireRows, annealRows, pieceRows] = await Promise.all([
            db.inspects.toArray(),
            db.refires.toArray(),
            db.anneals.toArray(),
            db.pieces.toArray(),
          ])
          return { inspectRows, refireRows, annealRows, pieceRows }
        }).subscribe({
          next: ({ inspectRows, refireRows, annealRows, pieceRows }) => {
            inspects.value = [...inspectRows].sort((a, b) => b.date.localeCompare(a.date))
            refires.value = [...refireRows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            anneals.value = annealRows
            pieces.value = pieceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取质检数据失败'
            loading.value = false
          },
        })
      }
      // 首屏拉取兜底（订阅建立前数据已就绪的场景）
      const [inspectRows, refireRows] = await Promise.all([listInspects(), listRefires()])
      inspects.value = inspectRows
      refires.value = refireRows
      await runReconcile(false)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<InspectFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /** 登记检验（合格归档 / 判重烧开单），失败由数据层按本侧重试 */
  async function submit(draft: InspectDraft): Promise<QcSubmitOutcome | null> {
    try {
      const outcome = await submitInspect({
        pieceId: draft.pieceId,
        annealId: draft.annealId,
        result: draft.result,
        defectNote: draft.defectNote.trim(),
        inspector: draft.inspector.trim(),
        date: draft.date,
      })
      lastAttempts.value = outcome.attempts
      revision.value += 1
      if (outcome.refire !== null) {
        lastMessage.value =
          (outcome.attempts > 1 ? `质检账第 ${outcome.attempts} 次尝试落账成功；` : '') +
          (outcome.refire.state === '待出炉'
            ? `已判${outcome.refire.defectResult}开重烧单：原炉还在烧，等确实出炉后自动退回待排，在烧炉次不受影响。`
            : `已判${outcome.refire.defectResult}开重烧单，原炉排位保留，已退回排产员待排（重烧另开一炉）。`)
      } else {
        lastMessage.value =
          (outcome.attempts > 1 ? `质检账第 ${outcome.attempts} 次尝试落账成功；` : '') + '检验合格，已归档'
      }
      await runReconcile(false)
      return outcome
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '质检落账失败'
      return null
    }
  }

  async function update(id: string, draft: InspectDraft): Promise<boolean> {
    try {
      const { attempts } = await updateInspect(id, {
        pieceId: draft.pieceId,
        annealId: draft.annealId,
        result: draft.result,
        defectNote: draft.defectNote.trim(),
        inspector: draft.inspector.trim(),
        date: draft.date,
      })
      lastAttempts.value = attempts
      revision.value += 1
      lastMessage.value = (attempts > 1 ? `质检账第 ${attempts} 次尝试改账成功；` : '') + '检验记录已更新'
      await runReconcile(false)
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '质检改账失败'
      return false
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      const { attempts } = await removeInspect(id)
      lastAttempts.value = attempts
      revision.value += 1
      lastMessage.value = '检验记录已删除（排产账未改动）'
      await runReconcile(false)
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '质检删账失败'
      return false
    }
  }

  /** 按作品 + 窑位对账，件数对不上自动挂起 */
  async function runReconcile(notify = true): Promise<ReconcileReport | null> {
    reconciling.value = true
    try {
      const result = await reconcileAndHold()
      report.value = result
      if (notify) {
        const errors = result.issues.filter((issue) => issue.level === 'error').length
        lastMessage.value =
          errors === 0
            ? `对账完成：${result.countsByPiece.length} 件作品两本账一致`
            : `对账发现 ${errors} 处不符，涉及的重烧单已挂起`
      }
      return result
    } finally {
      reconciling.value = false
    }
  }

  async function hold(refireId: string, reason: string): Promise<void> {
    await holdRefire(refireId, reason)
    revision.value += 1
    lastMessage.value = '重烧单已挂起，待两本账核对一致后再解挂'
    await runReconcile(false)
  }

  async function unhold(refireId: string): Promise<boolean> {
    const updated = await unholdRefire(refireId)
    revision.value += 1
    lastMessage.value = updated === null ? '重烧单不存在' : `重烧单已解挂，回到「${updated.state}」环节`
    await runReconcile(false)
    return updated !== null
  }

  return {
    inspects,
    refires,
    anneals,
    pieces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    lastAttempts,
    report,
    reconciling,
    revision,
    annealById,
    pendingRefires,
    waitingSchedule,
    heldRefires,
    activeDefectCount,
    visibleInspects,
    outedAnnealsOfPiece,
    annealsOfPiece,
    refireOfInspect,
    refireById,
    isDefect: (result: InspectResult) => isDefectResult(result),
    loadAll,
    setFilters,
    resetFilters,
    submit,
    update,
    remove,
    runReconcile,
    hold,
    unhold,
  }
})
