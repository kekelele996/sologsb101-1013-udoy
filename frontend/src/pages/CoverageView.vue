<script setup lang="ts">
/**
 * 模块 6：/coverage 白化等级评定与覆盖度汇总
 * 两套口径分开看：
 * - 普查原始：外业普查组每次巡访各算各的（可按巡次/年份筛选），原始记录照旧保留；
 * - 档案室定案：按选定年度已定案巡次重出覆盖率、白化指数与结论（与档案室页、导出 JSON 同一口径），
 *   对不上的巡次/样带单列，不参与评定与导出。
 * 同时提供结构版本查看与全量 JSON 导入导出。复用 <BleachTag>、<FilterBar>。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToArray, queryToBool } from '@/types/filter'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useVisitStore } from '@/stores/visitStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { useArchive } from '@/hooks/useArchive'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import { BLEACH_COLOR } from '@/utils/bleach'
import {
  DB_NAME,
  DB_VERSION,
  countAll,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  type BackupPayload
} from '@/utils/db'
import {
  exportBackupJson,
  exportFinalizationJson,
  importBackup,
  readFileText,
  remapIds,
  validateBackup,
  type CountMap
} from '@/utils/export'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const surveyStore = useSurveyStore()
const visitStore = useVisitStore()
const archiveStore = useArchiveStore()
const archive = useArchive()

const EMPTY_COUNTS: CountMap = {
  reefs: 0,
  sites: 0,
  visits: 0,
  belts: 0,
  corals: 0,
  fishes: 0,
  finalizations: 0,
  reconciliations: 0
}

const counts = ref<CountMap>(EMPTY_COUNTS)
const lastBackupAt = ref<string | null>(null)
const stampedVersion = ref<number>(DB_VERSION)
const overwriteOnImport = ref(true)
const fileList = ref<UploadFile[]>([])
const busy = ref(false)
const notice = ref('')

/** 评定口径：普查原始 / 档案室定案 */
const viewMode = ref<'finalized' | 'raw'>('finalized')
const selectedYear = ref<number | null>(null)
const rawVisitId = ref<string | null>(null)

// 普查原始口径按所选巡次过滤（null = 全部巡次，各次分开列示）
watch(rawVisitId, (value) => {
  surveyStore.patchFilter({ visitId: value })
})

const filterModel = computed<FilterModel>(() => ({
  keyword: surveyStore.filter.keyword,
  reefIds: surveyStore.filter.reefIds,
  bleachLevels: surveyStore.filter.bleachLevels
}))

const effectiveYear = computed<number | null>(
  () => selectedYear.value ?? archiveStore.latestYear ?? visitStore.availableYears[0] ?? null
)

/** 该年度档案室定案结果（评定=导出口径） */
const finalizedResults = computed(() => archive.resultsForYear(effectiveYear.value).value)

/** 定案口径下展平的样带行（套用与普查视图相同的筛选条件）；字段两套口径对齐 */
interface FlatRow {
  reefId: string
  reefName: string
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  visitId: string
  visitCode: string
  source: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndexValue: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensityValue: number
}

function flattenResults(): FlatRow[] {
  return finalizedResults.value.flatMap((result) =>
    result.lines.map((line) => ({
      reefId: result.reefId,
      reefName: reefStore.reefById(result.reefId)?.name ?? '未知礁区',
      ...line
    }))
  )
}

const finalizedRows = computed<FlatRow[]>(() =>
  flattenResults()
    .filter((row) => {
      const keyword = surveyStore.filter.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}${row.visitCode}`
        if (!haystack.includes(keyword)) return false
      }
      if (surveyStore.filter.reefIds.length > 0 && !surveyStore.filter.reefIds.includes(row.reefId)) return false
      if (surveyStore.filter.bleachLevels.length > 0) {
        const matched = surveyStore.filter.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (surveyStore.filter.onlyBleached && row.bleachedSharePct <= 0) return false
      return true
    })
    .sort((a, b) => a.siteNo.localeCompare(b.siteNo, 'zh-Hans-CN') || a.beltNo.localeCompare(b.beltNo, 'zh-Hans-CN'))
)

/** 普查原始行归一到与定案行相同的字段（各巡次分开，不混算） */
const rawRows = computed<FlatRow[]>(() =>
  surveyStore.filteredCoverageRows.map((row) => ({
    reefId: row.reefId,
    reefName: row.reefName,
    beltId: row.beltId,
    beltNo: row.beltNo,
    siteId: row.siteId,
    siteNo: row.siteNo,
    visitId: row.visitId,
    visitCode: row.visitCode,
    source: row.visitKind === '补登' ? '补登单列' : '普查原始',
    lengthM: row.lengthM,
    orientation: row.orientation,
    surveyDate: row.surveyDate,
    observer: row.observer,
    coralCount: row.coralCount,
    coverCmTotal: row.coverCmTotal,
    coveragePct: row.coveragePct,
    bleachIndexValue: row.bleachIndex,
    grade: row.grade,
    bleachedSharePct: row.bleachedSharePct,
    distribution: row.distribution,
    fishTotal: row.fishTotal,
    invertebrateTotal: row.invertebrateTotal,
    fishDensityValue: row.fishDensity
  }))
)

const rows = computed<FlatRow[]>(() => (viewMode.value === 'finalized' ? finalizedRows.value : rawRows.value))

/** 定案口径下对不上的条目（单列区，不受关键词筛选影响） */
const mismatchGroups = computed(() =>
  finalizedResults.value.map((result) => ({
    reefName: reefStore.reefById(result.reefId)?.name ?? '未知礁区',
    visitCode: result.visitCode,
    mismatches: result.mismatches
  }))
)
const allMismatches = computed(() => mismatchGroups.value.flatMap((group) => group.mismatches))

const totals = computed(() => ({
  belts: rows.value.length,
  coralCount: rows.value.reduce((sum, row) => sum + row.coralCount, 0),
  coverCmTotal: rows.value.reduce((sum, row) => sum + row.coverCmTotal, 0),
  fishTotal: rows.value.reduce((sum, row) => sum + row.fishTotal, 0),
  avgCoveragePct:
    rows.value.length === 0
      ? 0
      : Number((rows.value.reduce((sum, row) => sum + row.coveragePct, 0) / rows.value.length).toFixed(2)),
  avgBleachIndex:
    rows.value.length === 0
      ? 0
      : Number((rows.value.reduce((sum, row) => sum + row.bleachIndexValue, 0) / rows.value.length).toFixed(2)),
  bleachedBelts: rows.value.filter((row) => row.bleachedSharePct > 0).length,
  failedReefs: finalizedResults.value.filter((result) => result.status === '失败').length
}))

/** 当前筛选结果内的白化等级分布 */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = Number(rows.value.reduce((sum, row) => sum + row.distribution[level], 0).toFixed(1))
  })
  return result
})

const distributionTotal = computed(() =>
  BLEACH_LEVELS.reduce((sum, level) => sum + distribution.value[level], 0)
)

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

async function refresh(): Promise<void> {
  counts.value = (await countAll()) as CountMap
  lastBackupAt.value = readLastBackupAt()
  stampedVersion.value = readStampedDbVersion()
}

function handleFilterChange(): void {
  void router.replace({
    query: buildQuery({
      kw: surveyStore.filter.keyword,
      reef: surveyStore.filter.reefIds,
      level: surveyStore.filter.bleachLevels,
      bleached: surveyStore.filter.onlyBleached
    })
  })
}

function handleReset(): void {
  surveyStore.resetFilter()
  void router.replace({ query: {} })
}

async function handleExport(): Promise<void> {
  busy.value = true
  try {
    const result = await exportBackupJson()
    await refresh()
    notice.value = `已导出全量快照 ${result.fileName}（共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录，含普查各巡次原始数据与档案室定案）。`
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
  }
}

async function handleExportConclusions(): Promise<void> {
  if (effectiveYear.value === null || finalizedResults.value.length === 0) {
    ElMessage.warning(`${effectiveYear ?? '所选'} 年度还没有定案，暂无可导出的结论`)
    return
  }
  busy.value = true
  try {
    const { fileName } = await exportFinalizationJson(finalizedResults.value, effectiveYear.value)
    notice.value = `已按定案口径导出 ${effectiveYear.value} 年度结论 ${fileName}；对不上条目随文件单列，不参与评定。`
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
  }
}

async function handleImport(): Promise<void> {
  const file = fileList.value[0]?.raw
  if (!file) {
    ElMessage.warning('请先选择备份 JSON 文件')
    return
  }
  busy.value = true
  try {
    const text = await readFileText(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      ElMessage.error('文件不是合法的 JSON，无法解析')
      return
    }
    const validation = validateBackup(parsed)
    if (!validation.ok || !validation.payload) {
      ElMessage.error(`备份校验失败：${validation.errors.join('；')}`)
      return
    }
    const payload: BackupPayload = overwriteOnImport.value ? validation.payload : remapIds(validation.payload)
    const summary = Object.entries({
      reefs: payload.reefs.length,
      sites: payload.sites.length,
      visits: payload.visits.length,
      belts: payload.belts.length,
      corals: payload.corals.length,
      fishes: payload.fishes.length
    })
      .map(([key, value]) => `${key} ${value}`)
      .join('、')
    await ElMessageBox.confirm(
      `将导入 ${summary}；${overwriteOnImport.value ? '覆盖模式会先清空现有本地数据' : '追加模式会重新分配业务 id、复用巡次 code，不复制档案室定案'}。旧数据无巡次标记时会按调查日期归入季度巡次、补不出的单列。确认继续？`,
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importBackup(payload, overwriteOnImport.value)
    await refresh()
    notice.value = '导入完成，覆盖度汇总已刷新。'
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
    fileList.value = []
  }
}

async function handleDatabaseReset(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空全部本地数据并重新播种演示数据（含多个季度巡次、档案室年度定案与对账记录）。确认继续？',
      '重置本地数据',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  notice.value = '本地数据已重置为演示数据。'
  ElMessage.success(notice.value)
}

async function copySummary(): Promise<void> {
  const text = rows.value
    .map((row) => {
      const prefix = viewMode.value === 'finalized' ? `[${effectiveYear.value} 定案·${row.visitCode}]` : `[${row.visitCode}]`
      return `${prefix}${row.reefName}｜站位 ${row.siteNo}｜样带 ${row.beltNo}（${row.orientation}向 ${row.lengthM} m）：珊瑚覆盖率 ${row.coveragePct}%，白化指数 ${row.bleachIndexValue}（${row.grade}），白化占比 ${row.bleachedSharePct}%，鱼类 ${row.fishTotal} 尾（${row.fishDensityValue} 尾/100m²）`
    })
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    notice.value = viewMode.value === 'finalized' ? '定案结论已复制到剪贴板。' : '普查原始结论已复制到剪贴板。'
    ElMessage.success(notice.value)
  } catch {
    notice.value = '当前浏览器不允许读取剪贴板，请手动选中表格内容复制。'
    ElMessage.warning(notice.value)
  }
}

onMounted(() => {
  surveyStore.patchFilter({
    keyword: typeof route.query.kw === 'string' ? route.query.kw : '',
    reefIds: queryToArray(route.query.reef),
    bleachLevels: queryToArray(route.query.level) as BleachLevel[],
    onlyBleached: queryToBool(route.query.bleached)
  })
  void refresh()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">白化等级评定与覆盖度汇总</h2>
        <p class="gb-hint">
          普查组按巡次分开记每次重访（不混算）；档案室定下年度巡次后，礁区覆盖率、白化指数与导出结论按那次重出。
          对不上的巡次/样带单列，不参与评定与导出。
        </p>
      </div>
      <div class="page__actions">
        <el-radio-group v-model="viewMode">
          <el-radio-button value="finalized">档案室定案口径</el-radio-button>
          <el-radio-button value="raw">普查原始（分巡次）</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        <el-button @click="copySummary">复制结论</el-button>
        <el-button type="primary" :icon="Download" :loading="busy" @click="handleExport">导出全量 JSON</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <!-- 口径专属工具条 -->
    <el-card shadow="never" class="gb-panel scope-bar">
      <div v-if="viewMode === 'finalized'" class="scope-bar__row">
        <span class="scope-bar__label">定案年度：</span>
        <el-select :model-value="effectiveYear" placeholder="尚无定案" style="width: 150px" @update:model-value="(value: number) => (selectedYear = value)">
          <el-option v-for="year in archiveStore.finalizedYears" :key="year" :label="`${year} 年度`" :value="year" />
        </el-select>
        <span class="gb-hint">评定与导出均按各礁区该年定下的巡次重出；同编号取定案那次（不平均），缺号取后一次补位。</span>
        <el-button type="primary" plain size="small" :icon="Download" :loading="busy" @click="handleExportConclusions">
          导出 {{ effectiveYear }} 定案结论
        </el-button>
        <router-link class="scope-bar__link" to="/archive">前往档案室定案 / 重跑对账 →</router-link>
      </div>
      <div v-else class="scope-bar__row">
        <span class="scope-bar__label">普查巡次：</span>
        <el-select v-model="rawVisitId" placeholder="全部巡次（各次分开列示）" clearable style="width: 260px">
          <el-option
            v-for="visit in visitStore.sortedVisits"
            :key="visit.id"
            :label="`${visit.code}${visit.kind === '补登' ? '（补登单列）' : ''} · ${visit.startedOn || '—'}`"
            :value="visit.id"
          />
        </el-select>
        <span class="gb-hint">此处是普查组每次重访的原始记录，不随档案室定案改变；编号相同的样带按巡次各自成行。</span>
      </div>
    </el-card>

    <div class="gb-stats-row">
      <StatBadge label="样带数" :value="totals.belts" suffix="条" icon="Files" />
      <StatBadge label="珊瑚记录" :value="totals.coralCount" suffix="条" tone="info" icon="Histogram" />
      <StatBadge label="覆盖长度合计" :value="totals.coverCmTotal" suffix="cm" tone="success" icon="Odometer" />
      <StatBadge label="平均覆盖率" :value="totals.avgCoveragePct" suffix="%" :percent="Math.min(100, totals.avgCoveragePct)" icon="PieChart" />
      <StatBadge
        label="平均白化指数"
        :value="totals.avgBleachIndex"
        suffix="/ 4"
        :tone="totals.avgBleachIndex > 1 ? 'warning' : 'success'"
        :icon="totals.avgBleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
      />
      <StatBadge label="鱼类合计" :value="totals.fishTotal" suffix="尾" tone="warning" icon="TrendCharts" />
    </div>

    <el-alert
      v-if="viewMode === 'finalized' && totals.failedReefs > 0"
      type="warning"
      :closable="false"
      show-icon
      :title="`${effectiveYear} 年度有 ${totals.failedReefs} 个礁区对账失败，共 ${allMismatches.length} 条对不上（已单列，不参与评定与导出）；重跑只重算普查侧，定案不回退。`"
    />

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'reefIds',
          label: '礁区',
          options: reefStore.reefs.map((reef) => ({ label: reef.name, value: reef.id }))
        },
        {
          key: 'bleachLevels',
          label: '白化等级',
          options: BLEACH_LEVELS.map((level) => ({ label: level, value: level }))
        }
      ]"
      :has-switch="true"
      switch-label="仅看存在白化的样带"
      :switch-value="surveyStore.filter.onlyBleached"
      :keyword-placeholder="viewMode === 'finalized' ? '搜索礁区 / 站位 / 样带 / 巡次' : '搜索礁区 / 站位 / 样带 / 调查人 / 巡次'"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>白化等级分布（覆盖长度 cm）</h3>
        <span class="gb-hint">
          口径：{{ viewMode === 'finalized' ? `档案室 ${effectiveYear} 定案` : '普查原始（分巡次）' }} · 白化样带
          {{ totals.bleachedBelts }} 条
        </span>
      </div>
      <div class="gb-bars">
        <div v-for="level in BLEACH_LEVELS" :key="`dist-${level}`" class="gb-bar">
          <span>{{ level }}</span>
          <span class="gb-bar__track">
            <span
              class="gb-bar__fill"
              :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], distributionTotal) }"
            ></span>
          </span>
          <span class="gb-mono">{{ distribution[level] }} cm</span>
        </div>
      </div>
    </el-card>

    <!-- 定案口径：对不上条目单列 -->
    <el-card v-if="viewMode === 'finalized' && allMismatches.length > 0" shadow="never" class="gb-panel mismatch-panel">
      <div class="gb-panel-title">
        <h3>对账单列（{{ allMismatches.length }} 条，不参与评定与导出）</h3>
        <span class="gb-hint">两边按站位编号 + 样带编号对账；整巡次零交集 / 补登未归位 / 站位缺失 / 编号重复均在此单列</span>
      </div>
      <el-table :data="allMismatches" border stripe size="small" class="gb-table-compact">
        <el-table-column prop="kind" label="对不上类别" width="150">
          <template #default="{ row }">
            <el-tag size="small" type="warning">{{ row.kind }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="巡次 / 站位 / 样带" width="220">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.visitCode }} · {{ row.siteNo }} · {{ row.beltNo }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="260" />
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>
          {{ viewMode === 'finalized' ? `定案样带成果（${rows.length} 条）` : `普查原始样带（${rows.length} 条）` }}
        </h3>
        <span class="gb-hint">{{ viewMode === 'finalized' ? '已合并同编号定案覆盖与跨巡次补位，对不上的不入表' : '按巡次倒序、同巡次内按白化指数降序' }}</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        :title="viewMode === 'finalized' ? `${effectiveYear ?? '所选'} 年度还没有定案样带` : '没有符合条件的样带'"
        :description="
          viewMode === 'finalized'
            ? '可到档案室为各礁区选定年度定案巡次；定案后此处按那次重出覆盖率与白化指数。'
            : '请先布设样带并录入珊瑚分类覆盖与鱼类计数，或按巡次筛选。'
        "
        compact
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}（{{ row.orientation }}向）</div>
          </template>
        </el-table-column>
        <el-table-column label="巡次 / 来源" width="170">
          <template #default="{ row }">
            <el-tag size="small" :type="viewMode === 'finalized' && row.source === '跨巡次补位' ? 'warning' : 'success'">
              {{ row.visitCode }}
            </el-tag>
            <div v-if="viewMode === 'finalized'" class="gb-hint">{{ row.source }}</div>
          </template>
        </el-table-column>
        <el-table-column label="样带长度" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.lengthM }} m</span>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚记录" width="90" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coralCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="覆盖率" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.coverCmTotal }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="白化评定" width="170">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndexValue }} · 白化占比 {{ row.bleachedSharePct }}%</div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级分布 (cm)" min-width="200">
          <template #default="{ row }">
            <div class="page__mini-bars">
              <span
                v-for="level in BLEACH_LEVELS"
                :key="`${row.beltId}-${level}`"
                class="page__mini-bar"
                :style="{
                  background: BLEACH_COLOR[level],
                  width: barPercent(row.distribution[level], row.coverCmTotal),
                  opacity: row.distribution[level] > 0 ? 1 : 0.15
                }"
                :title="`${level}：${row.distribution[level]} cm`"
              ></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="鱼类" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }} 尾</span>
            <div class="gb-hint gb-mono">{{ row.fishDensityValue }} 尾/100m²</div>
          </template>
        </el-table-column>
        <el-table-column label="调查" min-width="140">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.surveyDate }}</div>
            <div class="gb-hint">{{ row.observer || '未填写调查人' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 定案口径：按礁区的年度评定 -->
    <el-card v-if="viewMode === 'finalized'" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按礁区的 {{ effectiveYear }} 年度定案评定</h3>
        <span class="gb-hint">平均白化指数为纳入评定样带的算术平均；仅含定案覆盖与跨巡次补位样带，对不上的不计入</span>
      </div>
      <EmptyPanel
        v-if="finalizedResults.length === 0"
        :title="`${effectiveYear ?? '所选'} 年度尚无礁区定案`"
        description="前往档案室为各礁区选定该年的年度定案巡次。"
        action-text="前往档案室"
        compact
        @action="router.push('/archive')"
      />
      <el-table v-else :data="finalizedResults" border stripe class="gb-table-compact">
        <el-table-column label="礁区" min-width="160">
          <template #default="{ row }">
            {{ reefStore.reefById(row.reefId)?.name ?? '未知礁区' }}
            <el-tag size="small" :type="row.status === '通过' ? 'success' : 'danger'">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="visitCode" label="定案巡次" width="110" />
        <el-table-column label="站位 / 样带" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.summary.siteCount }} / {{ row.summary.beltCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均覆盖率" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.summary.avgCoveragePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="平均白化指数" width="170">
          <template #default="{ row }">
            <BleachTag :level="row.summary.grade" size="small" />
            <span class="gb-hint gb-mono"> {{ row.summary.avgBleachIndex }}</span>
          </template>
        </el-table-column>
        <el-table-column label="白化占比" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.summary.bleachedSharePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="鱼类密度" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.summary.fishDensityValue }} 尾/100m²</span>
          </template>
        </el-table-column>
        <el-table-column label="对不上" width="100" align="right">
          <template #default="{ row }">
            <el-tag size="small" :type="row.mismatches.length > 0 ? 'warning' : 'success'">{{ row.mismatches.length }} 条</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>结构版本与全量 JSON 导入导出</h3>
        <span class="gb-hint">
          导出含 reefs / sites / visits / belts / corals / fishes / finalizations / reconciliations 八张表 · 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>

      <el-form label-width="120px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（先清空本地数据）</el-radio>
            <el-radio :value="false">追加（重新分配业务 id，复用巡次 code）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="选择备份文件">
          <el-upload
            v-model:file-list="fileList"
            :auto-upload="false"
            :limit="1"
            accept="application/json"
            :on-exceed="() => ElMessage.warning('一次只能选择一个文件')"
          >
            <el-button :icon="Upload">选择 JSON 文件</el-button>
            <template #tip>
              <div class="gb-hint">支持本应用 v2/v3 备份；旧数据无巡次标记时按调查日期归入季度巡次，补不出的样带单列进补登巡次。</div>
            </template>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="busy" @click="handleImport">开始导入</el-button>
          <el-button :icon="Download" @click="handleExport">导出当前数据</el-button>
          <el-button type="danger" plain @click="handleDatabaseReset">清空并重建演示数据</el-button>
        </el-form-item>
      </el-form>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="本地库名">{{ DB_NAME }}</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（浏览器记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="礁区 / 站位">{{ counts.reefs }} / {{ counts.sites }}</el-descriptions-item>
        <el-descriptions-item label="巡次 / 样带">{{ counts.visits }} / {{ counts.belts }}</el-descriptions-item>
        <el-descriptions-item label="珊瑚记录 / 鱼类">{{ counts.corals }} / {{ counts.fishes }}</el-descriptions-item>
        <el-descriptions-item label="定案 / 对账">{{ counts.finalizations }} / {{ counts.reconciliations }}</el-descriptions-item>
        <el-descriptions-item label="最近备份时间">
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </el-descriptions-item>
      </el-descriptions>
      <p class="gb-hint">
        数据仅保存在当前浏览器 IndexedDB 中，换浏览器或清空站点数据后不会自动跟随，请通过 JSON 备份迁移。
      </p>
    </el-card>
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

.scope-bar__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.scope-bar__label {
  font-size: 13px;
  font-weight: 600;
  color: #0b5d5a;
}

.scope-bar__link {
  font-size: 13px;
  color: #0b5d5a;
  text-decoration: none;
}

.scope-bar__link:hover {
  text-decoration: underline;
}

.mismatch-panel {
  border-color: #e0b07a;
}

.page__mini-bars {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: #eef7f6;
}

.page__mini-bar {
  display: block;
  height: 100%;
}
</style>
