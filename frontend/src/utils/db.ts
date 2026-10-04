/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 两本账：
 *   · 排产账 anneals —— 窑务排产员独管：窑位、曲线段、入窑 / 出炉时刻、退火轮次；
 *   · 质检账 inspects + refires —— 质检员独管：检验结论、缺陷说明、重烧交接单。
 *   质检落账只在 inspects / refires 的事务内进行并按本侧重试，绝不写入 anneals。
 * - v1 → v2：Piece 增加 craft 索引并回填默认值；
 * - v2 → v3：检验记录按「作品 + 当时退火记录」回填挂账窑位，新增 refires 重烧单表。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal, AnnealDraft } from '../types/anneal'
import type { Inspect, InspectResult } from '../types/inspect'
import type { Refire, RefireState } from '../types/refire'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { reconcileLedgers, type ReconcileReport } from './reconcile'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 质检账落账失败后的本侧重试次数（只重试质检事务，排产账不动） */
export const QC_WRITE_MAX_RETRY = 3
/** 重试退避基数（毫秒），第 n 次重试前等待 n * 该值 */
export const QC_RETRY_BASE_DELAY_MS = 120

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>
  refires!: Table<Refire, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      // craft 为 v2 新增索引
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
      inspects: 'id, pieceId, date, result, inspector',
    })

    // ---------- v3：两本账分离 + 重烧单 ----------
    // anneals 增加轮次与重烧链索引；inspects 增加挂账炉次索引；新增 refires 表。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, round, sourceRefireId',
        inspects: 'id, pieceId, annealId, date, result, inspector, readOnly',
        refires: 'id, pieceId, inspectId, sourceAnnealId, reAnnealId, state',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })

        // 迁移 4：退火记录补齐出炉时间、曲线段与重烧链字段（老记录一律视为首烧第 1 轮）
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
          if (typeof row.round !== 'number') row.round = 1
          if (typeof row.sourceRefireId !== 'string') row.sourceRefireId = ''
          if (typeof row.sourceAnnealId !== 'string') row.sourceAnnealId = ''
          row.revision = ROW_REVISION
        })

        // 迁移 5：检验记录按「作品当时的退火记录」回填挂账窑位；对不上的老记录只读
        const legacyAnneals = (await tx.table('anneals').toArray()) as Anneal[]
        const annealsByPiece = new Map<string, Anneal[]>()
        legacyAnneals.forEach((row) => {
          const list = annealsByPiece.get(row.pieceId) ?? []
          list.push(row)
          annealsByPiece.set(row.pieceId, list)
        })
        annealsByPiece.forEach((list) =>
          list.sort((a, b) => a.inAt.localeCompare(b.inAt) || a.id.localeCompare(b.id)),
        )
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
          const pieceId = typeof row.pieceId === 'string' ? row.pieceId : ''
          const inspectDate = typeof row.date === 'string' ? row.date : ''
          const candidates = annealsByPiece.get(pieceId) ?? []
          const matched = matchLegacyAnneal(candidates, inspectDate)
          if (matched === null) {
            // 对不上的老记录：只读，不参与重烧交接
            row.annealId = ''
            row.kilnSlot = ''
            row.inAt = ''
            row.outAt = ''
            row.readOnly = true
          } else {
            row.annealId = matched.id
            row.kilnSlot = matched.kilnSlot
            row.inAt = matched.inAt
            row.outAt = matched.outAt
            row.readOnly = false
          }
          if (typeof row.refireId !== 'string') row.refireId = ''
          row.revision = ROW_REVISION
        })
      })
  }
}

/**
 * v3 迁移：按作品当时的退火记录回填老检验挂账。
 * 优先取检验当天或之前已出炉、出炉日期最接近检验日期的一炉；
 * 其次取入窑时间不晚于检验日期的最后一炉；再不行取该作品唯一一炉；
 * 一炉都没有（或同作品多炉无法判定）返回 null → 老记录只读。
 */
export function matchLegacyAnneal(candidates: Anneal[], inspectDate: string): Anneal | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  const dated = candidates.filter((row) => row.inAt.slice(0, 10) <= inspectDate)
  if (dated.length === 0) return null
  const outed = dated
    .filter((row) => row.outAt !== '' && row.outAt.slice(0, 10) <= inspectDate)
    .sort((a, b) => b.outAt.localeCompare(a.outAt))
  if (outed.length > 0) return outed[0]
  return dated[dated.length - 1]
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
      // 升级或首次打开后，把到点的重烧单状态推进一次
      await refreshRefireStates()
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火、检验与重烧单（同一事务） */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, db.refires, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.refires.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/** 作品是否有在途（未取消、未完成）重烧单 */
const ACTIVE_REFIRE_STATES: RefireState[] = ['待出炉', '待排', '已排产', '挂起']

/**
 * 依工序、退火、检验与重烧单推导并回写作品状态。
 * 设计中 → 制作中 → 已退火 →（质检判重烧）待重烧 →（复检）已检验。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects, refires] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
    db.refires.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'

  const writableInspects = inspects.filter((row) => !row.readOnly).sort((a, b) => b.date.localeCompare(a.date))
  const latest = writableInspects[0]
  const activeRefire = refires.find((row) => ACTIVE_REFIRE_STATES.includes(row.state))
  if (activeRefire !== undefined) {
    // 已判重烧、尚未复检合格：退回重排（在烧的那炉不受影响）
    next = '待重烧'
  } else if (latest !== undefined) {
    if (latest.result === '合格') {
      next = '已检验'
    } else {
      // 最近一次是缺陷判定但重烧已走完：重烧炉次已出炉、等待复检
      const linkedRefire = refires.find((row) => row.id === latest.refireId)
      next = linkedRefire !== undefined && linkedRefire.state === '已完成' ? '已退火' : '已检验'
    }
  }

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* --------------------------- 排产账：退火炉次 --------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

/** 补全新建退火的轮次与重烧链字段（排产员手动排位一律为首烧） */
function normalizeAnneal(row: Anneal): Anneal {
  return {
    ...row,
    round: row.round ?? 1,
    sourceRefireId: row.sourceRefireId ?? '',
    sourceAnnealId: row.sourceAnnealId ?? '',
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  }
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put(normalizeAnneal(row))
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.transaction('rw', db.anneals, db.refires, async () => {
    // 删除的若是某张在途重烧单的重烧炉次，重烧单退回待排，原炉排位仍保留
    if (row.sourceRefireId !== '') {
      const refire = await db.refires.get(row.sourceRefireId)
      if (refire !== undefined && (refire.state === '已排产' || refire.state === '挂起')) {
        await db.refires.update(refire.id, {
          state: '待排',
          reAnnealId: '',
          reKilnSlot: '',
          holdReason: '',
          updatedAt: nowIso(),
        })
      }
    }
    await db.anneals.delete(id)
  })
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间，并联动重烧单与作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.transaction('rw', db.anneals, db.refires, async () => {
    await db.anneals.update(annealId, {
      state: next,
      outAt: next === '已出炉' ? outAt : row.outAt,
      updatedAt: nowIso(),
    })
    if (next === '已出炉') {
      // 本炉就是某张重烧单的重烧炉次 → 重烧完成
      if (row.sourceRefireId !== '') {
        const refire = await db.refires.get(row.sourceRefireId)
        if (refire !== undefined && refire.state === '已排产') {
          await db.refires.update(refire.id, { state: '已完成', sourceOutAt: outAt, holdReason: '', updatedAt: nowIso() })
        }
      }
      // 本炉是原炉、且质检已判重烧（在烧跟踪）：确实出炉后退回待排，不打断在烧炉次
      const waiting = await db.refires.where('sourceAnnealId').equals(annealId).toArray()
      for (const refire of waiting) {
        if (refire.state === '待出炉') {
          await db.refires.update(refire.id, { state: '待排', sourceOutAt: outAt, updatedAt: nowIso() })
        }
      }
    }
  })
  await syncPieceState(row.pieceId)
}

/**
 * 排产员接收重烧单：另开一条退火记录（round + 1），原炉排位保留不动。
 * 窑位冲突由调用方（store）先判，本函数只校验重烧单是否处于「待排」。
 */
export async function scheduleRefire(
  refireId: string,
  draft: AnnealDraft,
): Promise<{ anneal: Anneal; refire: Refire }> {
  const refire = await db.refires.get(refireId)
  if (refire === undefined) throw new Error('重烧单不存在或已被删除')
  if (refire.state !== '待排') {
    throw new Error(`重烧单当前为「${refire.state}」，只有「待排」状态才能接收排产`)
  }
  const source = await db.anneals.get(refire.sourceAnnealId)
  if (source === undefined) throw new Error('原炉次排位在排产账中缺失，请先对账解挂')

  const stamp = nowIso()
  const anneal: Anneal = {
    id: `anneal-refire-${refireId}-${Date.now().toString(36)}`,
    pieceId: refire.pieceId,
    kilnSlot: draft.kilnSlot,
    curveSeg: draft.curveSeg,
    inAt: draft.inAt,
    outAt: draft.outAt,
    state: draft.state,
    round: source.round + 1,
    sourceRefireId: refire.id,
    sourceAnnealId: source.id,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }

  await db.transaction('rw', db.anneals, db.refires, async () => {
    await db.anneals.put(anneal)
    await db.refires.update(refire.id, {
      state: '已排产',
      reAnnealId: anneal.id,
      reKilnSlot: anneal.kilnSlot,
      holdReason: '',
      updatedAt: stamp,
    })
  })
  await syncPieceState(refire.pieceId)
  return { anneal, refire: { ...refire, state: '已排产', reAnnealId: anneal.id, reKilnSlot: anneal.kilnSlot } }
}

/* --------------------------- 重烧单状态流转 / 对账 --------------------------- */

export async function listRefires(): Promise<Refire[]> {
  const rows = await db.refires.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 重烧单到点自动流转：原炉确出炉 → 待排；重烧炉次出炉 → 已完成（不碰挂起单） */
export async function refreshRefireStates(): Promise<void> {
  const [refires, anneals] = await Promise.all([db.refires.toArray(), db.anneals.toArray()])
  const annealById = new Map(anneals.map((row) => [row.id, row]))
  const stamp = nowIso()
  await db.transaction('rw', db.refires, async () => {
    for (const refire of refires) {
      if (refire.state === '待出炉') {
        const source = annealById.get(refire.sourceAnnealId)
        if (source !== undefined && source.state === '已出炉') {
          await db.refires.update(refire.id, {
            state: '待排',
            sourceOutAt: source.outAt,
            updatedAt: stamp,
          })
        }
      } else if (refire.state === '已排产' && refire.reAnnealId !== '') {
        const reAnneal = annealById.get(refire.reAnnealId)
        if (reAnneal !== undefined && reAnneal.state === '已出炉') {
          await db.refires.update(refire.id, { state: '已完成', holdReason: '', updatedAt: stamp })
        }
      }
    }
  })
}

/** 按作品与窑位对账；能落到重烧单上的差错自动挂起（已挂起的不重复处理） */
export async function reconcileAndHold(): Promise<ReconcileReport> {
  const [anneals, inspects, refires] = await Promise.all([
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.refires.toArray(),
  ])
  const report = reconcileLedgers(anneals, inspects, refires)
  const stamp = nowIso()
  const holdEntries = Object.entries(report.holds)
  if (holdEntries.length > 0) {
    await db.transaction('rw', db.refires, async () => {
      for (const [id, reason] of holdEntries) {
        const refire = await db.refires.get(id)
        if (refire !== undefined && refire.state !== '挂起' && refire.state !== '已完成') {
          await db.refires.update(id, { state: '挂起', holdReason: reason, updatedAt: stamp })
        }
      }
    })
  }
  return report
}

/** 人工 / 自动挂起（件数对不上先挂起） */
export async function holdRefire(refireId: string, reason: string): Promise<void> {
  await db.refires.update(refireId, {
    state: '挂起',
    holdReason: reason === '' ? '人工挂起：等待两本账核对' : reason,
    updatedAt: nowIso(),
  })
}

/** 解挂：按原炉 / 重烧炉次的实际状态回到对应环节 */
export async function unholdRefire(refireId: string): Promise<Refire | null> {
  const refire = await db.refires.get(refireId)
  if (refire === undefined) return null
  let next: RefireState
  if (refire.reAnnealId !== '') {
    const reAnneal = await db.anneals.get(refire.reAnnealId)
    next = reAnneal !== undefined && reAnneal.state === '已出炉' ? '已完成' : '已排产'
  } else {
    const source = await db.anneals.get(refire.sourceAnnealId)
    next = source !== undefined && source.state === '已出炉' ? '待排' : '待出炉'
  }
  await db.refires.update(refireId, { state: next, holdReason: '', updatedAt: nowIso() })
  await syncPieceState(refire.pieceId)
  return (await db.refires.get(refireId)) ?? null
}

/* --------------------------- 质检账：检验 + 重烧单 --------------------------- */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 质检账落账：失败后只重试本侧事务（inspects / refires），
 * 重试期间与重试逻辑都不触碰排产账 anneals。
 */
async function withQcRetry<T>(label: string, op: (attempt: number) => Promise<T>): Promise<{ value: T; attempts: number }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= QC_WRITE_MAX_RETRY; attempt += 1) {
    try {
      const value = await op(attempt)
      return { value, attempts: attempt }
    } catch (err) {
      lastError = err
      if (attempt < QC_WRITE_MAX_RETRY) await delay(QC_RETRY_BASE_DELAY_MS * attempt)
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${label}连续 ${QC_WRITE_MAX_RETRY} 次落账失败（排产账未受影响）：${message}`)
}

export interface QcInspectInput {
  pieceId: string
  /** 挂账炉次（按作品挂到那一炉上） */
  annealId: string
  result: InspectResult
  defectNote: string
  inspector: string
  date: string
}

export interface QcSubmitOutcome {
  inspect: Inspect
  refire: Refire | null
  /** 实际落账尝试次数（>1 说明发生过本侧重试） */
  attempts: number
}

/**
 * 质检员登记检验：
 * - 合格：只写 inspects；
 * - 判重烧：写 inspects 的同时开一张重烧单 refires，原炉次已出炉 → 待排，
 *   原炉还在烧 → 待出炉（不打断在烧的这一炉，等确实出炉再退回待排）。
 * 整个动作在质检账事务内完成并按本侧重试；不写 anneals。
 */
export async function submitInspect(input: QcInspectInput): Promise<QcSubmitOutcome> {
  const source = await db.anneals.get(input.annealId)
  if (source === undefined) throw new Error('挂账炉次在排产账中不存在，请先与排产员核对窑位')
  if (source.pieceId !== input.pieceId) throw new Error('挂账炉次与所选作品不一致，按作品挂账失败')

  const stamp = nowIso()
  const inspectId = `inspect-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const isDefect = input.result !== '合格'
  const refireId = isDefect ? `refire-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : ''
  const initialRefireState: RefireState = source.state === '已出炉' ? '待排' : '待出炉'

  const { attempts } = await withQcRetry('质检落账', async (attempt) => {
    await db.transaction('rw', db.inspects, db.refires, async () => {
      const inspect: Inspect = {
        id: inspectId,
        pieceId: input.pieceId,
        annealId: source.id,
        kilnSlot: source.kilnSlot,
        inAt: source.inAt,
        outAt: source.outAt,
        result: input.result,
        defectNote: input.defectNote,
        inspector: input.inspector,
        date: input.date,
        refireId,
        readOnly: false,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      await db.inspects.put(inspect)

      if (isDefect) {
        const refire: Refire = {
          id: refireId,
          pieceId: input.pieceId,
          inspectId,
          sourceAnnealId: source.id,
          sourceKilnSlot: source.kilnSlot,
          sourceInAt: source.inAt,
          sourceOutAt: source.outAt,
          defectResult: input.result,
          defectNote: input.defectNote,
          reAnnealId: '',
          reKilnSlot: '',
          state: initialRefireState,
          holdReason: '',
          retryCount: attempt - 1,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }
        await db.refires.put(refire)
      }
    })
  })

  // 质检账落定后再对账挂起 + 回写作品状态（失败不影响已落账的质检记录）
  await reconcileAndHold().catch(() => undefined)
  await syncPieceState(input.pieceId).catch(() => undefined)

  const inspect = await db.inspects.get(inspectId)
  const refire = refireId === '' ? null : await db.refires.get(refireId)
  if (inspect === undefined) throw new Error('质检记录落账后读取失败')
  return { inspect, refire: refire ?? null, attempts }
}

/**
 * 编辑检验记录（只读老记录禁止修改）。
 * 缺陷改合格：若重烧单尚未被排产接收，连同重烧单一起撤回；
 * 一旦重烧已另开炉次（已排产 / 已完成），结论不允许改，只能改缺陷说明。
 */
export async function updateInspect(id: string, patch: QcInspectInput): Promise<{ attempts: number }> {
  const existing = await db.inspects.get(id)
  if (existing === undefined) throw new Error('检验记录不存在')
  if (existing.readOnly) throw new Error('该老检验记录升级时未挂到窑位，按规则只读')

  const linkedRefire = existing.refireId === '' ? null : ((await db.refires.get(existing.refireId)) ?? null)
  if (linkedRefire !== null && (linkedRefire.state === '已排产' || linkedRefire.state === '已完成')) {
    if (patch.result !== existing.result || patch.annealId !== existing.annealId) {
      throw new Error('重烧已另开炉次，排产账已按此推进，不能改判或改挂炉次；只能补充缺陷说明')
    }
  }

  const source = await db.anneals.get(patch.annealId)
  if (source === undefined) throw new Error('挂账炉次在排产账中不存在')
  if (source.pieceId !== patch.pieceId) throw new Error('挂账炉次与所选作品不一致')

  const becomesPass = patch.result === '合格'
  const withdrawRefire =
    linkedRefire !== null &&
    becomesPass &&
    (linkedRefire.state === '待出炉' || linkedRefire.state === '待排' || linkedRefire.state === '挂起')
  const refireToUpdate = withdrawRefire ? null : linkedRefire

  const { attempts } = await withQcRetry('质检改账', async () => {
    await db.transaction('rw', db.inspects, db.refires, async () => {
      await db.inspects.update(id, {
        pieceId: patch.pieceId,
        annealId: source.id,
        kilnSlot: source.kilnSlot,
        inAt: source.inAt,
        outAt: source.outAt,
        result: patch.result,
        defectNote: patch.defectNote,
        inspector: patch.inspector,
        date: patch.date,
        refireId: withdrawRefire ? '' : existing.refireId,
        updatedAt: nowIso(),
      })
      if (withdrawRefire && linkedRefire !== null) {
        await db.refires.delete(linkedRefire.id)
      } else if (refireToUpdate !== null) {
        await db.refires.update(refireToUpdate.id, {
          defectResult: patch.result,
          defectNote: patch.defectNote,
          updatedAt: nowIso(),
        })
      }
    })
  })

  await reconcileAndHold().catch(() => undefined)
  await syncPieceState(patch.pieceId).catch(() => undefined)
  if (existing.pieceId !== patch.pieceId) await syncPieceState(existing.pieceId).catch(() => undefined)
  return { attempts }
}

/** 删除检验记录（只读老记录禁止；重烧已排产的不允许直接删，需先由排产侧撤炉） */
export async function removeInspect(id: string): Promise<{ attempts: number }> {
  const existing = await db.inspects.get(id)
  if (existing === undefined) return { attempts: 0 }
  if (existing.readOnly) throw new Error('该老检验记录升级时未挂到窑位，按规则只读，不能删除')
  const linkedRefire = existing.refireId === '' ? null : ((await db.refires.get(existing.refireId)) ?? null)
  if (linkedRefire !== null && (linkedRefire.state === '已排产' || linkedRefire.state === '已完成')) {
    throw new Error('重烧已另开炉次，不能直接删除检验记录')
  }
  const pieceId = existing.pieceId
  const refireId = linkedRefire?.id ?? ''
  const { attempts } = await withQcRetry('质检删账', async () => {
    await db.transaction('rw', db.inspects, db.refires, async () => {
      await db.inspects.delete(id)
      if (refireId !== '') await db.refires.delete(refireId)
    })
  })
  await syncPieceState(pieceId).catch(() => undefined)
  return { attempts }
}

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
  refires: Refire[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, refires] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.refires.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    inspects,
    refires,
  }
}

/** 归一化旧版快照（v2 导出没有 refires、检验未挂窑位）：按当时退火记录回填 */
export function normalizeSnapshot(input: Partial<DatabaseSnapshot>): DatabaseSnapshot {
  const anneals = (input.anneals ?? []).map((row) => ({
    ...row,
    round: typeof row.round === 'number' ? row.round : 1,
    sourceRefireId: row.sourceRefireId ?? '',
    sourceAnnealId: row.sourceAnnealId ?? '',
  }))
  const annealsByPiece = new Map<string, Anneal[]>()
  anneals.forEach((row) => {
    const list = annealsByPiece.get(row.pieceId) ?? []
    list.push(row)
    annealsByPiece.set(row.pieceId, list)
  })
  annealsByPiece.forEach((list) => list.sort((a, b) => a.inAt.localeCompare(b.inAt)))
  const inspects: Inspect[] = (input.inspects ?? []).map((row) => {
    if (typeof row.annealId === 'string' && row.annealId !== '') {
      return { ...row, refireId: row.refireId ?? '', readOnly: row.readOnly ?? false }
    }
    const matched = matchLegacyAnneal(annealsByPiece.get(row.pieceId) ?? [], row.date)
    return {
      ...row,
      annealId: matched?.id ?? '',
      kilnSlot: matched?.kilnSlot ?? '',
      inAt: matched?.inAt ?? '',
      outAt: matched?.outAt ?? '',
      refireId: row.refireId ?? '',
      readOnly: matched === null,
    }
  })
  return {
    name: input.name ?? DB_NAME,
    schemaVersion: input.schemaVersion ?? DB_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? nowIso(),
    furnaces: input.furnaces ?? [],
    batches: input.batches ?? [],
    pieces: input.pieces ?? [],
    steps: input.steps ?? [],
    anneals,
    inspects,
    refires: input.refires ?? [],
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const normalized = normalizeSnapshot(snapshot)
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.refires],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.refires.clear(),
      ])
      await db.furnaces.bulkPut(normalized.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(normalized.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(normalized.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(normalized.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(normalized.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(normalized.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.refires.bulkPut(normalized.refires.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
  await refreshRefireStates().catch(() => undefined)
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.refires],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.refires.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, refires] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.refires.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, refires }
}
