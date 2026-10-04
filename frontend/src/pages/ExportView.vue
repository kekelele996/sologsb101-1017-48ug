<script setup lang="ts">
/**
 * /export 出炉检验登记与 JSON 结构版本导入导出 —— 检验室账本
 * 检验室只登记：检验结论、缺陷说明、返工退回哪道工序（作品 + 道次序号）。
 * 工序的温度 / 时长 / 操作人在吹制工序台维护，本页不碰。
 * 两边按作品 + 道次序号对账，对不上的返工挂起等确认；升级拆不出来的老记录只读。
 * 复用组件：<StatBadge>、<EmptyPanel>、<StageTag>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { DB_NAME, DB_SCHEMA_VERSION, ROW_REVISION, db, exportSnapshot, importSnapshot, resetDatabase, saveInspect } from '@/utils/db'
import { exportScheduleCsvFile, exportSnapshotJson, parseSnapshot } from '@/utils/export'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  INSPECT_RESULT_OPTIONS,
  NO_REWORK_SEQ,
  type Inspect,
  type InspectDraft,
  type InspectResult,
  type ReworkPhase,
} from '@/types/inspect'
import { reconcileInspect, type ReworkStatus } from '@/utils/rework'
import { nowIso, today, uuid } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const annealStore = useAnnealStore()
const furnaceStore = useFurnaceStore()

const { rows, loading, remove } = useIdbTable<Inspect>(db.inspects, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const resultFilter = ref<InspectResult | 'all'>('all')
const formRef = ref<FormInstance>()

const form = reactive<InspectDraft>({
  pieceId: '',
  result: '合格',
  defectNote: '',
  inspector: '',
  date: today(),
  reworkStepSeq: NO_REWORK_SEQ,
})

/** 当前所选作品的道次选项（检验室按作品 + 道次序号点中要退回的工序） */
const stepOptions = computed(() =>
  pieceStore
    .stepsOf(form.pieceId)
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((step) => ({ seq: step.seq, label: `第 ${step.seq} 道 · ${step.name}` })),
)

const rules = computed<FormRules<InspectDraft>>(() => ({
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  result: [{ required: true, message: '请选择检验结果', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检验人', trigger: 'blur' }],
  date: [{ required: true, message: '请选择检验日期', trigger: 'change' }],
  defectNote:
    form.result === '合格' ? [] : [{ required: true, message: '判定不合格时必须填写缺陷说明', trigger: 'blur' }],
  reworkStepSeq:
    form.result === '合格'
      ? []
      : [
          {
            validator: (_rule, value: number, callback: (err?: Error) => void) => {
              if (!value || value <= 0) callback(new Error('请选择返工退回的道次'))
              else if (!stepOptions.value.some((item) => item.seq === value))
                callback(new Error('该道次在工序台不存在，请先与工序台对账'))
              else callback()
            },
            trigger: 'change',
          },
        ],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

/** 逐条检验与工序台实时对账 */
function statusOf(row: Inspect): ReworkStatus {
  return reconcileInspect(row, pieceStore.steps)
}

const PHASE_TAG: Record<ReworkPhase, { type: 'info' | 'warning' | 'success' | 'danger'; text: string }> = {
  无返工: { type: 'success', text: '已归档' },
  待接收: { type: 'warning', text: '待工序台领取' },
  返工中: { type: 'warning', text: '工序返工中' },
  待复检: { type: 'success', text: '待复检关闭' },
  挂起: { type: 'danger', text: '挂起待确认' },
  只读老记录: { type: 'info', text: '只读老记录' },
}

const filtered = computed<Inspect[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (pieceLabel.value[row.pieceId] ?? '').toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.defectNote.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date))
})

const stats = computed(() => {
  const total = rows.value.length
  const pass = rows.value.filter((row) => row.result === '合格').length
  const defect = total - pass
  const open = rows.value.filter((row) => {
    const phase = statusOf(row).phase
    return phase === '待接收' || phase === '返工中' || phase === '待复检'
  }).length
  const suspended = rows.value.filter((row) => statusOf(row).phase === '挂起').length
  const readonlyLegacy = rows.value.filter((row) => statusOf(row).phase === '只读老记录').length
  return {
    total,
    pass,
    defect,
    open,
    suspended,
    readonlyLegacy,
    passPct: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    inProgress: pieceStore.pieces.filter((row) => row.state === '设计中' || row.state === '制作中').length,
    occupancyRate: annealStore.occupancyRate,
  }
})

onMounted(() => {
  void pieceStore.loadAll()
  void annealStore.loadAll()
  void furnaceStore.loadAll()
})

/** 返工退回道次默认取该作品最后一道（最靠近出炉的那道） */
function lastSeqOf(pieceId: string): number {
  const list = pieceStore.stepsOf(pieceId)
  return list.length === 0 ? NO_REWORK_SEQ : Math.max(...list.map((step) => step.seq))
}

function openCreate(): void {
  editingId.value = null
  const pieceId = pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? ''
  Object.assign(form, {
    pieceId,
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
    reworkStepSeq: NO_REWORK_SEQ,
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
  if (row.legacy && statusOf(row).phase === '只读老记录') {
    ElMessage.info('这是升级时拆不到具体道次的老返工记录，按要求只读保留，不能编辑。')
    return
  }
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    result: row.result,
    defectNote: row.defectNote,
    inspector: row.inspector,
    date: row.date,
    // 挂起后重新对账：用当前道次顺序回填，保存即重新锚定
    reworkStepSeq: row.result === '合格' ? NO_REWORK_SEQ : row.reworkStepSeq || lastSeqOf(row.pieceId),
  })
  dialogVisible.value = true
}

/** 不合格但该作品还没有工序时提示先建工序（检验仍可保存为挂起需由道次选择拦截，这里阻断更直观） */
async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const stamp = nowIso()
    if (editingId.value === null) {
      const row: Inspect = {
        id: uuid('inspect'),
        pieceId: form.pieceId,
        result: form.result,
        defectNote: form.defectNote.trim(),
        inspector: form.inspector.trim(),
        date: form.date,
        reworkStepSeq: form.result === '合格' ? NO_REWORK_SEQ : form.reworkStepSeq,
        reworkStepId: '',
        reworkClosed: false,
        reworkClosedBy: '',
        legacy: false,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      await saveInspect(row)
      ElMessage.success(
        form.result === '合格'
          ? '检验已登记：合格；该作品此前未关闭的返工已一并复检关闭'
          : `检验已登记：${form.result}，返工只退回第 ${form.reworkStepSeq} 道（前序工序记录保留不变）`,
      )
    } else {
      const existing = rows.value.find((row) => row.id === editingId.value)
      if (existing === undefined) return
      const next: Inspect = {
        ...existing,
        pieceId: form.pieceId,
        result: form.result,
        defectNote: form.defectNote.trim(),
        inspector: form.inspector.trim(),
        date: form.date,
        reworkStepSeq: form.result === '合格' ? NO_REWORK_SEQ : form.reworkStepSeq,
        // 编辑即按当前道次顺序重新确认：合格清空；不合格一律按（作品 + 所选道次）重新锚定，
        // 这样重排后即便别的工序占了同一序号，也能正确改指，不会被旧锚点卡住继续挂起。
        reworkStepId: '',
        legacy: existing.legacy,
      }
      await saveInspect(next, { existing })
      ElMessage.success('检验记录已更新，已按作品 + 道次序号重新对账')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Inspect): Promise<void> {
  if (row.legacy && statusOf(row).phase === '只读老记录') {
    ElMessage.info('只读老记录按升级要求保留，不能删除。')
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的检验记录（${row.result}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('检验记录已删除；被点中工序的温度 / 时长 / 操作人记录均保留')
}

async function handleExportJson(): Promise<void> {
  const snapshot = await exportSnapshot()
  const filename = exportSnapshotJson(snapshot)
  ElMessage.success(`已导出整库存档 ${filename}`)
}

function handleExportCsv(): void {
  const filename = exportScheduleCsvFile(
    furnaceStore.furnaces,
    furnaceStore.batches,
    pieceStore.pieces,
    pieceStore.steps,
    annealStore.anneals,
    rows.value,
  )
  ElMessage.success(`已导出窑务排产汇总 ${filename}`)
}

async function handleImport(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (raw === undefined) return
  const text = await raw.text()
  const result = parseSnapshot(text)
  if (!result.ok || result.snapshot === null) {
    ElMessage.error(result.message)
    return
  }
  await importSnapshot(result.snapshot)
  await Promise.all([pieceStore.loadAll(), annealStore.loadAll(), furnaceStore.loadAll()])
  ElMessage.success(`导入成功：${result.message}`)
}

function handleReset(): void {
  ElMessageBox.confirm(
    '全部窑炉、料液批次、作品、工序、退火与检验记录都会被清空，并重新灌入演示数据。',
    '确认重置本地数据？',
    { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetDatabase()
      await Promise.all([pieceStore.loadAll(), annealStore.loadAll(), furnaceStore.loadAll()])
      ElMessage.success('已重置为演示数据')
    })
    .catch(() => undefined)
}

/** 挂起返工快捷确认：跳到编辑弹窗并按当前道次顺序重新锚定 */
function handleReconfirm(row: Inspect): void {
  openEdit(row)
}

const defectRows = computed<Inspect[]>(() => rows.value.filter((row) => row.result !== '合格'))
const suspendedRows = computed<Inspect[]>(() => defectRows.value.filter((row) => statusOf(row).phase === '挂起'))
const readonlyRows = computed<Inspect[]>(() => defectRows.value.filter((row) => statusOf(row).phase === '只读老记录'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="不合格" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="进行中返工" :value="stats.open" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="挂起待确认" :value="stats.suspended" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="只读老记录" :value="stats.readonlyLegacy" suffix="条" tone="info" icon="Histogram" />
      <StatBadge label="合格率" :value="`${stats.passPct}%`" :percent="stats.passPct" tone="success" icon="PieChart" />
      <StatBadge label="在制件数" :value="stats.inProgress" suffix="件" tone="warning" icon="TrendCharts" />
      <StatBadge
        label="窑位占用率"
        :value="`${stats.occupancyRate}%`"
        :percent="stats.occupancyRate"
        tone="primary"
        icon="PieChart"
      />
      <StatBadge
        label="数据结构版本"
        :value="`v${DB_SCHEMA_VERSION}`"
        :suffix="`· ${DB_NAME}`"
        tone="info"
        icon="Histogram"
        hint="IndexedDB 库名与结构版本；v3 把返工从作品级拆到「作品 + 道次序号」，对不上的老记录只读保留"
      />
    </div>

    <el-alert
      v-if="suspendedRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${suspendedRows.length} 条返工按「作品 + 道次序号」对不上，已挂起等确认`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in suspendedRows" :key="row.id" class="defect-line">
            <span>
              {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：
              {{ statusOf(row).reason }}
            </span>
            <el-button link type="primary" size="small" @click="handleReconfirm(row)">按当前道次顺序确认</el-button>
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="readonlyRows.length > 0"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${readonlyRows.length} 条旧返工只记在作品上，升级时拆不到具体道次，已只读保留`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in readonlyRows" :key="row.id">
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：{{ row.defectNote }}
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="defectRows.filter((row) => { const p = statusOf(row).phase; return p === '待接收' || p === '返工中' || p === '待复检' }).length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      title="有返工尚未关闭，工序台只重开被点中的道次"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows.filter((row) => { const p = statusOf(row).phase; return p === '待接收' || p === '返工中' || p === '待复检' })" :key="row.id" class="defect-line">
            <span>
              {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }} ·
              退回第 {{ row.reworkStepSeq }} 道：{{ row.defectNote }}
            </span>
            <el-button link type="primary" size="small" @click="router.push(`/pieces/${row.pieceId}/steps`)">
              去工序台处理
            </el-button>
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">出炉检验登记与结构版本</span>
          <el-space wrap>
            <el-button @click="handleExportJson">
              <el-icon><Download /></el-icon>
              <span>导出 JSON 存档</span>
            </el-button>
            <el-button @click="handleExportCsv">
              <el-icon><Download /></el-icon>
              <span>导出 CSV 汇总</span>
            </el-button>
            <el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="handleImport">
              <el-button>
                <el-icon><Upload /></el-icon>
                <span>导入 JSON 存档</span>
              </el-button>
            </el-upload>
            <el-button type="danger" plain @click="handleReset">重置演示数据</el-button>
            <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记检验</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'result', label: '检验结果', options: INSPECT_RESULT_OPTIONS as unknown as string[] }]"
        :values="{ result: resultFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 条`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'result') resultFilter = value as InspectResult | 'all' }"
        @reset="
          () => {
            keyword = ''
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有出炉检验记录"
        description="作品退火出炉后登记检验结果；判定为裂纹 / 气泡 / 变形时按作品 + 道次序号点中要退回的工序，只重开该道、前面的工序记录保留；对账不上先挂起等确认。"
        action-text="登记第一条检验"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !pieceStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <StageTag
                :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检验日期" width="120" />
        <el-table-column label="检验结果" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.result === '合格' ? 'success' : row.result === '裂纹' ? 'danger' : row.result === '气泡' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="返工退回 / 对账" width="180">
          <template #default="{ row }">
            <template v-if="row.result === '合格'">
              <span class="cell-sub">合格归档</span>
            </template>
            <template v-else>
              <div class="cell-stack">
                <span>退回第 {{ row.reworkStepSeq || '—' }} 道</span>
                <el-tag size="small" :type="PHASE_TAG[statusOf(row).phase].type" effect="plain">
                  {{ PHASE_TAG[statusOf(row).phase].text }}
                </el-tag>
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明" min-width="280">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="110" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="statusOf(row).phase === '只读老记录'"
              @click="openEdit(row)"
            >
              {{ statusOf(row).phase === '挂起' ? '对账确认' : '编辑' }}
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :disabled="statusOf(row).phase === '只读老记录'"
              @click="handleDelete(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select
            v-model="form.pieceId"
            filterable
            style="width: 100%"
            @change="() => { if (form.result !== '合格') form.reworkStepSeq = lastSeqOf(form.pieceId) }"
          >
            <el-option
              v-for="item in pieceStore.pieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · ${item.state}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="检验结果" prop="result">
              <el-select
                v-model="form.result"
                style="width: 100%"
                @change="() => { form.reworkStepSeq = form.result === '合格' ? NO_REWORK_SEQ : lastSeqOf(form.pieceId) }"
              >
                <el-option v-for="item in INSPECT_RESULT_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验人" prop="inspector">
              <el-input v-model="form.inspector" placeholder="如：吴岚" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="form.result !== '合格'" label="返工退回道次" prop="reworkStepSeq">
          <el-select v-model="form.reworkStepSeq" style="width: 100%" placeholder="选择要退回的工序道次">
            <el-option v-for="item in stepOptions" :key="item.seq" :value="item.seq" :label="item.label" />
          </el-select>
          <div class="form-hint">返工只退回被点中的这一道；前面已确认工序的温度 / 时长 / 操作人记录不会被抹掉。</div>
        </el-form-item>
        <el-form-item label="缺陷说明" prop="defectNote">
          <el-input
            v-model="form.defectNote"
            type="textarea"
            :rows="2"
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度；返工将退回所选道次'"
          />
        </el-form-item>
        <el-alert
          v-if="form.result !== '合格'"
          type="warning"
          show-icon
          :closable="false"
          :title="`判定为「${form.result}」：返工退回第 ${form.reworkStepSeq || '—'} 道`"
          description="两边按作品 + 道次序号对账；隔天工序若重排导致对不上，返工会先挂起等确认，不会自动落到别的道次。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="登记合格复检会关闭该作品此前未关闭的返工，并清除工序台上的返工标记。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.defect-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.defect-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #8b95a1;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
