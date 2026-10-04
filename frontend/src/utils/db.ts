/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑；v1 → v2 为 Piece 增加 craft 索引并回填默认值
 * - 提供各表增删改查、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { parseReworkSeqFromNote } from '../types/inspect'
import { nowIso } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>

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
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
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
            row.revision = ROW_REVISION
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
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：检验记录拆分返工道次，老记录留只读 ----------
    this.version(3)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector, reworkStepSeq, legacyReadonly',
      })
      .upgrade(async (tx) => {
        // 迁移 6：检验记录补齐返工道次与只读标记
        // 旧数据里返工只记在作品（缺陷说明）上，升级时按当时的道次顺序拆到具体道次；
        // 对不上的老记录保留原样、标记只读，不可改派。
        const inspectRows = await tx.table('inspects').toArray()
        const stepsCache = new Map<string, Step[]>()
        for (const row of inspectRows) {
          const r = row as Inspect
          if (typeof r.reworkStepSeq !== 'number') r.reworkStepSeq = null
          if (typeof r.legacyReadonly !== 'boolean') r.legacyReadonly = false
          if (r.result !== '合格' && r.reworkStepSeq === null && !r.legacyReadonly) {
            let pieceSteps = stepsCache.get(r.pieceId)
            if (pieceSteps === undefined) {
              pieceSteps = (await tx.table('steps').where('pieceId').equals(r.pieceId).toArray()) as Step[]
              stepsCache.set(r.pieceId, pieceSteps)
            }
            const seq = parseReworkSeqFromNote(r.defectNote, pieceSteps)
            if (seq !== null && pieceSteps.some((s) => s.seq === seq)) {
              r.reworkStepSeq = seq
            } else {
              // 拆不到具体道次：留着只读
              r.legacyReadonly = true
            }
          }
          await tx.table('inspects').put(r)
        }
      })
  }
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

/** 删除作品：级联清理工序、退火与检验记录 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

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

/**
 * 工序台按检验室指定的道次返工：只重开被点中的那一道工序。
 * - 按「作品 + 道次序号」对账，找不到该道次时返回 null（检验室那笔已挂起，等确认）。
 * - 只把目标道次从「已完成」退回「进行中」；前面已确认的工序记录原样保留、不抹掉。
 * - 纯工序侧写操作（steps + 作品状态），不碰检验记录；调用方应包一层 withRetry，
 *   失败只重试本侧，检验室那份不动。
 */
export async function reworkStep(pieceId: string, seq: number): Promise<Step | null> {
  const target = await db.steps.where('[pieceId+seq]').equals([pieceId, seq]).first()
  if (target === undefined) return null
  if (target.state === '已完成') {
    await db.steps.update(target.id, { state: '进行中', updatedAt: nowIso() })
  }
  await syncPieceState(pieceId)
  return target
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
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
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
  ])
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), furnaces, batches, pieces, steps, anneals, inspects }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
    await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.inspects.bulkPut(
      snapshot.inspects.map((row) => {
        const normalized = { ...row, revision: ROW_REVISION } as Inspect
        if (typeof normalized.reworkStepSeq !== 'number') normalized.reworkStepSeq = null
        if (typeof normalized.legacyReadonly !== 'boolean') normalized.legacyReadonly = false
        // 不合格且未指定返工道次的老存档记录：保留原样、只读
        if (normalized.result !== '合格' && normalized.reworkStepSeq === null) {
          normalized.legacyReadonly = true
        }
        return normalized
      }),
    )
  })
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
    ])
  })
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects }
}
