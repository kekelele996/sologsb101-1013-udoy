<script setup lang="ts">
/**
 * 礁区档案室 · 年度定案与对账（/archive）
 * 档案室只管礁区与「年度定案巡次」：定下后覆盖率、白化指数与导出结论按那次重出。
 * 两边按站位编号 + 样带编号对账，对不上的巡次单列；
 * 对账失败只提示外业普查组这侧重跑，档案室定的巡次不回退。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, CircleCheck, Download, RefreshRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useReefStore } from '@/stores/reefStore'
import { useVisitStore } from '@/stores/visitStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { useCanonicalStore } from '@/stores/canonicalStore'
import { CANONICAL_STATUS_LABEL, RESOLUTION_POLICY, type CanonicalStatus } from '@/utils/reconcile'
import { buildConclusionText, downloadConclusionText } from '@/utils/export'
import { initDatabase } from '@/utils/db'

const reefStore = useReefStore()
const visitStore = useVisitStore()
const archiveStore = useArchiveStore()
const canonical = useCanonicalStore()

const dialogReefId = ref<string>('')
const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({
  year: new Date().getFullYear(),
  visitId: '',
  archivist: '',
  opinion: ''
})

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})

const summaries = computed(() => canonical.reefSummaries)
const mismatches = computed(() => canonical.mismatches)
const unassigned = computed(() => canonical.unassignedBelts)

const stats = computed(() => ({
  reefCount: summaries.value.filter((s) => s.beltCount > 0).length,
  finalizedCount: summaries.value.filter((s) => s.finalizedVisitId).length,
  mismatchCount: mismatches.value.length,
  unassignedCount: unassigned.value.length
}))

function visitOptions(reefId: string, year: number) {
  return visitStore.visitsOfReefYear(reefId, year)
}

function openFinalize(reefId: string): void {
  dialogReefId.value = reefId
  const existing = archiveStore.finalizationOf(reefId, canonical.year)
  form.year = canonical.year
  form.visitId = existing?.visitId ?? visitOptions(reefId, canonical.year)[0]?.id ?? ''
  form.archivist = existing?.archivist ?? ''
  form.opinion = existing?.opinion ?? ''
  dialogVisible.value = true
}

async function submitFinalize(): Promise<void> {
  if (!form.visitId) {
    ElMessage.warning('请选择该年度要定案的巡次')
    return
  }
  submitting.value = true
  try {
    await archiveStore.upsertFinalization(
      {
        reefId: dialogReefId.value,
        year: form.year,
        visitId: form.visitId,
        archivist: form.archivist,
        opinion: form.opinion
      },
      visitStore.visits
    )
    ElMessage.success('年度定案巡次已定下，覆盖率 / 白化指数 / 导出结论已按该次重出')
    dialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '定案失败')
  } finally {
    submitting.value = false
  }
}

async function revokeFinalization(reefId: string, reefName: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销「${reefName}」${form.year === canonical.year ? canonical.year : ''} 年度定案？仅撤销档案室这侧的定案标记，外业普查组的巡访记录原样保留，之后评定改取后一次巡访。`,
      '撤销定案',
      { type: 'warning', confirmButtonText: '撤销定案', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await archiveStore.removeFinalization(reefId, canonical.year)
  ElMessage.success('已撤销定案；普查组巡访记录未改动')
}

/** 档案室「重跑」：只重新派生普查组这侧的口径（liveQuery 已响应），不回退任何定案 */
function rerunCensusSide(): void {
  // 切换年度再切回，强制下游重算；定案记录完全不触碰
  const y = canonical.year
  canonical.selectYear(y)
  ElMessage.success('已按普查组最新巡访记录重新对账；档案室定案巡次保持不变、不回退')
}

async function exportConclusion(): Promise<void> {
  const payload = {
    app: 'gbcoralbelt' as const,
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    reefs: canonical.dataset.reefs,
    sites: canonical.dataset.sites,
    visits: canonical.dataset.visits,
    finalizations: canonical.dataset.finalizations,
    belts: canonical.dataset.belts,
    corals: canonical.dataset.corals,
    fishes: canonical.dataset.fishes
  }
  const text = buildConclusionText(payload, canonical.year, mismatches.value)
  const fileName = downloadConclusionText(text, canonical.year)
  ElMessage.success(`已按统一口径导出 ${canonical.year} 年度结论：${fileName}`)
}

function statusType(status: string): 'success' | 'info' | 'warning' | 'danger' {
  if (status === 'finalized-ok') return 'success'
  if (status === 'finalized-divergent') return 'warning'
  if (status === 'gap-filled') return 'warning'
  return 'info'
}

function statusLabel(status: CanonicalStatus): string {
  return CANONICAL_STATUS_LABEL[status]
}

function visitStillExists(visitId: string | null): boolean {
  if (!visitId) return false
  return visitStore.visits.some((visit) => visit.id === visitId)
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">礁区档案室 · 年度定案与对账</h2>
        <p class="gb-hint">
          档案室定礁区与年度定案巡次，定下后覆盖率、白化指数与导出结论按那次重出。{{ RESOLUTION_POLICY.label }}。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="canonical.year" class="page__year-select" @change="(v: number) => canonical.selectYear(Number(v))">
          <el-option v-for="y in canonical.years.length ? canonical.years : [canonical.year]" :key="y" :label="`${y} 年度`" :value="y" />
        </el-select>
        <el-button :icon="RefreshRight" @click="rerunCensusSide">仅重跑普查组对账</el-button>
        <el-button type="primary" :icon="Download" @click="exportConclusion">导出年度结论</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="参评礁区" :value="stats.reefCount" suffix="个" icon="Odometer" />
      <StatBadge label="已定案礁区" :value="stats.finalizedCount" suffix="个" tone="success" icon="CircleCheck" />
      <StatBadge label="对不上的巡次" :value="stats.mismatchCount" suffix="处" :tone="stats.mismatchCount > 0 ? 'warning' : 'success'" icon="WarningFilled" />
      <StatBadge label="补不出巡次样带" :value="stats.unassignedCount" suffix="条" :tone="stats.unassignedCount > 0 ? 'warning' : 'success'" icon="Files" />
    </div>

    <el-alert
      :title="`评定 / 导出统一口径：${RESOLUTION_POLICY.label}`"
      type="info"
      :closable="false"
      show-icon
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>{{ canonical.year }} 年度各礁区定案与评定（按定案巡次重出）</h3>
        <span class="gb-hint">未定案的礁区取后一次巡访；平均白化指数按口径样带算术平均</span>
      </div>
      <EmptyPanel
        v-if="summaries.length === 0"
        title="还没有可评定的礁区"
        description="请先由外业普查组登记巡访并布设样带。"
        compact
      />
      <el-table v-else :data="summaries" border stripe class="gb-table-compact">
        <el-table-column prop="reefName" label="礁区" min-width="160" />
        <el-table-column prop="protectStatus" label="保护区" width="100" />
        <el-table-column label="定案巡次" min-width="200">
          <template #default="{ row }">
            <el-tag v-if="row.finalizedVisitId" :type="visitStillExists(row.finalizedVisitId) ? 'success' : 'danger'" size="small">
              {{ row.finalizedVisitName || '已定案' }}
            </el-tag>
            <el-tag v-else type="info" size="small" effect="plain">未定案 · 取后一次</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="站位 / 样带" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.siteCount }} / {{ row.beltCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均覆盖率" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.avgCoveragePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="平均白化" width="170">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <span class="gb-hint gb-mono"> {{ row.avgBleachIndex }} · 占比 {{ row.bleachedSharePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="鱼类" width="90" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }}</span>
          </template>
        </el-table-column>
        <el-table-column label="差异" width="80" align="center">
          <template #default="{ row }">
            <el-badge v-if="row.mismatchCount > 0" :value="row.mismatchCount" type="warning" />
            <el-icon v-else color="#1e8449"><CircleCheck /></el-icon>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Check" @click="openFinalize(row.reefId)">
              {{ row.finalizedVisitId ? '改选定案' : '定案巡次' }}
            </el-button>
            <el-button v-if="row.finalizedVisitId" size="small" type="warning" plain @click="revokeFinalization(row.reefId, row.reefName)">
              撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>对不上的巡次（{{ mismatches.length }} 处，单列）</h3>
        <span class="gb-hint">按站位编号 + 样带编号对账；这些不影响已定案结果，只提示外业普查组核对重跑，定案不回退</span>
      </div>
      <EmptyPanel
        v-if="mismatches.length === 0"
        title="本年度没有对不上的巡次"
        description="各编号样带的多次巡访一致，或已全部由定案巡次覆盖。"
        compact
      />
      <el-table v-else :data="mismatches" border stripe size="small" class="gb-table-compact">
        <el-table-column label="礁区 / 站位 / 样带" min-width="200">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }} · 共 {{ row.observations.length }} 次巡访</div>
          </template>
        </el-table-column>
        <el-table-column label="口径处理" width="200">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="定案巡次" min-width="170">
          <template #default="{ row }">
            <template v-if="row.finalized">
              <div class="gb-mono">{{ row.finalized.visitName }} · {{ row.finalized.surveyDate }}</div>
              <div class="gb-hint gb-mono">覆盖 {{ row.finalized.coveragePct }}% · 指数 {{ row.finalized.bleachIndex }}（{{ row.finalized.grade }}）</div>
            </template>
            <span v-else class="gb-hint">定案巡次该编号缺测 / 未定案</span>
          </template>
        </el-table-column>
        <el-table-column label="后一次巡访" min-width="170">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.latest.visitName }} · {{ row.latest.surveyDate }}</div>
            <div class="gb-hint gb-mono">覆盖 {{ row.latest.coveragePct }}% · 指数 {{ row.latest.bleachIndex }}（{{ row.latest.grade }}）</div>
          </template>
        </el-table-column>
        <el-table-column label="历次巡访（时间先后）" min-width="260">
          <template #default="{ row }">
            <div v-for="obs in row.observations" :key="obs.beltId" class="arch-obs">
              <el-tag size="small" :type="obs.isFinalized ? 'success' : obs.isLatest ? 'info' : 'info'" effect="plain">
                {{ obs.isFinalized ? '定案' : obs.isLatest ? '后一次' : '较早' }}
              </el-tag>
              <span class="gb-mono">{{ obs.visitName }} {{ obs.surveyDate }}</span>
              <span class="gb-hint gb-mono">覆盖 {{ obs.coveragePct }}% · 指数 {{ obs.bleachIndex }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="unassigned.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>补不出巡次的样带（{{ unassigned.length }} 条）</h3>
        <span class="gb-hint">旧数据调查日期缺失，未进入任何年度评定；请外业普查组到「巡次登记」页补挂</span>
      </div>
      <el-table :data="unassigned" border stripe size="small">
        <el-table-column label="礁区 / 站位 / 样带" min-width="220">
          <template #default="{ row }">
            {{ row.reefName }} · 站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}
          </template>
        </el-table-column>
        <el-table-column prop="surveyDate" label="调查日期" width="130">
          <template #default="{ row }">
            <el-tag type="danger" size="small" effect="plain">{{ row.surveyDate || '日期缺失' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="coralCount" label="珊瑚记录" width="100" align="right" />
        <el-table-column label="白化指数" width="110" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.bleachIndex }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="年度定案巡次" width="540px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="定案年份">
          <el-input-number v-model="form.year" :min="2000" :max="2100" :step="1" controls-position="right" disabled />
        </el-form-item>
        <el-form-item label="定案巡次" required>
          <el-select v-model="form.visitId" placeholder="选择该年度外业登记的某次巡访" class="page__full">
            <el-option
              v-for="visit in visitOptions(dialogReefId, form.year)"
              :key="visit.id"
              :label="`${visit.name}（${visit.leader || '领队未填'}）`"
              :value="visit.id"
            />
          </el-select>
          <div v-if="visitOptions(dialogReefId, form.year).length === 0" class="gb-hint">
            该年度外业普查组还没有登记巡访，档案室不能凭空定案；请到「巡次登记」补登。
          </div>
        </el-form-item>
        <el-form-item label="经办人">
          <el-input v-model="form.archivist" placeholder="如：周档案" maxlength="20" />
        </el-form-item>
        <el-form-item label="定案意见">
          <el-input v-model="form.opinion" type="textarea" :rows="2" placeholder="如：Q4 覆盖恢复，采用冬季定案" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!form.visitId" @click="submitFinalize">
          定下并按该次重出
        </el-button>
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
.page__year-select {
  width: 130px;
}
.page__full {
  width: 100%;
}
.arch-obs {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 12px;
}
</style>
