/**
 * 出炉检验（质检台账）状态管理（Pinia）
 * 与排产台账（annealStore）分离：质检台账挂到「那一炉」（annealId + kilnSlot），
 * 按作品 + 窑位与排产台账对账。
 * 落账失败时只在质检本侧重试，排产台账不动；对不上窑位的老记录只读。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Inspect, InspectDraft } from '../types/inspect'
import { needsRework } from '../types/inspect'
import { ROW_REVISION, createReworkRequest, db, initDatabase, syncPieceState } from '../utils/db'
import { nowIso, uuid } from '../utils/id'

/** 落账重试次数（质检台账写失败时按本侧重试，不动排产台账） */
const MAX_ATTEMPTS = 3

let subscribed = false

export const useInspectStore = defineStore('inspect', () => {
  const inspects = ref<Inspect[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  /** 最近一次落账失败的检验记录（用于「重试落账」） */
  const lastFailedInspect = ref<Inspect | null>(null)
  /** 最近一次落账失败原因 */
  const lastError = ref('')
  /** 验证开关：强制首次落账失败（仅用于验证重试逻辑） */
  const simulateFail = ref(false)

  /** 质检台账落账：失败按本侧重试，不触碰排产台账 */
  async function putInspectWithRetry(row: Inspect): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        if (simulateFail.value && attempt === 1) {
          throw new Error('模拟质检台账落账失败（验证重试）')
        }
        await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
        return true
      } catch (err) {
        lastError.value = err instanceof Error ? err.message : '质检台账落账失败'
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
        }
      }
    }
    return false
  }

  /** 质检判不合格后生成重烧请求（另一条线：重烧等出炉，不打断在烧的炉） */
  async function handleRework(row: Inspect): Promise<void> {
    if (!needsRework(row.result)) return
    try {
      const rework = await createReworkRequest(row.id)
      if (rework === null) return
      if (rework.state === '待出炉') {
        lastMessage.value = `检验已登记（${row.result}）；已生成重烧请求：在烧的那炉出炉后再退回待排，不打断当前在烧炉。`
      } else {
        lastMessage.value = `检验已登记（${row.result}）；已生成重烧请求并重烧另开一条退火记录（原来那炉排位保留）。`
      }
    } catch {
      // 重烧请求生成失败不影响已落账的质检台账；可稍后在退火页重新触发
      lastMessage.value = `检验已登记（${row.result}）；重烧请求生成失败，可稍后在退火页重新触发。`
    }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(() => db.inspects.toArray()).subscribe({
          next: (rows) => {
            inspects.value = [...rows].sort((a, b) => b.date.localeCompare(a.date))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取检验数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  /** 登记出炉检验：挂到所选的那一炉（已出炉退火记录）上 */
  async function createInspect(draft: InspectDraft): Promise<Inspect | null> {
    if (draft.annealId === '') {
      error.value = '请选择被检验的那一炉（已出炉退火记录）'
      return null
    }
    const anneal = await db.anneals.get(draft.annealId)
    if (!anneal) {
      error.value = '所选退火记录不存在'
      return null
    }
    if (anneal.state !== '已出炉') {
      error.value = '只能检验已出炉的退火记录；在烧的那炉出炉后再登记。'
      return null
    }

    const stamp = nowIso()
    const row: Inspect = {
      id: uuid('inspect'),
      pieceId: draft.pieceId,
      annealId: anneal.id,
      kilnSlot: anneal.kilnSlot,
      result: draft.result,
      defectNote: draft.defectNote.trim(),
      inspector: draft.inspector.trim(),
      date: draft.date,
      readonly: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }

    const ok = await putInspectWithRetry(row)
    if (!ok) {
      lastFailedInspect.value = row
      error.value = `质检台账落账失败，已按本侧重试 ${MAX_ATTEMPTS} 次仍未成功，可点击「重试落账」；排产台账未变动。`
      return null
    }
    lastFailedInspect.value = null
    lastError.value = ''
    lastMessage.value = needsRework(row.result)
      ? `检验已登记：${row.result}，已生成返工提示（原始工序记录保留不变）`
      : '检验已登记：合格'
    await syncPieceState(row.pieceId)
    await handleRework(row)
    return row
  }

  /** 重试最近一次失败的质检台账落账（只动质检本侧，不碰排产台账） */
  async function retryLastFailed(): Promise<Inspect | null> {
    const row = lastFailedInspect.value
    if (row === null) return null
    const ok = await putInspectWithRetry(row)
    if (!ok) {
      error.value = `质检台账落账重试仍失败（已重试 ${MAX_ATTEMPTS} 次）；排产台账未变动，可稍后再试。`
      return null
    }
    lastFailedInspect.value = null
    lastError.value = ''
    lastMessage.value = '质检台账落账重试成功'
    await syncPieceState(row.pieceId)
    await handleRework(row)
    return row
  }

  async function updateInspect(id: string, draft: InspectDraft): Promise<boolean> {
    const existing = inspects.value.find((row) => row.id === id)
    if (existing === undefined) return false
    if (existing.readonly) {
      error.value = '该检验记录为升级前的老数据（未挂窑位），只读，不可编辑。'
      return false
    }
    const anneal = await db.anneals.get(draft.annealId)
    if (!anneal) {
      error.value = '所选退火记录不存在'
      return false
    }
    await db.inspects.update(id, {
      pieceId: draft.pieceId,
      annealId: anneal.id,
      kilnSlot: anneal.kilnSlot,
      result: draft.result,
      defectNote: draft.defectNote.trim(),
      inspector: draft.inspector.trim(),
      date: draft.date,
      updatedAt: nowIso(),
    })
    await syncPieceState(draft.pieceId)
    lastMessage.value = '检验记录已更新'
    return true
  }

  async function removeInspect(id: string): Promise<boolean> {
    const existing = inspects.value.find((row) => row.id === id)
    if (existing === undefined) return false
    if (existing.readonly) {
      error.value = '该检验记录为升级前的老数据（未挂窑位），只读，不可删除。'
      return false
    }
    await db.inspects.delete(id)
    await syncPieceState(existing.pieceId)
    lastMessage.value = '检验记录已删除'
    return true
  }

  return {
    inspects,
    loading,
    ready,
    error,
    lastMessage,
    lastFailedInspect,
    lastError,
    simulateFail,
    loadAll,
    createInspect,
    retryLastFailed,
    updateInspect,
    removeInspect,
  }
})
