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
import { NO_REWORK_SEQ } from '../types/inspect'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { retryLocal } from './retry'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/**
 * 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移）
 * v1 → v2：Piece 增加 craft 索引并回填默认值；
 * v2 → v3：检验返工从「只记在作品上」拆到具体道次（作品 + 道次序号），
 *          旧记录按当时道次顺序拆分，对不上的标为 legacy 只读保留。
 */
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
    this.version(DB_SCHEMA_VERSION)
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

    // ---------- v3：返工从作品级拆到「作品 + 道次序号」，工序侧新增返工标记 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        // [pieceId+reworkStepSeq]：两边按作品 + 道次序号对账
        inspects: 'id, pieceId, date, result, inspector, [pieceId+reworkStepSeq]',
      })
      .upgrade(async (tx) => {
        // 迁移 1：工序台补齐本侧返工标记
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.reworkMark !== 'boolean') row.reworkMark = false
        })

        // 迁移 2：检验室返工字段补齐，并把「只记在作品上」的旧返工按当时道次顺序拆开
        const stepRows = await tx.table('steps').toCollection().toArray()
        const stepsByPiece = new Map<string, Array<{ id: string; seq: number }>>()
        stepRows.forEach((raw) => {
          const step = raw as Record<string, unknown>
          const pieceId = typeof step.pieceId === 'string' ? step.pieceId : ''
          const seq = typeof step.seq === 'number' ? step.seq : 0
          if (pieceId === '' || seq <= 0) return
          const list = stepsByPiece.get(pieceId) ?? []
          list.push({ id: String(step.id), seq })
          stepsByPiece.set(pieceId, list)
        })
        stepsByPiece.forEach((list) => list.sort((a, b) => a.seq - b.seq))

        // 升级窗口内一次性读出作品是否有「之后」的合格复检，用于关闭已完成的旧返工
        const inspectRows = await tx.table('inspects').toCollection().toArray()
        const passDatesByPiece = new Map<string, string[]>()
        inspectRows.forEach((raw) => {
          const item = raw as Record<string, unknown>
          if (item.result === '合格' && typeof item.pieceId === 'string' && typeof item.date === 'string') {
            const list = passDatesByPiece.get(item.pieceId) ?? []
            list.push(item.date)
            passDatesByPiece.set(item.pieceId, list)
          }
        })

        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.reworkClosed !== 'boolean') row.reworkClosed = false
          if (typeof row.reworkClosedBy !== 'string') row.reworkClosedBy = ''
          if (typeof row.legacy !== 'boolean') row.legacy = false
          if (typeof row.reworkStepId !== 'string') row.reworkStepId = ''
          if (typeof row.reworkStepSeq !== 'number') row.reworkStepSeq = NO_REWORK_SEQ

          // 只处理 v2 及以前「返工只记在作品上」的老不合格记录
          const isOldRework =
            row.result !== '合格' &&
            (typeof row.reworkStepSeq !== 'number' || (row.reworkStepSeq as number) <= 0) &&
            row.reworkClosed === false
          if (!isOldRework) return

          row.legacy = true
          const pieceId = typeof row.pieceId === 'string' ? row.pieceId : ''
          const order = stepsByPiece.get(pieceId) ?? []
          if (order.length > 0) {
            // 按当时的道次顺序，返工默认退回到最后一道（旧数据只记在作品上，取最靠近出炉的那道）
            const last = order[order.length - 1]
            row.reworkStepSeq = last.seq
            row.reworkStepId = last.id
            const passDates = passDatesByPiece.get(pieceId) ?? []
            if (passDates.some((date) => date > String(row.date))) {
              row.reworkClosed = true
            }
          } else {
            // 对不上的老记录：保留只读，不允许再参与流转
            row.reworkStepSeq = NO_REWORK_SEQ
            row.reworkStepId = ''
          }
        })
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

/**
 * 保存一道工序（吹制工序台这一侧）。
 * 只重试 steps 表的写入：工序台保存失败按本侧重试，检验室那份（inspects）不动。
 * syncPieceState 是读多表后的状态推导，失败不影响工序本身已落库。
 */
export async function putStep(row: Step): Promise<void> {
  await retryLocal(async () => {
    await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  })
  try {
    await syncPieceState(row.pieceId)
  } catch {
    /* 状态推导失败不回滚工序记录；下次任意保存会重新推导 */
  }
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await retryLocal(async () => {
    await db.steps.delete(id)
  })
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用）；整体在本侧重试，不碰检验表 */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await retryLocal(async () => {
    await db.transaction('rw', db.steps, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
      }
    })
  })
}

/**
 * 工序台领取返工：把被点中的那道工序重开（reworkMark=true、状态退回「进行中」）。
 * 只写 steps 这一张表并重试；不删除、不改写前面已确认工序的任何记录，也不触碰 inspects。
 */
export async function receiveRework(inspectId: string, allInspects: Inspect[], allSteps: Step[]): Promise<boolean> {
  const inspect = allInspects.find((row) => row.id === inspectId)
  if (!inspect || inspect.result === '合格' || inspect.reworkClosed) return false
  const target = allSteps
    .filter((step) => step.pieceId === inspect.pieceId)
    .sort((a, b) => a.seq - b.seq)
    .find((step) => inspect.reworkStepId !== '' && step.id === inspect.reworkStepId)
  if (!target) return false
  await retryLocal(async () => {
    await db.steps.put({
      ...target,
      state: '进行中',
      reworkMark: true,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    })
  })
  return true
}

/**
 * 返工重做后推进该道完成（完成即「待复检」，等检验室合格复检关闭返工）。
 * 同样只写 steps 表并重试。
 */
export async function completeReworkedStep(stepId: string, allSteps: Step[]): Promise<boolean> {
  const step = allSteps.find((row) => row.id === stepId)
  if (!step || !step.reworkMark) return false
  await retryLocal(async () => {
    await db.steps.put({
      ...step,
      state: '已完成',
      reworkMark: true,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    })
  })
  return true
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

/**
 * 检验室保存一份检验（新增或编辑）。
 * 检验室只管检验结论、缺陷说明、返工退回哪道工序；不写工序的温度 / 时长 / 操作人。
 *
 * 合格复检会自动关闭该作品此前尚未关闭的返工，并清除对应工序的返工标记；
 * 判定不合格时必须带「作品 + 道次序号」，只点中一道工序，前序已确认记录保持不变。
 * 返回值：成功落库后的检验记录。
 */
export async function saveInspect(
  inspect: Inspect,
  options: { existing?: Inspect | undefined } = {},
): Promise<Inspect> {
  const isPass = inspect.result === '合格'
  const next: Inspect = {
    ...inspect,
    reworkStepSeq: isPass ? NO_REWORK_SEQ : Math.max(1, inspect.reworkStepSeq),
    reworkStepId: isPass ? '' : inspect.reworkStepId,
    revision: ROW_REVISION,
  }

  await db.transaction('rw', db.inspects, db.steps, db.pieces, async (tx) => {
    // 合格复检：关闭该作品所有未关闭的返工
    if (isPass) {
      const openList = await tx
        .table('inspects')
        .where('pieceId')
        .equals(next.pieceId)
        .toArray()
      for (const raw of openList) {
        const row = raw as Inspect
        if (row.id === next.id) continue
        if (row.result !== '合格' && !row.reworkClosed) {
          await tx.table('inspects').update(row.id, {
            reworkClosed: true,
            reworkClosedBy: next.id,
            updatedAt: nowIso(),
          })
          // 清掉对应工序上的返工标记；工序本身的温度 / 时长 / 操作人记录不动
          if (row.reworkStepId !== '') {
            await tx
              .table('steps')
              .where('pieceId')
              .equals(next.pieceId)
              .modify((step: Step) => {
                if (step.id === row.reworkStepId && step.reworkMark) {
                  step.reworkMark = false
                  step.updatedAt = nowIso()
                }
              })
          }
        }
      }
      next.reworkClosed = false
      next.reworkClosedBy = ''
    } else {
      next.reworkClosed = false
      next.reworkClosedBy = ''
      // 锚定当前道次序号对应的工序 id（编辑一条已挂起的返工时，由这里重新对上）
      if (next.reworkStepId === '') {
        const step = await tx
          .table('steps')
          .where('pieceId')
          .equals(next.pieceId)
          .toArray()
        const pinned = (step as Step[]).find((row) => row.seq === next.reworkStepSeq)
        next.reworkStepId = pinned?.id ?? ''
      }
    }

    // 若编辑后从「不合格」变为其它情形，释放原锚定工序上的本侧返工标记
    const existing = options.existing
    if (existing && existing.reworkStepId !== '' && (isPass || existing.reworkStepId !== next.reworkStepId)) {
      await tx
        .table('steps')
        .where('pieceId')
        .equals(next.pieceId)
        .modify((step: Step) => {
          if (step.id === existing.reworkStepId && step.reworkMark) {
            step.reworkMark = false
            step.updatedAt = nowIso()
          }
        })
    }

    next.updatedAt = nowIso()
    await tx.table('inspects').put(next)
  })

  await syncPieceState(next.pieceId)
  return next
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.transaction('rw', db.inspects, db.steps, async () => {
    // 删除一条未关闭的返工时，顺手释放对应工序的本侧返工标记（不删工序记录）
    if (!row.reworkClosed && row.reworkStepId !== '') {
      await db.steps
        .where('pieceId')
        .equals(row.pieceId)
        .modify((step: Step) => {
          if (step.id === row.reworkStepId && step.reworkMark) {
            step.reworkMark = false
          }
        })
    }
    await db.inspects.delete(id)
  })
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
  // 兼容旧版存档：补齐 v3 新增字段（steps.reworkMark / inspects 返工指向）
  const normalizedSteps = snapshot.steps.map((row) => ({
    ...row,
    reworkMark: typeof row.reworkMark === 'boolean' ? row.reworkMark : false,
    revision: ROW_REVISION,
  }))
  const normalizedInspects = snapshot.inspects.map((row) => ({
    ...row,
    reworkStepSeq: typeof row.reworkStepSeq === 'number' ? row.reworkStepSeq : NO_REWORK_SEQ,
    reworkStepId: typeof row.reworkStepId === 'string' ? row.reworkStepId : '',
    reworkClosed: typeof row.reworkClosed === 'boolean' ? row.reworkClosed : false,
    reworkClosedBy: typeof row.reworkClosedBy === 'string' ? row.reworkClosedBy : '',
    legacy: typeof row.legacy === 'boolean' ? row.legacy : false,
    revision: ROW_REVISION,
  }))
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
    await db.steps.bulkPut(normalizedSteps)
    await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.inspects.bulkPut(normalizedInspects)
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
