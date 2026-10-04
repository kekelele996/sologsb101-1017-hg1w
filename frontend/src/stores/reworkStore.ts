/**
 * 重烧请求状态管理（Pinia）
 * 维护质检判不合格后生成的重烧请求：待出炉（等在烧的那炉出炉）/ 已退回待排（重烧另开一条）。
 * 重烧的生成与释放逻辑在 db 层（createReworkRequest / releaseReworksForPiece），本 store 提供响应式订阅与派生列表。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { ReworkRequest } from '../types/rework'
import { db, initDatabase, putRework } from '../utils/db'

let subscribed = false

export const useReworkStore = defineStore('rework', () => {
  const reworks = ref<ReworkRequest[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')

  /** 待出炉：在烧的那炉还没出炉，重烧请求先挂着（不打断） */
  const pendingReworks = computed<ReworkRequest[]>(() =>
    reworks.value.filter((row) => row.state === '待出炉').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  )
  /** 已退回待排：重烧另开了一条退火记录 */
  const releasedReworks = computed<ReworkRequest[]>(() =>
    reworks.value.filter((row) => row.state === '已退回待排').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  )

  function reworksOf(pieceId: string): ReworkRequest[] {
    return reworks.value.filter((row) => row.pieceId === pieceId)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(() => db.reworks.toArray()).subscribe({
          next: (rows) => {
            reworks.value = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取重烧请求失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  /** 取消一条待出炉的重烧请求（不影响已退回待排的重烧炉） */
  async function cancel(id: string): Promise<void> {
    const row = reworks.value.find((item) => item.id === id)
    if (row === undefined || row.state !== '待出炉') return
    await putRework({ ...row, state: '已取消' })
  }

  return {
    reworks,
    loading,
    ready,
    error,
    pendingReworks,
    releasedReworks,
    reworksOf,
    loadAll,
    cancel,
  }
})
