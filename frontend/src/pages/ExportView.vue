<script setup lang="ts">
/**
 * /export 出炉检验登记与 JSON 结构版本导入导出
 * 判定不合格时生成返工提示并保留原始工序记录；消费 Inspect 及全部模型。
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
import { DB_NAME, DB_SCHEMA_VERSION, db, exportSnapshot, importSnapshot, resetDatabase } from '@/utils/db'
import { exportScheduleCsvFile, exportSnapshotJson, parseSnapshot } from '@/utils/export'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  INSPECT_RESULT_OPTIONS,
  deriveReworkStatus,
  findReworkTarget,
  reworkStatusTagType,
  type Inspect,
  type InspectDraft,
  type InspectResult,
  type ReworkStatus,
} from '@/types/inspect'
import type { Step } from '@/types/step'
import { today } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const annealStore = useAnnealStore()
const furnaceStore = useFurnaceStore()

const { rows, loading, create, update, remove } = useIdbTable<Inspect>(db.inspects, { sortByUpdatedAt: false })

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
  reworkStepSeq: null,
})

/** 选中作品的吹制工序列表（供检验室指定返工退回哪道工序） */
const reworkTargetOptions = computed<Step[]>(() => pieceStore.stepsOf(form.pieceId))

/** 某条检验记录的返工对账状态（由检验记录 + 工序记录按作品 + 道次序号派生） */
function reworkStatusOf(row: Inspect): ReworkStatus {
  return deriveReworkStatus(
    row,
    pieceStore.steps.filter((s) => s.pieceId === row.pieceId),
  )
}

/** 某条检验记录返工指向的具体工序（对不上为 null） */
function reworkTargetOf(row: Inspect): Step | null {
  return findReworkTarget(
    row,
    pieceStore.steps.filter((s) => s.pieceId === row.pieceId),
  )
}

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
            required: true,
            validator: (_rule, value: number | null, callback) => {
              if (form.result === '合格') return callback()
              if (reworkTargetOptions.value.length === 0) return callback()
              if (value === null || value === undefined) {
                return callback(new Error('判定不合格时必须指定返工退回哪道工序'))
              }
              if (!reworkTargetOptions.value.some((s) => s.seq === value)) {
                return callback(new Error('指定的道次对不上当前工序，请重新选择'))
              }
              callback()
            },
            trigger: 'change',
          },
        ],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

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
  return {
    total,
    pass,
    defect,
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

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
    reworkStepSeq: null,
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
  if (row.legacyReadonly) {
    ElMessage.info('这是升级前的老返工记录，只记在作品上、拆不到具体道次，按要求保留只读，不可编辑')
    return
  }
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    result: row.result,
    defectNote: row.defectNote,
    inspector: row.inspector,
    date: row.date,
    reworkStepSeq: row.reworkStepSeq,
  })
  dialogVisible.value = true
}

/** 检验结果切到「合格」时清空返工道次；切到不合格时默认选中当前第一道 */
function onResultChange(): void {
  if (form.result === '合格') {
    form.reworkStepSeq = null
  } else if (form.reworkStepSeq === null && reworkTargetOptions.value.length > 0) {
    form.reworkStepSeq = reworkTargetOptions.value[0].seq
  }
}

/** 作品切换时，若已选返工道次不属于该作品则清空 */
function onPieceChange(): void {
  if (form.reworkStepSeq !== null && !reworkTargetOptions.value.some((s) => s.seq === form.reworkStepSeq)) {
    form.reworkStepSeq = reworkTargetOptions.value.length > 0 ? reworkTargetOptions.value[0].seq : null
  }
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form, legacyReadonly: false }, 'inspect')
      ElMessage.success(
        form.result === '合格'
          ? '检验已登记：合格'
          : `检验已登记：${form.result}，返工提示已生成（原始工序记录保留不变）`,
      )
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('检验记录已更新')
    }
    // 检验室这份写完后，再通知工序台按「作品 + 道次序号」退回指定道次。
    // 工序台保存失败只重试本侧（pieceStore.reworkStep 内部 withRetry），检验室那份不动。
    if (form.result !== '合格' && form.reworkStepSeq !== null) {
      const target = await pieceStore.reworkStep(form.pieceId, form.reworkStepSeq)
      if (target === null) {
        ElMessage.warning('指定的返工道次对不上当前工序，该笔返工已挂起，请确认退回道次')
      }
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Inspect): Promise<void> {
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
  ElMessage.success('检验记录已删除')
}

/* ------------------------- 挂起返工的确认 / 取消 ------------------------- */

const retargetVisible = ref(false)
const retargetRow = ref<Inspect | null>(null)
const retargetSeq = ref<number | null>(null)
const retargetOptions = computed<Step[]>(() =>
  retargetRow.value === null ? [] : pieceStore.stepsOf(retargetRow.value.pieceId),
)

function openRetarget(row: Inspect): void {
  retargetRow.value = row
  retargetSeq.value = row.reworkStepSeq
  retargetVisible.value = true
}

async function confirmRetarget(): Promise<void> {
  if (retargetRow.value === null) return
  if (retargetSeq.value === null) {
    ElMessage.warning('请选择要退回的道次')
    return
  }
  await update(retargetRow.value.id, { reworkStepSeq: retargetSeq.value })
  ElMessage.success('已重新确认返工道次')
  // 通知工序台按新道次返工（工序侧重试，检验室那份不动）
  const target = await pieceStore.reworkStep(retargetRow.value.pieceId, retargetSeq.value)
  if (target === null) {
    ElMessage.warning('该道次仍对不上当前工序，返工继续挂起')
  }
  retargetVisible.value = false
}

async function handleCancelRework(row: Inspect): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认取消 ${row.date} 检验的返工？取消后该笔不再退回任何工序。`, '取消返工确认', {
      type: 'warning',
      confirmButtonText: '取消返工',
      cancelButtonText: '返回',
    })
  } catch {
    return
  }
  await update(row.id, { reworkStepSeq: null })
  ElMessage.success('已取消返工')
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

const defectRows = computed<Inspect[]>(() => rows.value.filter((row) => row.result !== '合格'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="不合格" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
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
        hint="IndexedDB 库名与结构版本；v2 为 Piece 增加 craft 索引并回填默认值"
      />
    </div>

    <el-alert
      v-if="defectRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${defectRows.length} 条检验记录判定不合格，返工已按「作品 + 道次序号」退回指定工序`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows" :key="row.id" class="defect-row">
            <el-tag size="small" :type="reworkStatusTagType(reworkStatusOf(row))" effect="dark">
              {{ reworkStatusOf(row) }}
            </el-tag>
            <span>
              {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：
              {{ row.defectNote }}
              <template v-if="reworkTargetOf(row) !== null">
                —— 退回第 {{ reworkTargetOf(row)?.seq }} 道「{{ reworkTargetOf(row)?.name }}」返工，前面已确认的工序记录保留不变。
              </template>
              <template v-else-if="reworkStatusOf(row) === '已挂起'">
                —— 指定的返工道次对不上当前工序，已挂起等确认。
              </template>
              <template v-else-if="reworkStatusOf(row) === '只读'">
                —— 升级前的老返工记录，只记在作品上、拆不到具体道次，保留只读。
              </template>
            </span>
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
        description="作品退火出炉后登记检验结论与缺陷说明；判定为裂纹 / 气泡 / 变形时指定返工退回哪道工序，按「作品 + 道次序号」对账，前面已确认的工序记录保留不抹掉。"
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
        <el-table-column label="返工道次" width="150">
          <template #default="{ row }">
            <template v-if="row.result === '合格'">
              <span class="cell-sub">—</span>
            </template>
            <template v-else>
              <div class="cell-stack">
                <el-tag size="small" :type="reworkStatusTagType(reworkStatusOf(row))" effect="dark">
                  {{ reworkStatusOf(row) }}
                </el-tag>
                <span v-if="reworkTargetOf(row) !== null" class="cell-sub">
                  退回第 {{ reworkTargetOf(row)?.seq }} 道「{{ reworkTargetOf(row)?.name }}」
                </span>
                <span v-else-if="reworkStatusOf(row) === '已挂起'" class="cell-warn"> 道次对不上，待确认 </span>
                <span v-else-if="reworkStatusOf(row) === '只读'" class="cell-sub"> 老记录只读 </span>
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明" min-width="260">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="110" />
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <template v-if="row.legacyReadonly">
              <el-tag size="small" type="info" effect="plain">只读</el-tag>
            </template>
            <template v-else-if="reworkStatusOf(row) === '已挂起'">
              <el-button link type="warning" size="small" @click="openRetarget(row)">确认道次</el-button>
              <el-button link type="info" size="small" @click="handleCancelRework(row)">取消返工</el-button>
            </template>
            <template v-else>
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select v-model="form.pieceId" filterable style="width: 100%" @change="onPieceChange">
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
              <el-select v-model="form.result" style="width: 100%" @change="onResultChange">
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
        <el-form-item
          v-if="form.result !== '合格'"
          label="返工道次"
          prop="reworkStepSeq"
        >
          <el-select
            v-model="form.reworkStepSeq"
            filterable
            placeholder="选择返工退回哪道工序"
            style="width: 100%"
          >
            <el-option
              v-for="step in reworkTargetOptions"
              :key="step.id"
              :value="step.seq"
              :label="`第 ${step.seq} 道 · ${step.name} · ${step.state}`"
            />
          </el-select>
          <div class="form-hint">
            按「作品 + 道次序号」退回到具体那道工序；前面已确认的工序记录保留不抹掉。
            <template v-if="reworkTargetOptions.length === 0">该作品还没有工序，无法指定返工道次。</template>
          </div>
        </el-form-item>
        <el-form-item label="缺陷说明" prop="defectNote">
          <el-input
            v-model="form.defectNote"
            type="textarea"
            :rows="2"
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度，并给出返工建议'"
          />
        </el-form-item>
        <el-alert
          v-if="form.result !== '合格'"
          type="warning"
          show-icon
          :closable="false"
          :title="`判定为「${form.result}」将生成返工提示`"
          description="返工只退回被点中的那道工序，前面已确认的工序记录完整保留；工序台保存失败只重试工序侧，检验室这份不动。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="检验合格后作品状态会自动回写为「已检验」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="retargetVisible" title="确认返工退回的道次" width="480px">
      <el-form label-width="110px">
        <el-form-item label="作品">
          <span>{{ retargetRow === null ? '' : pieceLabel[retargetRow.pieceId] ?? '（作品已删除）' }}</span>
        </el-form-item>
        <el-form-item label="检验结果">
          <el-tag size="small" :type="retargetRow === null ? 'info' : reworkStatusTagType(reworkStatusOf(retargetRow))">
            {{ retargetRow === null ? '' : reworkStatusOf(retargetRow) }}
          </el-tag>
          <span class="cell-sub" style="margin-left: 8px">
            {{ retargetRow?.date }} · {{ retargetRow?.result }}
          </span>
        </el-form-item>
        <el-form-item label="退回道次" required>
          <el-select v-model="retargetSeq" filterable placeholder="选择返工退回哪道工序" style="width: 100%">
            <el-option
              v-for="step in retargetOptions"
              :key="step.id"
              :value="step.seq"
              :label="`第 ${step.seq} 道 · ${step.name} · ${step.state}`"
            />
          </el-select>
          <div class="form-hint">按「作品 + 道次序号」重新对账；对不上的道次会继续挂起等确认。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="retargetVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmRetarget">确认道次</el-button>
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
  gap: 6px;
  font-size: 12px;
  line-height: 1.8;
}

.defect-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.form-hint {
  font-size: 12px;
  color: #8b95a1;
  line-height: 1.6;
  margin-top: 4px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
