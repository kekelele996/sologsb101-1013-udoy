<script setup lang="ts">
/**
 * 模块 6：/coverage 白化等级评定与覆盖度汇总
 * 评定口径与档案室 / 导出完全一致（utils/reconcile.ts）：
 * 默认看「档案室定案年度」——定案了按定案巡次重出，未定案取后一次巡访；
 * 也可切到「外业全部记录」查看普查组每次巡访的原始数据（仅查看，不回退任何定案）。
 * 另提供结构版本查看与七表全量 JSON 导入导出。复用 <BleachTag>、<FilterBar>。
 */
import { computed, onMounted, ref } from 'vue'
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
import { useCanonicalStore } from '@/stores/canonicalStore'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import { BLEACH_COLOR } from '@/utils/bleach'
import {
  CANONICAL_STATUS_LABEL,
  RESOLUTION_POLICY,
  type CanonicalLine
} from '@/utils/reconcile'
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
  buildBackupPayload,
  buildConclusionText,
  countPayload,
  downloadConclusionText,
  exportBackupJson,
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
const canonical = useCanonicalStore()

const EMPTY_COUNTS: CountMap = {
  reefs: 0,
  sites: 0,
  visits: 0,
  finalizations: 0,
  belts: 0,
  corals: 0,
  fishes: 0
}

const counts = ref<CountMap>(EMPTY_COUNTS)
const lastBackupAt = ref<string | null>(null)
const stampedVersion = ref<number>(DB_VERSION)
const overwriteOnImport = ref(true)
const fileList = ref<UploadFile[]>([])
const busy = ref(false)
const notice = ref('')
/** scope=archive 看档案室定案口径；scope=field 看外业每次巡访原始记录 */
const scope = ref<'archive' | 'field'>('archive')

/** 外业全部记录口径行（每次巡访各一行，不做任何取舍） */
const fieldRows = computed(() => surveyStore.coverageRows)

/** 档案室定案口径行（定案巡次 / 后一次） */
const archiveRows = computed<CanonicalLine[]>(() => canonical.lines)

const filterModel = computed<FilterModel>(() => ({
  keyword: surveyStore.filter.keyword,
  reefIds: surveyStore.filter.reefIds,
  bleachLevels: surveyStore.filter.bleachLevels
}))

/** 当前口径下的行（统一过一遍筛选） */
const rows = computed(() => {
  const source: Array<{
    beltId: string
    beltNo: string
    reefId: string
    reefName: string
    siteNo: string
    lengthM: number
    orientation: string
    surveyDate: string
    observer: string
    coralCount: number
    coverCmTotal: number
    coveragePct: number
    bleachIndex: number
    grade: BleachLevel
    bleachedSharePct: number
    distribution: Record<BleachLevel, number>
    fishTotal: number
    invertebrateTotal: number
    fishDensity: number
    statusText?: string
  }> =
    scope.value === 'archive'
      ? archiveRows.value.map((line) => ({ ...line, statusText: CANONICAL_STATUS_LABEL[line.status] }))
      : fieldRows.value.map((line) => ({ ...line, statusText: '' }))

  return source.filter((row) => {
    const keyword = surveyStore.filter.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
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
})

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
      : Number((rows.value.reduce((sum, row) => sum + row.bleachIndex, 0) / rows.value.length).toFixed(2)),
  bleachedBelts: rows.value.filter((row) => row.bleachedSharePct > 0).length
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
    notice.value = `已导出全量备份 ${result.fileName}（七张表共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录）。`
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
  }
}

/** 导出评定结论：始终用档案室定案年度的统一口径 */
async function handleExportConclusion(): Promise<void> {
  const payload = await buildBackupPayload()
  const text = buildConclusionText(payload, canonical.year, canonical.mismatches)
  const fileName = downloadConclusionText(text, canonical.year)
  notice.value = `已按${canonical.year}年度统一口径导出结论 ${fileName}。`
  ElMessage.success(notice.value)
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
    const summary = countPayload(payload)
    await ElMessageBox.confirm(
      `将导入 reefs/sites/visits/finalizations/belts/corals/fishes 共 ${Object.entries(summary)
        .map(([key, value]) => `${key} ${value}`)
        .join('、')} 条；${overwriteOnImport.value ? '覆盖模式会先清空现有本地数据' : '追加模式会重新分配 id 保留现有数据'}。确认继续？`,
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importBackup(payload, overwriteOnImport.value)
    await refresh()
    notice.value = '导入完成，覆盖度汇总已按定案口径刷新。'
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
    fileList.value = []
  }
}

async function handleDatabaseReset(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空全部本地数据并重新播种演示数据（含巡次与年度定案）。确认继续？',
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
    .map(
      (row) =>
        `${row.reefName}｜站位 ${row.siteNo}｜样带 ${row.beltNo}（${row.orientation}向 ${row.lengthM} m）：珊瑚覆盖率 ${row.coveragePct}%，白化指数 ${row.bleachIndex}（${row.grade}），白化占比 ${row.bleachedSharePct}%，鱼类 ${row.fishTotal} 尾（${row.fishDensity} 尾/100m²）${row.statusText ? `［${row.statusText}］` : ''}`
    )
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '覆盖度结论已复制到剪贴板。'
    ElMessage.success(notice.value)
  } catch {
    notice.value = '当前浏览器不允许读取剪贴板，请手动选中表格内容复制。'
    ElMessage.warning(notice.value)
  }
}

const reefSummaries = computed(() => canonical.reefSummaries)

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
          评定与档案室 / 导出同一口径：{{ RESOLUTION_POLICY.label }}。
        </p>
      </div>
      <div class="page__actions">
        <el-radio-group v-model="scope">
          <el-radio-button value="archive">档案室定案（{{ canonical.year }} 年度）</el-radio-button>
          <el-radio-button value="field">外业全部巡访记录</el-radio-button>
        </el-radio-group>
        <el-select
          :model-value="canonical.year"
          class="page__year-select"
          :disabled="scope !== 'archive'"
          @change="(v: number) => canonical.selectYear(Number(v))"
        >
          <el-option v-for="y in canonical.years.length ? canonical.years : [canonical.year]" :key="y" :label="`${y} 年`" :value="y" />
        </el-select>
        <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        <el-button @click="copySummary">复制结论</el-button>
        <el-button type="primary" :icon="Download" :loading="busy" @click="handleExportConclusion">导出结论</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <div class="gb-stats-row">
      <StatBadge label="口径样带数" :value="totals.belts" suffix="条" icon="Files" />
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
      keyword-placeholder="搜索礁区 / 站位 / 样带 / 调查人"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>白化等级分布（覆盖长度 cm）</h3>
        <span class="gb-hint">
          {{ scope === 'archive' ? `档案室定案口径 · ${canonical.year} 年度` : '外业每次巡访原始记录（不做取舍）' }}
          · 存在白化样带 {{ totals.bleachedBelts }} 条
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

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>{{ scope === 'archive' ? `定案口径覆盖度成果（${canonical.year} 年，${rows.length} 条）` : `外业全部巡访样带（${rows.length} 条）` }}</h3>
        <span class="gb-hint">按白化指数降序；定案了按定案巡次，未定案取后一次，绝不平均</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="没有符合条件的样带"
        description="请先登记巡访并布设样带、录入珊瑚与鱼类；档案室可在「礁区档案室」定案年度巡次。"
        compact
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}（{{ row.orientation }}向）</div>
          </template>
        </el-table-column>
        <el-table-column v-if="scope === 'archive'" label="口径 / 巡次" min-width="180">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.statusText && row.statusText.includes('不一致') ? 'warning' : row.statusText && row.statusText.includes('缺测') ? 'warning' : 'success'"
              effect="plain"
            >
              {{ row.statusText }}
            </el-tag>
            <div class="gb-hint">{{ row.surveyDate }} · {{ row.observer || '调查人未填' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="样带长度" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.lengthM }} m</span></template>
        </el-table-column>
        <el-table-column label="珊瑚记录" width="90" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.coralCount }}</span></template>
        </el-table-column>
        <el-table-column label="覆盖率" width="125" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.coverCmTotal }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="白化评定" width="165">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndex }} · 占比 {{ row.bleachedSharePct }}%</div>
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
            <div class="gb-hint gb-mono">{{ row.fishDensity }} 尾/100m²</div>
          </template>
        </el-table-column>
        <el-table-column label="无脊椎动物" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.invertebrateTotal }} 个</span></template>
        </el-table-column>
        <el-table-column v-if="scope === 'field'" label="调查" min-width="140">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.surveyDate }}</div>
            <div class="gb-hint">{{ row.observer || '未填写调查人' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="scope === 'archive'" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按礁区的年度评定（{{ canonical.year }} 年）</h3>
        <span class="gb-hint">定案后覆盖率 / 白化指数按定案巡次重出；未定案取后一次巡访</span>
      </div>
      <el-table :data="reefSummaries" border stripe class="gb-table-compact">
        <el-table-column prop="reefName" label="礁区" min-width="150" />
        <el-table-column label="定案巡次" min-width="180">
          <template #default="{ row }">
            <el-tag v-if="row.finalizedVisitId" type="success" size="small">{{ row.finalizedVisitName }}</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">未定案 · 取后一次</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="站位 / 样带" width="110" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.siteCount }} / {{ row.beltCount }}</span></template>
        </el-table-column>
        <el-table-column label="平均覆盖率" width="110" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.avgCoveragePct }}%</span></template>
        </el-table-column>
        <el-table-column label="平均白化" width="170">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <span class="gb-hint gb-mono"> {{ row.avgBleachIndex }} · 占比 {{ row.bleachedSharePct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="差异" width="80" align="center">
          <template #default="{ row }">
            <el-badge v-if="row.mismatchCount > 0" :value="row.mismatchCount" type="warning" />
            <span v-else class="gb-hint">无</span>
          </template>
        </el-table-column>
        <el-table-column label="鱼类" width="90" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.fishTotal }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>结构版本与全量 JSON 导入导出</h3>
        <span class="gb-hint">
          导出包含 reefs / sites / visits / finalizations / belts / corals / fishes 七张表 · 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>

      <el-form label-width="120px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（先清空本地数据）</el-radio>
            <el-radio :value="false">追加（重新分配 id）</el-radio>
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
              <div class="gb-hint">仅支持本应用导出的备份文件（app 字段为 gbcoralbelt）</div>
            </template>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="busy" @click="handleImport">开始导入</el-button>
          <el-button :icon="Download" @click="handleExport">导出全量备份</el-button>
          <el-button type="danger" plain @click="handleDatabaseReset">清空并重建演示数据</el-button>
        </el-form-item>
      </el-form>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="本地库名">{{ DB_NAME }}</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（浏览器记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="礁区 / 站位">{{ counts.reefs }} / {{ counts.sites }}</el-descriptions-item>
        <el-descriptions-item label="巡次 / 定案">{{ counts.visits }} / {{ counts.finalizations }}</el-descriptions-item>
        <el-descriptions-item label="样带 / 珊瑚记录">{{ counts.belts }} / {{ counts.corals }}</el-descriptions-item>
        <el-descriptions-item label="鱼类计数">{{ counts.fishes }}</el-descriptions-item>
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
  align-items: center;
  gap: 8px;
}

.page__year-select {
  width: 110px;
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
