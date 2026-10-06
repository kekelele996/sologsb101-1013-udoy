<script setup lang="ts">
/**
 * 档案室（/archive）：管礁区与年度定案巡次。
 * - 选定年份后逐礁区从该年普查巡次里定下一条年度巡次；
 * - 定案即时按「定案覆盖、缺号取后一次补位、其余单列」口径对账，只重跑普查侧、不回退定案；
 * - 对不上的巡次/样带单列展示；可导出该年度定案结论 JSON（与评定同口径）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Refresh } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useReefStore } from '@/stores/reefStore'
import { useVisitStore } from '@/stores/visitStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { useArchive } from '@/hooks/useArchive'
import { quarterLabel } from '@/types/visit'
import { exportFinalizationJson } from '@/utils/export'
import { initDatabase } from '@/utils/db'

const reefStore = useReefStore()
const visitStore = useVisitStore()
const archiveStore = useArchiveStore()

const selectedYear = ref<number | null>(null)
const busy = ref(false)
const dialogReefId = ref<string | null>(null)
const dialogVisible = ref(false)
const dialogVisitId = ref('')
const dialogDecidedBy = ref('档案室·周审')
const dialogNote = ref('')

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})

const archive = useArchive()

const yearOptions = computed(() => {
  const years = new Set<number>([...visitStore.availableYears, ...archiveStore.finalizedYears])
  return Array.from(years).sort((a, b) => b - a)
})

const effectiveYear = computed<number | null>(() =>
  selectedYear.value ?? archiveStore.latestYear ?? yearOptions.value[0] ?? null
)

function ensureYear(): void {
  if (selectedYear.value === null && archiveStore.latestYear !== null) {
    selectedYear.value = archiveStore.latestYear
  }
}

const results = computed(() => archive.resultsForYear(effectiveYear.value).value)

const reefCards = computed(() =>
  reefStore.reefs.map((reef) => {
    const fin = effectiveYear.value === null ? null : archiveStore.finalizationOf(reef.id, effectiveYear.value)
    const result = results.value.find((item) => item.reefId === reef.id) ?? null
    const candidateVisits = effectiveYear.value === null ? [] : visitStore.visitsOfYear(effectiveYear.value)
    const [lastRun] = fin ? archiveStore.runsOf(fin.id) : []
    return { reef, fin, result, candidateVisits, lastRun }
  })
)

const totals = computed(() => ({
  reefCount: reefCards.value.length,
  finalized: reefCards.value.filter((card) => card.fin).length,
  resolvedBelts: results.value.reduce((sum, result) => sum + result.lines.length, 0),
  mismatches: results.value.reduce((sum, result) => sum + result.mismatches.length, 0),
  failed: results.value.filter((result) => result.status === '失败').length
}))

function openDecide(reefId: string): void {
  if (effectiveYear.value === null) {
    ElMessage.warning('请先在右上角选择定案年份')
    return
  }
  const fin = archiveStore.finalizationOf(reefId, effectiveYear.value)
  dialogReefId.value = reefId
  dialogVisitId.value = fin?.visitId ?? visitStore.visitsOfYear(effectiveYear.value)[0]?.id ?? ''
  dialogDecidedBy.value = fin?.decidedBy || '档案室·周审'
  dialogNote.value = fin?.note ?? ''
  dialogVisible.value = true
}

async function submitDecide(): Promise<void> {
  if (effectiveYear.value === null || !dialogReefId.value) return
  if (!dialogVisitId.value) {
    ElMessage.warning('请选择一条普查巡次作为年度定案')
    return
  }
  busy.value = true
  try {
    const { run } = await archiveStore.decideFinalization({
      reefId: dialogReefId.value,
      year: effectiveYear.value,
      visitId: dialogVisitId.value,
      decidedBy: dialogDecidedBy.value,
      note: dialogNote.value
    })
    ElMessage.success(
      run.status === '通过'
        ? `已定案 ${effectiveYear.value} 年度巡次，对账通过（纳入 ${run.resolvedBeltCount} 条样带）`
        : `已定案 ${effectiveYear.value} 年度巡次，对账发现 ${run.mismatchCount} 条对不上，已单列（定案不回退）`
    )
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定案失败')
  } finally {
    busy.value = false
  }
}

async function rerun(reefId: string): Promise<void> {
  if (effectiveYear.value === null) return
  const fin = archiveStore.finalizationOf(reefId, effectiveYear.value)
  if (!fin) return
  busy.value = true
  try {
    const run = await archiveStore.rerunById(fin.id)
    ElMessage.success(
      run.status === '通过'
        ? `已重跑普查侧对账，本次通过（${run.resolvedBeltCount} 条样带）；档案室定案巡次保持不变`
        : `已重跑普查侧对账，仍有 ${run.mismatchCount} 条对不上（已单列）；档案室定案巡次不回退`
    )
  } finally {
    busy.value = false
  }
}

async function exportConclusions(): Promise<void> {
  if (effectiveYear.value === null || results.value.length === 0) {
    ElMessage.warning('当前年份还没有定案，暂无可导出的结论')
    return
  }
  busy.value = true
  try {
    const { fileName } = await exportFinalizationJson(results.value, effectiveYear.value)
    ElMessage.success(`已导出 ${effectiveYear.value} 年度定案结论：${fileName}`)
  } finally {
    busy.value = false
  }
}

function visitTagType(kind: string): 'info' | 'warning' {
  return kind === '补登' ? 'warning' : 'info'
}

onMounted(ensureYear)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">礁区档案室 · 年度定案巡次</h2>
        <p class="gb-hint">
          普查组按巡次保留每次重访；档案室为每个礁区选定一条年度定案巡次后，覆盖率、白化指数与导出结论只按那次重出。
          口径：同编号取定案那次（不平均），定案缺号取同年后一次补位，对不上的巡次/样带单列；对账只重跑普查侧，定案不回退。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="effectiveYear"
          placeholder="选择年份"
          style="width: 140px"
          @update:model-value="(value: number) => (selectedYear = value)"
        >
          <el-option v-for="year in yearOptions" :key="year" :label="`${year} 年度`" :value="year" />
        </el-select>
        <el-button type="primary" :icon="Download" :loading="busy" :disabled="results.length === 0" @click="exportConclusions">
          导出 {{ effectiveYear }} 定案结论
        </el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="礁区数" :value="totals.reefCount" suffix="个" icon="Odometer" />
      <StatBadge label="已定案" :value="totals.finalized" suffix="个" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="纳入评定样带" :value="totals.resolvedBelts" suffix="条" icon="Files" />
      <StatBadge label="对不上条目" :value="totals.mismatches" suffix="条" :tone="totals.mismatches > 0 ? 'warning' : 'success'" icon="WarningFilled" />
      <StatBadge label="对账失败礁区" :value="totals.failed" suffix="个" :tone="totals.failed > 0 ? 'warning' : 'success'" icon="CircleCloseFilled" />
    </div>

    <EmptyPanel
      v-if="reefCards.length === 0"
      title="还没有礁区"
      description="请先到礁区台账建立礁区与站位，并由普查组按巡次完成样带与记录录入。"
      compact
    />

    <el-card v-for="card in reefCards" :key="card.reef.id" shadow="never" class="gb-panel archive-card">
      <div class="archive-card__head">
        <div>
          <h3 class="archive-card__title">
            {{ card.reef.name }}
            <el-tag size="small" effect="plain">{{ card.reef.protectStatus }}</el-tag>
            <el-tag v-if="card.fin" size="small" type="success">已定案 {{ card.fin.year }} · {{ card.result?.visitCode }}</el-tag>
            <el-tag v-else size="small" type="info">未定案</el-tag>
          </h3>
          <p class="gb-hint">{{ card.reef.location }} · {{ card.reef.manager || '未填写管理单位' }}</p>
        </div>
        <div class="archive-card__ops">
          <el-button size="small" :icon="Refresh" :loading="busy" :disabled="!card.fin" @click="rerun(card.reef.id)">
            重跑普查侧对账
          </el-button>
          <el-button size="small" type="primary" @click="openDecide(card.reef.id)">
            {{ card.fin ? '改定巡次' : '定下年度巡次' }}
          </el-button>
        </div>
      </div>

      <template v-if="card.fin && card.result">
        <div class="archive-card__meta gb-hint">
          定案巡次 {{ card.result.visitCode }}（{{ quarterLabel(card.result.quarter ?? 1) }}）· 定案人 {{ card.fin.decidedBy || '—' }}
          · 最近对账 {{ card.lastRun ? new Date(card.lastRun.runAt).toLocaleString('zh-CN') : '—' }}
          <el-tag size="small" :type="card.result.status === '通过' ? 'success' : 'danger'">
            对账{{ card.result.status }}
          </el-tag>
        </div>

        <div class="archive-card__stats">
          <span>站位 {{ card.result.summary.siteCount }}</span>
          <span>样带 {{ card.result.summary.beltCount }}</span>
          <span>珊瑚覆盖率均值 {{ card.result.summary.avgCoveragePct }}%</span>
          <span>平均白化指数 {{ card.result.summary.avgBleachIndex }}</span>
          <BleachTag :level="card.result.summary.grade" size="small" />
          <span>白化占比 {{ card.result.summary.bleachedSharePct }}%</span>
          <span>鱼类 {{ card.result.summary.fishTotal }} 尾（{{ card.result.summary.fishDensityValue }} 尾/100m²）</span>
        </div>

        <el-table :data="card.result.lines" border stripe size="small" class="gb-table-compact">
          <el-table-column label="站位/样带" width="130">
            <template #default="{ row }">
              <div>{{ row.siteNo }} · {{ row.beltNo }}</div>
              <el-tag size="small" :type="row.source === '定案覆盖' ? 'success' : 'warning'">{{ row.source }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="visitCode" label="取自巡次" width="110" />
          <el-table-column label="覆盖率" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.coveragePct }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="白化" width="170">
            <template #default="{ row }">
              <BleachTag :level="row.grade" size="small" />
              <span class="gb-hint gb-mono"> 指数 {{ row.bleachIndexValue }} · 白化占比 {{ row.bleachedSharePct }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="调查" min-width="150">
            <template #default="{ row }">
              <div class="gb-mono">{{ row.surveyDate }}</div>
              <div class="gb-hint">{{ row.observer || '未填写调查人' }}</div>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          v-if="card.result.mismatches.length > 0"
          class="archive-card__alert"
          type="warning"
          :closable="false"
          show-icon
          :title="`对账失败：${card.result.mismatches.length} 条对不上（单列，不参与评定与导出）；重跑只重算普查侧，定案巡次不回退`"
        >
          <div v-for="(item, index) in card.result.mismatches" :key="`${item.beltId}-${index}`" class="archive-mismatch">
            <el-tag size="small" :type="visitTagType(item.kind)">{{ item.kind }}</el-tag>
            <span class="gb-mono">{{ item.visitCode }} · {{ item.siteNo }} · {{ item.beltNo }}</span>
            <span class="gb-hint">{{ item.detail }}</span>
          </div>
        </el-alert>
      </template>

      <EmptyPanel
        v-else
        title="该礁区尚未定下年度巡次"
        :description="`从 ${effectiveYear ?? '所选'} 年的普查巡次里选定一条作为年度定案，覆盖率、白化指数与导出结论即按那次重出。`"
        action-text="定下年度巡次"
        compact
        @action="openDecide(card.reef.id)"
      />
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="`${reefStore.reefById(dialogReefId)?.name ?? ''} · 定下 ${effectiveYear} 年度巡次`"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form label-width="96px">
        <el-form-item label="年度定案" required>
          <el-select v-model="dialogVisitId" placeholder="选择该年普查巡次" style="width: 100%">
            <el-option
              v-for="visit in visitStore.visitsOfYear(effectiveYear ?? 0)"
              :key="visit.id"
              :label="`${visit.code}（${quarterLabel(visit.quarter)}，开始 ${visit.startedOn || '—'}）`"
              :value="visit.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="定案人">
          <el-input v-model="dialogDecidedBy" placeholder="如：档案室·周审" maxlength="20" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="dialogNote" type="textarea" :rows="2" maxlength="120" show-word-limit />
        </el-form-item>
      </el-form>
      <p class="gb-hint">定下后立即按统一口径对账；之后普查组补录数据只需「重跑普查侧对账」，已定巡次不会回退。</p>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitDecide">定下并重出</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.archive-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.archive-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.archive-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  color: #0b5d5a;
}

.archive-card__ops {
  display: flex;
  gap: 8px;
}

.archive-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.archive-card__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  color: #33504d;
}

.archive-card__alert {
  margin-top: 4px;
}

.archive-mismatch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
