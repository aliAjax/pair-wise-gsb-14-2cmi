<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watchEffect } from "vue";

type PriceCell = {
  station: string;
  fuel: string;
  listPrice: number; // 挂牌价
  cost: number; // 成本
  minMargin: number; // 保底毛利
};

type Observation = {
  id: string;
  station: string; // 本站
  fuel: string; // 油品
  rival: string; // 对方站
  rivalPrice: number; // 对方挂牌价
  distance: number; // 距离（公里）
  collector: string; // 采集人
  observedAt: string; // 采集时间
};

type PublishRecord = {
  id: string;
  station: string;
  fuel: string;
  oldPrice: number; // 原价（保留）
  newPrice: number;
  floor: number; // 发布时的底线
  breachedFloor: boolean;
  approver: string; // 审批人
  basis: string; // 依据（保留）
  collectors: string[]; // 确认低价的采集人
  publishedAt: string;
};

type Suggestion = {
  key: string;
  station: string;
  fuel: string;
  currentPrice: number;
  suggestedPrice: number;
  floor: number;
  breached: boolean; // 是否触发底线
  collectors: string[];
  confirmations: Observation[];
};

type PendingConfirm = {
  key: string;
  station: string;
  fuel: string;
  collector: string;
  lowest: number;
};

type Persisted = {
  board: PriceCell[];
  observations: Observation[];
  published: PublishRecord[];
};

const STORAGE_KEY = "dfwlfront-9-bijia-v1";
const MAX_AGE_HOURS = 24; // 超过24小时进无效区
const MAX_DISTANCE_KM = 3; // 超过3公里进无效区

const stations = ["城东加油站", "城西加油站", "港区加油站"];
const fuels = ["92号汽油", "95号汽油", "98号汽油", "柴油"];
const collectorPool = ["王敏", "李强", "赵磊"];

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function seedBoard(): PriceCell[] {
  return [
    { station: "城东加油站", fuel: "92号汽油", listPrice: 7.62, cost: 6.95, minMargin: 0.3 },
    { station: "城东加油站", fuel: "95号汽油", listPrice: 8.28, cost: 7.55, minMargin: 0.3 },
    { station: "城东加油站", fuel: "98号汽油", listPrice: 8.96, cost: 8.2, minMargin: 0.35 },
    { station: "城东加油站", fuel: "柴油", listPrice: 7.18, cost: 6.6, minMargin: 0.25 },
    { station: "城西加油站", fuel: "92号汽油", listPrice: 7.58, cost: 6.95, minMargin: 0.3 },
    { station: "城西加油站", fuel: "95号汽油", listPrice: 8.15, cost: 7.6, minMargin: 0.3 },
    { station: "城西加油站", fuel: "98号汽油", listPrice: 8.88, cost: 8.2, minMargin: 0.35 },
    { station: "城西加油站", fuel: "柴油", listPrice: 7.22, cost: 6.6, minMargin: 0.25 },
    { station: "港区加油站", fuel: "92号汽油", listPrice: 7.19, cost: 6.9, minMargin: 0.3 },
    { station: "港区加油站", fuel: "95号汽油", listPrice: 8.12, cost: 7.55, minMargin: 0.3 },
    { station: "港区加油站", fuel: "98号汽油", listPrice: 8.85, cost: 8.2, minMargin: 0.35 },
    { station: "港区加油站", fuel: "柴油", listPrice: 7.18, cost: 6.58, minMargin: 0.25 }
  ];
}

function seedObservations(): Observation[] {
  return [
    { id: "seed-obs-1", station: "城东加油站", fuel: "92号汽油", rival: "中石化解放路站", rivalPrice: 7.45, distance: 1.2, collector: "王敏", observedAt: hoursAgo(2) },
    { id: "seed-obs-2", station: "城东加油站", fuel: "92号汽油", rival: "中石油黄河路站", rivalPrice: 7.41, distance: 2.6, collector: "李强", observedAt: hoursAgo(5) },
    { id: "seed-obs-3", station: "城西加油站", fuel: "95号汽油", rival: "壳牌大学城站", rivalPrice: 7.79, distance: 1.8, collector: "王敏", observedAt: hoursAgo(3) },
    { id: "seed-obs-4", station: "城西加油站", fuel: "95号汽油", rival: "中海油经开区站", rivalPrice: 7.75, distance: 2.9, collector: "赵磊", observedAt: hoursAgo(1) },
    { id: "seed-obs-5", station: "城东加油站", fuel: "95号汽油", rival: "中石油黄河路站", rivalPrice: 8.05, distance: 0.8, collector: "李强", observedAt: hoursAgo(4) },
    { id: "seed-obs-6", station: "港区加油站", fuel: "柴油", rival: "顺通物流园站", rivalPrice: 7.05, distance: 4.5, collector: "李强", observedAt: hoursAgo(6) },
    { id: "seed-obs-7", station: "港区加油站", fuel: "柴油", rival: "港口石化站", rivalPrice: 7.02, distance: 1.1, collector: "王敏", observedAt: hoursAgo(26) },
    { id: "seed-obs-8", station: "港区加油站", fuel: "柴油", rival: "港区联营站", rivalPrice: 7.3, distance: 5.2, collector: "赵磊", observedAt: hoursAgo(30) }
  ];
}

function seedPublished(): PublishRecord[] {
  return [
    {
      id: "seed-pub-1",
      station: "港区加油站",
      fuel: "92号汽油",
      oldPrice: 7.55,
      newPrice: 7.19,
      floor: 7.2,
      breachedFloor: true,
      approver: "陈岚（区域经理）",
      basis: "高速口两家竞品新开业集中促销，区域公司批复限时跟价一周（批复单 HW-2026-0918），到期后回调至底线以上。",
      collectors: ["王敏", "李强"],
      publishedAt: hoursAgo(50)
    }
  ];
}

function loadState(): Persisted | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

const saved = loadState();
const board = ref<PriceCell[]>(saved?.board ?? seedBoard());
const observations = ref<Observation[]>(saved?.observations ?? seedObservations());
const published = ref<PublishRecord[]>(saved?.published ?? seedPublished());

// 让“超过24小时”随时间自动生效，无需刷新页面
const now = ref(Date.now());
const timer = window.setInterval(() => {
  now.value = Date.now();
}, 30_000);
onUnmounted(() => window.clearInterval(timer));

function persist() {
  const state: Persisted = {
    board: board.value,
    observations: observations.value,
    published: published.value
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function cellOf(station: string, fuel: string) {
  return board.value.find((cell) => cell.station === station && cell.fuel === fuel);
}

// 底线 = 成本 + 保底毛利
function floorOf(cell: PriceCell) {
  return round2(cell.cost + cell.minMargin);
}

function isLow(obs: Observation) {
  const cell = cellOf(obs.station, obs.fuel);
  return !!cell && obs.rivalPrice < cell.listPrice;
}

// 无效原因：超过24小时 或 距离超过3公里
function invalidReasons(obs: Observation): string[] {
  const reasons: string[] = [];
  if (now.value - new Date(obs.observedAt).getTime() > MAX_AGE_HOURS * 3600_000) {
    reasons.push(`采集时间超过${MAX_AGE_HOURS}小时`);
  }
  if (obs.distance > MAX_DISTANCE_KM) {
    reasons.push(`距离超过${MAX_DISTANCE_KM}公里`);
  }
  return reasons;
}

const validObservations = computed(() =>
  observations.value
    .filter((obs) => invalidReasons(obs).length === 0)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
);

const invalidObservations = computed(() =>
  observations.value
    .map((obs) => ({ obs, reason: invalidReasons(obs).join("；") }))
    .filter((item) => item.reason !== "")
    .sort((a, b) => b.obs.observedAt.localeCompare(a.obs.observedAt))
);

// 有效观察中“低于本站挂牌价”的记录，按 本站+油品 分组
const lowGroups = computed(() => {
  const groups = new Map<string, Observation[]>();
  for (const obs of validObservations.value) {
    if (!isLow(obs)) continue;
    const key = `${obs.station}|${obs.fuel}`;
    const list = groups.get(key);
    if (list) list.push(obs);
    else groups.set(key, [obs]);
  }
  return groups;
});

// 两条不同采集人确认的低价才生成向下建议
const suggestions = computed<Suggestion[]>(() => {
  const result: Suggestion[] = [];
  for (const [key, lows] of lowGroups.value) {
    const collectors = [...new Set(lows.map((obs) => obs.collector))];
    if (collectors.length < 2) continue;
    const [station, fuel] = key.split("|");
    const cell = cellOf(station, fuel);
    if (!cell) continue;
    const floor = floorOf(cell);
    const suggestedPrice = Math.min(...lows.map((obs) => obs.rivalPrice));
    result.push({
      key,
      station,
      fuel,
      currentPrice: cell.listPrice,
      suggestedPrice,
      floor,
      breached: suggestedPrice < floor,
      collectors,
      confirmations: [...lows].sort((a, b) => a.rivalPrice - b.rivalPrice)
    });
  }
  return result.sort((a, b) => Number(b.breached) - Number(a.breached));
});

// 只有一名采集人报了低价，待第二人确认
const pendingConfirmations = computed<PendingConfirm[]>(() => {
  const result: PendingConfirm[] = [];
  for (const [key, lows] of lowGroups.value) {
    const collectors = [...new Set(lows.map((obs) => obs.collector))];
    if (collectors.length !== 1) continue;
    const [station, fuel] = key.split("|");
    result.push({
      key,
      station,
      fuel,
      collector: collectors[0],
      lowest: Math.min(...lows.map((obs) => obs.rivalPrice))
    });
  }
  return result;
});

const metrics = computed(() => [
  { label: "有效观察", value: validObservations.value.length },
  { label: "无效观察", value: invalidObservations.value.length },
  { label: "待审批建议", value: suggestions.value.filter((s) => s.breached).length },
  { label: "已发布调价", value: published.value.length }
]);

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const form = reactive({
  station: stations[0],
  fuel: fuels[0],
  rival: "",
  rivalPrice: "" as string | number,
  distance: "" as string | number,
  collector: "",
  observedAt: toLocalInputValue(new Date())
});

function submitObservation() {
  observations.value = [
    {
      id: crypto.randomUUID(),
      station: form.station,
      fuel: form.fuel,
      rival: form.rival.trim(),
      rivalPrice: round2(Number(form.rivalPrice)),
      distance: Number(form.distance),
      collector: form.collector.trim(),
      observedAt: new Date(form.observedAt).toISOString()
    },
    ...observations.value
  ];
  form.rival = "";
  form.rivalPrice = "";
  form.distance = "";
  form.observedAt = toLocalInputValue(new Date());
  persist();
}

function removeObservation(id: string) {
  observations.value = observations.value.filter((obs) => obs.id !== id);
  persist();
}

// 触发底线的建议停在待审批区，审批人写明依据后才能发布
const approvals = reactive<Record<string, { approver: string; basis: string }>>({});
watchEffect(() => {
  for (const s of suggestions.value) {
    if (!approvals[s.key]) approvals[s.key] = { approver: "", basis: "" };
  }
});

function publish(s: Suggestion) {
  const cell = cellOf(s.station, s.fuel);
  if (!cell) return;
  let approver = "调度直发";
  let basis = `采集人${s.collectors.join("、")}双人确认周边低价，建议价未触底线（底线 ${s.floor.toFixed(2)} 元），按规则直接发布。`;
  if (s.breached) {
    const approval = approvals[s.key];
    approver = approval?.approver.trim() ?? "";
    basis = approval?.basis.trim() ?? "";
    if (!approver || !basis) return;
  }
  published.value = [
    {
      id: crypto.randomUUID(),
      station: s.station,
      fuel: s.fuel,
      oldPrice: cell.listPrice,
      newPrice: s.suggestedPrice,
      floor: s.floor,
      breachedFloor: s.breached,
      approver,
      basis,
      collectors: s.collectors,
      publishedAt: new Date().toISOString()
    },
    ...published.value
  ];
  cell.listPrice = s.suggestedPrice; // 发布即替换挂牌价
  delete approvals[s.key];
  persist();
}

function resetAll() {
  if (!window.confirm("将清空全部观察、建议与发布记录并恢复演示数据，确定吗？")) return;
  board.value = seedBoard();
  observations.value = seedObservations();
  published.value = seedPublished();
  persist();
}

function fmtPrice(value: number) {
  return value.toFixed(2);
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ageText(iso: string) {
  const ms = now.value - new Date(iso).getTime();
  if (ms < 0) return "刚刚";
  const hours = ms / 3600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}分钟前`;
  return `${hours.toFixed(1)}小时前`;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 区域调度</p>
          <h1>比价建议台</h1>
          <p class="subtitle">
            登记周边油站价格观察，超过24小时或3公里的记录自动进入无效区并标注原因；两名不同采集人确认低价后生成向下调价建议，跌破“成本+保底毛利”底线的建议停在待审批区，审批人写明依据后才能发布并替换挂牌价，原价与依据保留可查。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Vite</span>
          <span class="tag">TypeScript</span>
          <button class="secondary" type="button" @click="resetAll">重置演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submitObservation">
          <h2>观察登记</h2>
          <div class="form-grid">
            <label>
              本站
              <select v-model="form.station" required>
                <option v-for="station in stations" :key="station">{{ station }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.fuel" required>
                <option v-for="fuel in fuels" :key="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              对方站
              <input v-model="form.rival" placeholder="如：中石化解放路站" required />
            </label>
            <label>
              对方挂牌价（元/升）
              <input v-model.number="form.rivalPrice" type="number" step="0.01" min="0.01" placeholder="0.00" required />
            </label>
            <label>
              距离（公里）
              <input v-model.number="form.distance" type="number" step="0.1" min="0" placeholder="0.0" required />
            </label>
            <label>
              采集人
              <input v-model="form.collector" list="collector-pool" placeholder="采集人姓名" required />
              <datalist id="collector-pool">
                <option v-for="name in collectorPool" :key="name" :value="name" />
              </datalist>
            </label>
            <label>
              采集时间
              <input v-model="form.observedAt" type="datetime-local" required />
            </label>
            <button type="submit">登记观察</button>
            <p class="hint">超过{{ MAX_AGE_HOURS }}小时或距离超过{{ MAX_DISTANCE_KM}}公里的观察将自动进入无效区并标注原因。</p>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>调价建议</h2>
            <span class="hint">两条不同采集人确认的低价才生成向下建议</span>
          </div>
          <div class="record-grid">
            <div v-if="suggestions.length === 0 && pendingConfirmations.length === 0" class="empty">
              暂无调价建议：等待两名不同采集人确认同一本站油品的低价
            </div>

            <article v-for="s in suggestions" :key="s.key" class="record" :class="{ breached: s.breached }">
              <div class="record-head">
                <p class="record-title">{{ s.station }} · {{ s.fuel }}</p>
                <span class="status" :class="s.breached ? 'warn' : 'ok'">
                  {{ s.breached ? "待审批（触发底线）" : "可发布" }}
                </span>
              </div>
              <div class="price-line">
                <span>挂牌价 {{ fmtPrice(s.currentPrice) }}</span>
                <span class="arrow">→</span>
                <strong>建议价 {{ fmtPrice(s.suggestedPrice) }} 元</strong>
                <span class="floor" :class="{ hit: s.breached }">
                  底线 {{ fmtPrice(s.floor) }}（成本+保底毛利）{{ s.breached ? "，已跌破" : "" }}
                </span>
              </div>
              <ul class="confirms">
                <li v-for="c in s.confirmations" :key="c.id">
                  {{ c.collector }}：{{ c.rival }} {{ fmtPrice(c.rivalPrice) }} 元 · {{ c.distance }} 公里 · {{ ageText(c.observedAt) }}
                </li>
              </ul>
              <div v-if="s.breached" class="approval">
                <label>
                  审批人
                  <input v-model="approvals[s.key].approver" placeholder="审批人姓名" />
                </label>
                <label>
                  审批依据（写明后方可发布）
                  <textarea v-model="approvals[s.key].basis" placeholder="写明跌破底线的依据，如公司批复、市场竞争情况等" />
                </label>
              </div>
              <div class="actions">
                <button
                  type="button"
                  :disabled="s.breached && (!approvals[s.key]?.approver?.trim() || !approvals[s.key]?.basis?.trim())"
                  @click="publish(s)"
                >
                  {{ s.breached ? "审批通过并发布" : "发布并替换挂牌价" }}
                </button>
              </div>
            </article>

            <div v-for="p in pendingConfirmations" :key="p.key" class="pending-hint">
              {{ p.station }} · {{ p.fuel }}：{{ p.collector }} 已报低价 {{ fmtPrice(p.lowest) }} 元，待另一名采集人确认后生成建议
            </div>
          </div>
        </section>
      </section>

      <section class="dual">
        <section class="list-panel">
          <div class="toolbar">
            <h2>有效观察</h2>
            <span class="hint">{{ MAX_AGE_HOURS }}小时内且{{ MAX_DISTANCE_KM }}公里内</span>
          </div>
          <div class="record-grid">
            <div v-if="validObservations.length === 0" class="empty">暂无有效观察</div>
            <article v-for="obs in validObservations" :key="obs.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ obs.station }} · {{ obs.fuel }}</p>
                <span class="status ok">有效</span>
                <span v-if="isLow(obs)" class="status warn">低于本站</span>
              </div>
              <div class="details">
                <span>对方站: {{ obs.rival }}</span>
                <span>对方挂牌价: {{ fmtPrice(obs.rivalPrice) }} 元</span>
                <span>距离: {{ obs.distance }} 公里</span>
                <span>采集人: {{ obs.collector }}</span>
                <span>采集时间: {{ fmtTime(obs.observedAt) }}（{{ ageText(obs.observedAt) }}）</span>
                <span>本站挂牌价: {{ fmtPrice(cellOf(obs.station, obs.fuel)?.listPrice ?? 0) }} 元</span>
              </div>
              <div class="actions">
                <button class="danger" type="button" @click="removeObservation(obs.id)">删除</button>
              </div>
            </article>
          </div>
        </section>

        <section class="list-panel">
          <div class="toolbar">
            <h2>无效区</h2>
            <span class="hint">不参与比价建议</span>
          </div>
          <div class="record-grid">
            <div v-if="invalidObservations.length === 0" class="empty">暂无无效记录</div>
            <article v-for="item in invalidObservations" :key="item.obs.id" class="record invalid">
              <div class="record-head">
                <p class="record-title">{{ item.obs.station }} · {{ item.obs.fuel }}</p>
                <span class="status bad">无效</span>
              </div>
              <div class="details">
                <span>对方站: {{ item.obs.rival }}</span>
                <span>对方挂牌价: {{ fmtPrice(item.obs.rivalPrice) }} 元</span>
                <span>距离: {{ item.obs.distance }} 公里</span>
                <span>采集人: {{ item.obs.collector }}</span>
                <span>采集时间: {{ fmtTime(item.obs.observedAt) }}（{{ ageText(item.obs.observedAt) }}）</span>
              </div>
              <p class="reason">无效原因：{{ item.reason }}</p>
              <div class="actions">
                <button class="danger" type="button" @click="removeObservation(item.obs.id)">删除</button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <section class="list-panel board-panel">
        <div class="toolbar">
          <h2>本站挂牌价与底线</h2>
          <span class="hint">底线 = 成本 + 保底毛利，发布建议后挂牌价自动替换</span>
        </div>
        <table class="board">
          <thead>
            <tr>
              <th>本站</th>
              <th>油品</th>
              <th>挂牌价（元/升）</th>
              <th>成本</th>
              <th>保底毛利</th>
              <th>底线</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cell in board" :key="cell.station + cell.fuel">
              <td>{{ cell.station }}</td>
              <td>{{ cell.fuel }}</td>
              <td><strong>{{ fmtPrice(cell.listPrice) }}</strong></td>
              <td>{{ fmtPrice(cell.cost) }}</td>
              <td>{{ fmtPrice(cell.minMargin) }}</td>
              <td>{{ fmtPrice(floorOf(cell)) }}</td>
              <td>
                <span v-if="cell.listPrice < floorOf(cell)" class="status warn">破底（经审批）</span>
                <span v-else class="status ok">正常</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="list-panel published-panel">
        <div class="toolbar">
          <h2>已发布调价记录</h2>
          <span class="hint">原价与依据保留可查</span>
        </div>
        <div class="record-grid">
          <div v-if="published.length === 0" class="empty">暂无发布记录</div>
          <article v-for="r in published" :key="r.id" class="record">
            <div class="record-head">
              <p class="record-title">{{ r.station }} · {{ r.fuel }}</p>
              <span class="status done">已发布</span>
            </div>
            <div class="price-line">
              <span class="old-price">原价 {{ fmtPrice(r.oldPrice) }}</span>
              <span class="arrow">→</span>
              <strong>{{ fmtPrice(r.newPrice) }} 元</strong>
              <span class="floor" :class="{ hit: r.breachedFloor }">
                底线 {{ fmtPrice(r.floor) }}{{ r.breachedFloor ? "（破底发布）" : "" }}
              </span>
            </div>
            <div class="details">
              <span>审批人: {{ r.approver }}</span>
              <span>确认采集人: {{ r.collectors.join("、") }}</span>
              <span>发布时间: {{ fmtDateTime(r.publishedAt) }}</span>
            </div>
            <p class="note">依据：{{ r.basis }}</p>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>
