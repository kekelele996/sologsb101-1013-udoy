# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，逐条记录底质、珊瑚分类覆盖与鱼类计数，并评定白化等级。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 职责 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | 礁区与站位（档案室主管基本信息） | 新建/编辑/删除礁区，卡片汇总站位数、样带数与本礁区定案年度平均白化指数 |
| `/field/visits` | **外业普查组 · 巡次登记** | 记每次季度巡访 | 按礁区登记年度/季度巡次，回显该次样带数、覆盖率、白化指数；同礁区同年同季不可重复；底部单列补不出巡次的旧样带并可人工补挂 |
| `/archive` | **礁区档案室 · 年度定案与对账** | 管礁区年度定案巡次 | 每礁区每年选定一条外业巡次定案 / 改选 / 撤销；定案后覆盖率、白化指数、导出结论按那次重出；按站位编号+样带编号对账，对不上的巡次与补不出的样带单列；导出年度结论 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验并显示度分秒，按水深筛选，白化指数取定案口径 |
| `/sites/:id/belts?visit=` | 样带布设 | 外业按巡次布样带 | 顶部切换巡次，样带挂在所选巡次上；同一次巡访内同朝向编号不可重复，重访同编号样带在另一巡次里另算 |
| `/belts/:id/corals` | 底质与珊瑚分类计数 | CoralRecord、Belt | 按属名与形态逐条录入覆盖长度与白化等级，页头标注所属巡次 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量并折算密度，页头标注所属巡次 |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 「档案室定案年度」（定案按定案/未定案取后一次）与「外业全部巡访原始记录」两种视图、按礁区年度汇总、结构版本、七表 JSON 导入导出、按统一口径导出结论 |

### 巡次与评定口径（两侧分开管）

- **外业普查组**：在 `/field/visits` 登记每一次季度巡访；样带（Belt）带 `visitId`，同一站位季度重访时同编号样带在不同巡次里各是一条，覆盖率、白化指数、鱼类密度按巡次分开，绝不把几次混算；普查组原始记录始终保留。
- **礁区档案室**：在 `/archive` 维护每个礁区每个年度的「定案巡次」（`finalizations`），只能从外业已登记的巡次里选。
- **统一口径**：定案巡次定下后，礁区覆盖率、白化指数、白化定级、礁区汇总与导出结论一律按那次重出（`src/utils/reconcile.ts`）；**同一站位编号+样带编号在多次巡访对不上时取后一次（调查日期最晚）覆盖，不取平均**；定案巡次缺测的编号以后一次补齐。评定与导出共用同一个口径函数。
- **对账**：按站位编号 + 样带编号比对，`finalized-divergent`（定案与其他巡访不一致）/ `gap-filled`（定案缺测补齐）/ `latest-wins`（未定案多次取后一次）单列在档案室页；对账失败只重跑普查组这侧，档案室定的巡次不回退（删巡次也不删定案，只标记巡次缺失）。
- **旧数据升级**：v3 迁移把没有巡次标记的样带按 `surveyDate` 的年份+季度自动归入补录巡次；调查日期缺失/非法补不出的样带 `visitId=null`，在两处单列并支持人工补挂。

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航（含外业巡次、礁区档案室）+ 上下文入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / visit / finalization / belt / coralRecord / fishCount / filter
        ├── stores/             # reefStore / beltStore / surveyStore / visitStore / archiveStore / canonicalStore
        ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage
        ├── pages/              # ReefList / FieldVisitBoard / ArchiveRoom / SiteList / BeltBoard / CoralEntry / FishEntry / CoverageView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化与覆盖度算法）/ reconcile.ts（巡次对账与统一评定口径）/ db.ts（Dexie 封装）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
# 巡次对账与评定口径的纯逻辑断言（esbuild 打包后 node 运行）
node_modules/.bin/esbuild scripts/test-reconcile.mjs --bundle --platform=node --format=esm --outfile=scripts/.t.mjs && node scripts/.t.mjs
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`reefs`（礁区）、`sites`（站位）、`visits`（外业普查组巡次）、`finalizations`（档案室年度定案）、`belts`（样带，含 `visitId`）、`corals`（珊瑚记录）、`fishes`（鱼类与无脊椎动物计数）。
- **升级迁移**：`version(2)` 补齐索引与必填字段；`version(3)` 新增 `visits` / `finalizations` 两表并给 `belts` 加 `visitId` 索引——旧样带按调查日期的年份+季度自动归入补录巡次，日期缺失/非法补不出的留 `visitId=null` 单列。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时幂等播种，演示数据覆盖「定案一致 / 定案与其他巡访分歧 / 未定案取后一次 / 补不出巡次」四种对账情况及全部白化等级。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新，页面只读消费。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4）；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²）。跨巡访的取舍统一见 `utils/reconcile.ts`（定案优先，否则取后一次，不平均）。
- **备份与恢复**：`/coverage` 页可导出包含七张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，含巡次/定案引用重映射）」；另可按年度统一口径导出 `.txt` 评定结论。备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
