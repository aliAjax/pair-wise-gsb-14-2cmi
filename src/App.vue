<script setup lang="ts">
import { computed, reactive, ref } from "vue";

/* ============================== 领域常量 ============================== */

const STORAGE_KEY = "dfwlfront-9-comparison-v2";
const STORE_VERSION = 2;
const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;
type Fuel = (typeof FUELS)[number];

/** 有效观察窗口：超过 24 小时视为过期 */
const MAX_AGE_HOURS = 24;
/** 有效采集半径：超过 3 公里视为远距离站 */
const MAX_DISTANCE_KM = 3;

type StationKind = "own" | "rival";
type Station = {
  id: string;
  name: string;
  kind: StationKind;
  area: string;
};

type PriceEntry = {
  stationId: string;
  fuel: Fuel;
  /** 当前挂牌价：只允许由已发布建议替换 */
  listPrice: number;
  /** 进货成本（元/升） */
  cost: number;
  /** 保底毛利（元/升） */
  floorMargin: number;
};

type Observation = {
  id: string;
  ownStationId: string;
  fuel: Fuel;
  rivalStation: string;
  rivalPrice: number;
  distance: number;
  collector: string;
  observedAt: string;
  createdAt: string;
  /** 录入时判定的无效原因快照；空串表示录入时有效 */
  invalidSnapshot: string;
  /** 已被哪条建议引用（作为确认依据） */
  suggestionId: string | null;
};

type SuggestionStatus = "pending" | "approval" | "published" | "rejected";

type Suggestion = {
  id: string;
  ownStationId: string;
  fuel: Fuel;
  /** 生成建议时的挂牌价（原价快照） */
  currentPrice: number;
  /** 两条观察确认的最低价 */
  confirmedLow: number;
  /** 成本 + 保底毛利 */
  floorPrice: number;
  /** 实际建议价：未触底线取确认低价，触底线停在底线价 */
  proposedPrice: number;
  hitsFloor: boolean;
  status: SuggestionStatus;
  observationIds: [string, string];
  createdAt: string;
  decidedAt: string | null;
  approver: string;
  basis: string;
  /** 发布时保留的原价 */
  previousPrice: number | null;
  publishedPrice: number | null;
};

type Store = {
  version: number;
  stations: Station[];
  prices: PriceEntry[];
  observations: Observation[];
  suggestions: Suggestion[];
};

/* ============================== 演示种子 ============================== */

function seedStations(): Station[] {
  return [
    { id: "own-1", name: "城东加油站（本站）", kind: "own", area: "城东片区" },
    { id: "own-2", name: "城南加油站（本站）", kind: "own", area: "城南片区" },
    { id: "rival-1", name: "中石化一站", kind: "rival", area: "北环路 1.2km" },
    { id: "rival-2", name: "中石油东站", kind: "rival", area: "东三环 1.8km" },
    { id: "rival-3", name: "中海油南站", kind: "rival", area: "南站枢纽 2.4km" },
    { id: "rival-4", name: "壳牌北环站", kind: "rival", area: "北环立交 4.2km" }
  ];
}

function seedPrices(): PriceEntry[] {
  const defs: Array<[string, Fuel, number, number, number]> = [
    ["own-1", "92号汽油", 7.62, 6.9, 0.35],
    ["own-1", "95号汽油", 8.18, 7.35, 0.4],
    ["own-1", "98号汽油", 9.06, 8.2, 0.45],
    ["own-1", "柴油", 7.18, 6.55, 0.3],
    ["own-2", "92号汽油", 7.58, 6.88, 0.35],
    ["own-2", "95号汽油", 8.12, 7.32, 0.4],
    ["own-2", "98号汽油", 9.02, 8.18, 0.45],
    ["own-2", "柴油", 7.15, 6.52, 0.3]
  ];
  return defs.map(([stationId, fuel, listPrice, cost, floorMargin]) => ({
    stationId,
    fuel,
    listPrice,
    cost,
    floorMargin
  }));
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function seedObservations(): Observation[] {
  const rows: Array<[string, Fuel, string, number, number, string, number]> = [
    // own-1 / 92：两名不同采集人都采到低于挂牌价的价格 -> 可直接发布的向下建议
    ["own-1", "92号汽油", "中石化一站", 7.31, 1.2, "王磊", 3],
    ["own-1", "92号汽油", "中石油东站", 7.29, 1.8, "李娜", 2],
    // own-1 / 95：确认低价 7.72 跌破底线 7.75 -> 停在待审批区
    ["own-1", "95号汽油", "中石化一站", 7.76, 1.2, "王磊", 5],
    ["own-1", "95号汽油", "中海油南站", 7.72, 2.4, "赵强", 4],
    // own-2 / 92：仅一名采集人，等待第二人确认
    ["own-2", "92号汽油", "中石油东站", 7.35, 2.1, "陈敏", 1],
    // 距离 4.2 公里 -> 无效
    ["own-1", "柴油", "壳牌北环站", 6.88, 4.2, "王磊", 2],
    // 采集于 30 小时前 -> 过期无效
    ["own-2", "98号汽油", "中石化一站", 8.35, 2.0, "李娜", 30]
  ];
  return rows.map((r, i) => ({
    id: `seed-obs-${i + 1}`,
    ownStationId: r[0],
    fuel: r[1],
    rivalStation: r[2],
    rivalPrice: r[3],
    distance: r[4],
    collector: r[5],
    observedAt: isoHoursAgo(r[6]),
    createdAt: isoHoursAgo(r[6]),
    invalidSnapshot: "",
    suggestionId: null
  }));
}

/* ============================== 状态装载 ============================== */

const round2 = (n: number) => Math.round(n * 100) / 100;
const floorOf = (p: PriceEntry) => round2(p.cost + p.floorMargin);
const groupKeyOf = (stationId: string, fuel: string) => `${stationId}§${fuel}`;

function buildSeedStore(): Store {
  const store: Store = {
    version: STORE_VERSION,
    stations: seedStations(),
    prices: seedPrices(),
    observations: seedObservations(),
    suggestions: []
  };
  // 种子观察先按规则刷一遍无效快照，再生成建议
  const now = Date.now();
  for (const o of store.observations) o.invalidSnapshot = liveReasons(o.observedAt, o.distance, now);
  regenerateSuggestions(store, now);
  return store;
}

function loadStore(): Store {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Store;
      if (parsed.version === STORE_VERSION) return parsed;
    } catch {
      /* 数据损坏则回落种子 */
    }
  }
  const seeded = buildSeedStore();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

/* ============================== 规则引擎 ============================== */

/**
 * 无效原因：超过 24 小时 / 超过 3 公里 / 采集时间晚于当前。
 * 返回空串表示有效。
 */
function liveReasons(observedAt: string, distance: number, now: number): string {
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return "采集时间无效";
  const parts: string[] = [];
  if (t > now + 60_000) parts.push("采集时间晚于当前时间");
  const ageHours = (now - t) / 3600_000;
  if (ageHours > MAX_AGE_HOURS) {
    parts.push(`观察已超过24小时（采集于${ageHours.toFixed(1)}小时前）`);
  }
  if (distance > MAX_DISTANCE_KM) {
    parts.push(`对方站距离超过3公里（${distance}公里）`);
  }
  return parts.join("；");
}

/**
 * 由有效观察生成向下调价建议：
 * 同一本站 + 同一油品，需要两名不同采集人各自采到低于挂牌价的价格；
 * 确认低价 = 两人观察价中的更低者；低于成本+保底毛利时停在底线价并进待审批区。
 */
function regenerateSuggestions(store: Store, now: number): number {
  const priceMap = new Map(store.prices.map((p) => [groupKeyOf(p.stationId, p.fuel), p]));
  const groups = new Map<string, Observation[]>();

  for (const o of store.observations) {
    if (o.suggestionId) continue;
    if (liveReasons(o.observedAt, o.distance, now) !== "") continue;
    const key = groupKeyOf(o.ownStationId, o.fuel);
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }

  let created = 0;
  for (const [key, obs] of groups) {
    const sep = key.indexOf("§");
    const stationId = key.slice(0, sep);
    const fuel = key.slice(sep + 1) as Fuel;
    const entry = priceMap.get(key);
    if (!entry) continue;

    const blocked = store.suggestions.some(
      (s) =>
        s.ownStationId === stationId &&
        s.fuel === fuel &&
        (s.status === "pending" || s.status === "approval")
    );
    if (blocked) continue;

    const sorted = [...obs].sort((a, b) => a.rivalPrice - b.rivalPrice);
    const first = sorted[0];
    if (first.rivalPrice >= entry.listPrice) continue;
    // 第二条必须来自不同采集人，且同样观察到低于挂牌价的价格
    const second = sorted.find(
      (o) => o.collector !== first.collector && o.rivalPrice < entry.listPrice
    );
    if (!second) continue;

    const floor = floorOf(entry);
    const hitsFloor = first.rivalPrice < floor;
    const suggestion: Suggestion = {
      id: crypto.randomUUID(),
      ownStationId: stationId,
      fuel,
      currentPrice: entry.listPrice,
      confirmedLow: first.rivalPrice,
      floorPrice: floor,
      proposedPrice: hitsFloor ? floor : first.rivalPrice,
      hitsFloor,
      status: hitsFloor ? "approval" : "pending",
      observationIds: [first.id, second.id],
      createdAt: new Date(now).toISOString(),
      decidedAt: null,
      approver: "",
      basis: "",
      previousPrice: null,
      publishedPrice: null
    };
    store.suggestions.unshift(suggestion);
    first.suggestionId = suggestion.id;
    second.suggestionId = suggestion.id;
    created += 1;
  }
  return created;
}

/* ============================== 组件状态 ============================== */

const initialStore = loadStore();
const stations = ref<Station[]>(initialStore.stations);
const prices = ref<PriceEntry[]>(initialStore.prices);
const observations = ref<Observation[]>(initialStore.observations);
const suggestions = ref<Suggestion[]>(initialStore.suggestions);

/** 每分钟跳动一次，让“距现在时长 / 是否过期”实时更新 */
const nowTick = ref(Date.now());
setInterval(() => {
  nowTick.value = Date.now();
}, 30_000);

const operator = ref("");
const mainTab = ref<"sug" | "obs" | "price">("sug");
const sugTab = ref<"active" | "published" | "rejected">("active");
const obsTab = ref<"all" | "valid" | "invalid">("all");
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 3200);
}

function persist() {
  const data: Store = {
    version: STORE_VERSION,
    stations: stations.value,
    prices: prices.value,
    observations: observations.value,
    suggestions: suggestions.value
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/* ============================== 录入表单 ============================== */

type ObsForm = {
  ownStationId: string;
  fuel: Fuel | "";
  rivalStation: string;
  rivalPrice: number | null;
  distance: number | null;
  collector: string;
  observedAt: string;
};

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function blankForm(): ObsForm {
  return {
    ownStationId: stations.value.find((s) => s.kind === "own")?.id ?? "",
    fuel: "92号汽油",
    rivalStation: "",
    rivalPrice: null,
    distance: null,
    collector: "",
    observedAt: toLocalInput(new Date())
  };
}

const form = reactive<ObsForm>(blankForm());
const formErrors = reactive<Record<string, string>>({});

function submitObservation() {
  Object.keys(formErrors).forEach((k) => delete formErrors[k]);
  if (!form.ownStationId) formErrors.ownStationId = "请选择本站";
  if (!form.fuel) formErrors.fuel = "请选择油品";
  if (!form.rivalStation.trim()) formErrors.rivalStation = "请填写对方站名称";
  if (form.rivalPrice === null || form.rivalPrice <= 0)
    formErrors.rivalPrice = "请填写有效的对方站价格";
  if (form.distance === null || form.distance <= 0) formErrors.distance = "请填写距离（公里）";
  if (!form.collector.trim()) formErrors.collector = "请填写采集人";
  if (!form.observedAt) formErrors.observedAt = "请选择采集时间";
  if (Object.keys(formErrors).length > 0) {
    showToast("表单存在未填或错误项，请检查后提交");
    return;
  }

  const now = nowTick.value;
  const observedAt = new Date(form.observedAt).toISOString();
  const snapshot = liveReasons(observedAt, form.distance as number, now);
  const item: Observation = {
    id: crypto.randomUUID(),
    ownStationId: form.ownStationId,
    fuel: form.fuel as Fuel,
    rivalStation: form.rivalStation.trim(),
    rivalPrice: round2(form.rivalPrice as number),
    distance: Number(form.distance),
    collector: form.collector.trim(),
    observedAt,
    createdAt: new Date(now).toISOString(),
    invalidSnapshot: snapshot,
    suggestionId: null
  };
  observations.value = [item, ...observations.value];

  const store: Store = {
    version: STORE_VERSION,
    stations: stations.value,
    prices: prices.value,
    observations: observations.value,
    suggestions: suggestions.value
  };
  const created = regenerateSuggestions(store, now);
  persist();

  if (snapshot) {
    showToast(`该记录已进入无效区：${snapshot}`);
    mainTab.value = "obs";
    obsTab.value = "invalid";
  } else if (created > 0) {
    showToast("已由两名采集人的低价确认生成向下调价建议");
    mainTab.value = "sug";
    sugTab.value = "active";
  } else {
    showToast("观察已记入有效区，等待第二名采集人确认低价");
    mainTab.value = "obs";
    obsTab.value = "valid";
  }

  Object.assign(form, blankForm());
}

/* ============================== 审批与发布 ============================== */

const approvalDrafts = reactive<Record<string, { approver: string; basis: string; error: string }>>(
  {}
);

function draftFor(s: Suggestion) {
  if (!approvalDrafts[s.id]) {
    approvalDrafts[s.id] = { approver: operator.value, basis: "", error: "" };
  }
  return approvalDrafts[s.id];
}

function publishDirect(s: Suggestion) {
  if (!operator.value.trim()) {
    showToast("请先在右上角填写当前操作员（发布人）");
    return;
  }
  if (evidenceStale(s)) {
    showToast("观察依据已过期，请补采后再发布");
    return;
  }
  const entry = priceEntry(s.ownStationId, s.fuel);
  if (!entry) return;
  s.previousPrice = entry.listPrice;
  s.publishedPrice = s.proposedPrice;
  s.status = "published";
  s.decidedAt = new Date().toISOString();
  s.approver = operator.value.trim();
  s.basis = "两条来自不同采集人的有效观察确认低价，建议价高于成本加保底毛利底线，按规则直接发布。";
  entry.listPrice = s.proposedPrice;
  persist();
  showToast(`挂牌价已由 ¥${s.previousPrice} 替换为 ¥${s.publishedPrice}`);
}

function approveAtFloor(s: Suggestion) {
  const draft = draftFor(s);
  draft.error = "";
  if (!draft.approver.trim()) draft.error = "请填写审批人";
  if (draft.basis.trim().length < 5) draft.error = "请写明审批依据（不少于5个字）";
  if (draft.error) return;
  if (evidenceStale(s)) {
    showToast("观察依据已过期，请补采后再审批");
    return;
  }
  const entry = priceEntry(s.ownStationId, s.fuel);
  if (!entry) return;
  s.previousPrice = entry.listPrice;
  s.publishedPrice = s.floorPrice;
  s.status = "published";
  s.decidedAt = new Date().toISOString();
  s.approver = draft.approver.trim();
  s.basis = draft.basis.trim();
  entry.listPrice = s.floorPrice;
  persist();
  showToast(`审批通过，挂牌价停在底线价 ¥${s.floorPrice}`);
}

function rejectSuggestion(s: Suggestion) {
  const draft = draftFor(s);
  draft.error = "";
  if (!draft.approver.trim()) draft.error = "请填写审批人";
  if (draft.basis.trim().length < 5) draft.error = "请写明驳回依据（不少于5个字）";
  if (draft.error) return;
  s.status = "rejected";
  s.decidedAt = new Date().toISOString();
  s.approver = draft.approver.trim();
  s.basis = draft.basis.trim();
  // 依据保留、观察引用保留：被驳回的证据不会再次自动生成建议，需重新采集新一轮
  persist();
  showToast("建议已驳回，依据已留存");
}

/* ============================== 底线设置 ============================== */

function saveFloorSettings(stationId: string) {
  for (const p of prices.value) {
    if (p.stationId !== stationId) continue;
    if (!(p.cost >= 0) || !(p.floorMargin >= 0)) {
      showToast("成本与保底毛利需为不小于 0 的数字");
      return;
    }
    p.cost = round2(p.cost);
    p.floorMargin = round2(p.floorMargin);
  }
  // 底线变化后，重算所有未决建议是否触底线（已发布/已驳回的历史不动）
  for (const s of suggestions.value) {
    if (s.status !== "pending" && s.status !== "approval") continue;
    const entry = priceEntry(s.ownStationId, s.fuel);
    if (!entry) continue;
    s.floorPrice = floorOf(entry);
    s.hitsFloor = s.confirmedLow < s.floorPrice;
    s.proposedPrice = s.hitsFloor ? s.floorPrice : s.confirmedLow;
    s.status = s.hitsFloor ? "approval" : "pending";
  }
  persist();
  showToast("底线设置已保存，未决建议已按新底线重新判定");
}

/* ============================== 派生视图 ============================== */

const ownStations = computed(() => stations.value.filter((s) => s.kind === "own"));
const rivalStations = computed(() => stations.value.filter((s) => s.kind === "rival"));

const stationMap = computed(() => new Map(stations.value.map((s) => [s.id, s])));
const stationName = (id: string) => stationMap.value.get(id)?.name ?? "未知本站";

function priceEntry(stationId: string, fuel: Fuel) {
  return prices.value.find((p) => p.stationId === stationId && p.fuel === fuel);
}

const pricesByStation = computed(() => {
  const map = new Map<string, PriceEntry[]>();
  for (const s of ownStations.value) map.set(s.id, []);
  for (const p of prices.value) map.get(p.stationId)?.push(p);
  return map;
});

const reasonOf = (o: Observation) =>
  o.invalidSnapshot || liveReasons(o.observedAt, o.distance, nowTick.value);
const isValid = (o: Observation) => reasonOf(o) === "";

const observationMap = computed(() => new Map(observations.value.map((o) => [o.id, o])));
const suggestionMap = computed(() => new Map(suggestions.value.map((s) => [s.id, s])));

function evidenceStale(s: Suggestion) {
  return s.observationIds.some((id) => {
    const o = observationMap.value.get(id);
    return !o || !isValid(o);
  });
}

const sortedObservations = computed(() =>
  [...observations.value].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
);

const visibleObservations = computed(() => {
  if (obsTab.value === "valid") return sortedObservations.value.filter(isValid);
  if (obsTab.value === "invalid") return sortedObservations.value.filter((o) => !isValid(o));
  return sortedObservations.value;
});

const STATUS_META: Record<SuggestionStatus, { text: string; cls: string }> = {
  pending: { text: "待发布", cls: "st-ok" },
  approval: { text: "触底线·待审批", cls: "st-warn" },
  published: { text: "已发布", cls: "st-done" },
  rejected: { text: "已驳回", cls: "st-bad" }
};

const activeSuggestions = computed(() =>
  suggestions.value
    .filter((s) => s.status === "pending" || s.status === "approval")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
);
const publishedSuggestions = computed(() =>
  suggestions.value
    .filter((s) => s.status === "published")
    .sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0))
);
const rejectedSuggestions = computed(() =>
  suggestions.value
    .filter((s) => s.status === "rejected")
    .sort((a, b) => (Date.parse(b.decidedAt ?? "") || 0) - (Date.parse(a.decidedAt ?? "") || 0))
);
const visibleSuggestions = computed(() => {
  if (sugTab.value === "published") return publishedSuggestions.value;
  if (sugTab.value === "rejected") return rejectedSuggestions.value;
  return activeSuggestions.value;
});

const latestPublished = computed(() => {
  const map = new Map<string, Suggestion>();
  for (const s of publishedSuggestions.value) {
    const key = groupKeyOf(s.ownStationId, s.fuel);
    if (!map.has(key)) map.set(key, s);
  }
  return map;
});

const metrics = computed(() => [
  { label: "有效观察", value: observations.value.filter(isValid).length },
  { label: "无效观察", value: observations.value.filter((o) => !isValid(o)).length },
  { label: "待处理建议", value: activeSuggestions.value.length },
  { label: "已发布建议", value: publishedSuggestions.value.length }
]);

/* ============================== 展示辅助 ============================== */

function ageLabel(iso: string): string {
  const ms = nowTick.value - Date.parse(iso);
  if (ms < 0) return "未来时间";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}分钟前`;
  return `${(minutes / 60).toFixed(1)}小时前`;
}

function fmtFull(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 区域调度比价闭环</p>
          <h1>周边油站比价建议台</h1>
          <p class="subtitle">
            录入周边油站现场观察，超过 24 小时或 3 公里的记录自动归入无效区；两名不同采集人确认低价后生成向下调价建议，
            不允许跌破成本加保底毛利，触底线一律停留待审批，审批依据与原价全程留存。
          </p>
        </div>
        <div class="top-side">
          <div class="stack">
            <span class="tag">Vue3</span>
            <span class="tag">TypeScript</span>
            <span class="tag">Pinia</span>
            <span class="tag">localStorage</span>
          </div>
          <label class="operator-box">
            当前操作员（发布/审批默认人）
            <input v-model="operator" placeholder="请输入姓名" />
          </label>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- ===================== 观察录入 ===================== -->
        <form class="panel" @submit.prevent="submitObservation">
          <h2>观察填写</h2>
          <ul class="rules">
            <li>采集超过 <b>24 小时</b> 自动过期</li>
            <li>距离超过 <b>3 公里</b> 不纳入比价</li>
            <li>需 <b>两名不同采集人</b> 确认同一低价</li>
            <li>建议价不得跌破 <b>成本 + 保底毛利</b></li>
          </ul>

          <div class="form-grid">
            <label>
              本站
              <select v-model="form.ownStationId">
                <option v-for="s in ownStations" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
              <small v-if="formErrors.ownStationId" class="err">{{ formErrors.ownStationId }}</small>
            </label>

            <label>
              油品
              <select v-model="form.fuel">
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
              <small v-if="formErrors.fuel" class="err">{{ formErrors.fuel }}</small>
            </label>

            <label>
              对方站
              <input
                v-model="form.rivalStation"
                list="rival-list"
                placeholder="如：中石化一站"
              />
              <datalist id="rival-list">
                <option v-for="r in rivalStations" :key="r.id" :value="r.name"></option>
              </datalist>
              <small v-if="formErrors.rivalStation" class="err">{{ formErrors.rivalStation }}</small>
            </label>

            <div class="form-row">
              <label>
                对方挂牌价（元/升）
                <input
                  v-model.number="form.rivalPrice"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="7.29"
                />
                <small v-if="formErrors.rivalPrice" class="err">{{ formErrors.rivalPrice }}</small>
              </label>
              <label>
                距离（公里）
                <input
                  v-model.number="form.distance"
                  type="number"
                  min="0.1"
                  step="0.1"
                  placeholder="1.8"
                />
                <small v-if="formErrors.distance" class="err">{{ formErrors.distance }}</small>
              </label>
            </div>

            <label>
              采集人
              <input v-model="form.collector" placeholder="现场采集人姓名" />
              <small v-if="formErrors.collector" class="err">{{ formErrors.collector }}</small>
            </label>

            <label>
              采集时间
              <input v-model="form.observedAt" type="datetime-local" />
              <small v-if="formErrors.observedAt" class="err">{{ formErrors.observedAt }}</small>
            </label>

            <button type="submit" class="primary-btn">提交观察</button>
          </div>

          <div class="directory">
            <p class="dir-title">本站（{{ ownStations.length }}）</p>
            <div class="stack">
              <span v-for="s in ownStations" :key="s.id" class="tag tag-own">{{ s.name }}</span>
            </div>
            <p class="dir-title">周边对方站（{{ rivalStations.length }}）</p>
            <div class="stack">
              <span v-for="s in rivalStations" :key="s.id" class="tag tag-rival">
                {{ s.name }} · {{ s.area }}
              </span>
            </div>
          </div>
        </form>

        <!-- ===================== 右侧工作台 ===================== -->
        <section class="list-panel">
          <div class="tabs" role="tablist">
            <button
              type="button"
              :class="{ active: mainTab === 'sug' }"
              @click="mainTab = 'sug'"
            >
              调价建议
              <span v-if="activeSuggestions.length" class="pill">{{ activeSuggestions.length }}</span>
            </button>
            <button
              type="button"
              :class="{ active: mainTab === 'obs' }"
              @click="mainTab = 'obs'"
            >
              观察记录
            </button>
            <button
              type="button"
              :class="{ active: mainTab === 'price' }"
              @click="mainTab = 'price'"
            >
              本站牌价与底线
            </button>
          </div>

          <!-- ---------- 建议区 ---------- -->
          <div v-if="mainTab === 'sug'">
            <div class="segmented">
              <button
                type="button"
                :class="{ active: sugTab === 'active' }"
                @click="sugTab = 'active'"
              >
                待处理（{{ activeSuggestions.length }}）
              </button>
              <button
                type="button"
                :class="{ active: sugTab === 'published' }"
                @click="sugTab = 'published'"
              >
                已发布（{{ publishedSuggestions.length }}）
              </button>
              <button
                type="button"
                :class="{ active: sugTab === 'rejected' }"
                @click="sugTab = 'rejected'"
              >
                已驳回（{{ rejectedSuggestions.length }}）
              </button>
            </div>

            <div class="record-grid">
              <div v-if="visibleSuggestions.length === 0" class="empty">
                <template v-if="sugTab === 'active'">
                  暂无待处理建议。有效低价需由两名不同采集人确认后才会生成。
                </template>
                <template v-else-if="sugTab === 'published'">暂无已发布建议。</template>
                <template v-else>暂无已驳回建议。</template>
              </div>

              <article
                v-for="s in visibleSuggestions"
                :key="s.id"
                class="sug-card"
                :class="{
                  'sug-approval': s.status === 'approval',
                  'sug-published': s.status === 'published',
                  'sug-rejected': s.status === 'rejected'
                }"
              >
                <div class="record-head">
                  <p class="record-title">
                    {{ stationName(s.ownStationId) }} · {{ s.fuel }}
                  </p>
                  <span class="status" :class="STATUS_META[s.status].cls">
                    {{ STATUS_META[s.status].text }}
                  </span>
                </div>

                <div class="price-line">
                  <template v-if="s.status === 'published'">
                    挂牌价
                    <del>¥{{ s.previousPrice ?? s.currentPrice }}</del>
                    <span class="arrow">→</span>
                    <b class="new-price">¥{{ s.publishedPrice }}</b>
                  </template>
                  <template v-else>
                    现挂牌价 <b>¥{{ s.currentPrice }}</b>
                    <span class="arrow">→</span>
                    建议价
                    <b class="new-price" :class="{ floor: s.hitsFloor }">¥{{ s.proposedPrice }}</b>
                    <span v-if="s.hitsFloor" class="badge badge-warn">停在底线价</span>
                  </template>
                </div>

                <div class="floor-line">
                  确认低价：<b>¥{{ s.confirmedLow }}</b>
                  ｜成本＋保底毛利底线：<b :class="{ floor: s.hitsFloor }">¥{{ s.floorPrice }}</b>
                  <span v-if="s.hitsFloor && s.status !== 'published'" class="floor-hint">
                    确认低价已跌破底线，不得直接发布
                  </span>
                </div>

                <div class="evidence">
                  <p class="evidence-title">确认依据（两名不同采集人）：</p>
                  <div
                    v-for="oid in s.observationIds"
                    :key="oid"
                    class="evi-item"
                    :class="{ stale: observationMap.get(oid) && !isValid(observationMap.get(oid)!) }"
                  >
                    <template v-if="observationMap.get(oid)">
                      <b>{{ observationMap.get(oid)!.rivalStation }}</b>
                      ¥{{ observationMap.get(oid)!.rivalPrice }}
                      · {{ observationMap.get(oid)!.distance }}km
                      · 采集人 {{ observationMap.get(oid)!.collector }}
                      · {{ fmtFull(observationMap.get(oid)!.observedAt) }}
                      <span class="age">（{{ ageLabel(observationMap.get(oid)!.observedAt) }}）</span>
                      <span
                        v-if="!isValid(observationMap.get(oid)!)"
                        class="badge badge-bad"
                      >依据已失效</span>
                    </template>
                    <template v-else>
                      <span class="err">原始观察记录缺失</span>
                    </template>
                  </div>
                  <p v-if="(s.status === 'pending' || s.status === 'approval') && evidenceStale(s)"
                     class="err stale-tip">
                    观察依据已超出 24 小时有效期，请补采新价后再发布/审批。
                  </p>
                </div>

                <!-- 待发布 -->
                <div v-if="s.status === 'pending'" class="actions">
                  <button type="button" :disabled="evidenceStale(s)" @click="publishDirect(s)">
                    发布并替换挂牌价
                  </button>
                  <span class="action-hint">发布人：{{ operator || "（请先在右上角填写操作员）" }}</span>
                </div>

                <!-- 待审批 -->
                <div v-else-if="s.status === 'approval'" class="approval-box">
                  <p class="approval-note">
                    该建议会使挂牌价跌破保底毛利，已停在待审批区；审批人写明依据后，按底线价
                    ¥{{ s.floorPrice }} 发布。
                  </p>
                  <label>
                    审批人
                    <input v-model="draftFor(s).approver" placeholder="审批人姓名" />
                  </label>
                  <label>
                    审批依据
                    <textarea
                      v-model="draftFor(s).basis"
                      placeholder="如：周边三站连续两日同价，片区竞争激烈，按底线价跟价并报备区域公司"
                    ></textarea>
                  </label>
                  <p v-if="draftFor(s).error" class="err">{{ draftFor(s).error }}</p>
                  <div class="actions">
                    <button type="button" :disabled="evidenceStale(s)" @click="approveAtFloor(s)">
                      同意按底线价发布
                    </button>
                    <button type="button" class="danger" @click="rejectSuggestion(s)">驳回</button>
                  </div>
                </div>

                <!-- 已发布 -->
                <div v-else-if="s.status === 'published'" class="decision">
                  <p><span>原价保留：</span>¥{{ s.previousPrice ?? s.currentPrice }}</p>
                  <p><span>发布价：</span><b>¥{{ s.publishedPrice }}</b></p>
                  <p><span>审批/发布人：</span>{{ s.approver }}</p>
                  <p><span>发布时间：</span>{{ fmtFull(s.decidedAt) }}</p>
                  <p class="basis"><span>依据：</span>{{ s.basis }}</p>
                </div>

                <!-- 已驳回 -->
                <div v-else class="decision decision-bad">
                  <p><span>驳回人：</span>{{ s.approver }}</p>
                  <p><span>驳回时间：</span>{{ fmtFull(s.decidedAt) }}</p>
                  <p class="basis"><span>驳回依据：</span>{{ s.basis }}</p>
                </div>
              </article>
            </div>
          </div>

          <!-- ---------- 观察区 ---------- -->
          <div v-else-if="mainTab === 'obs'">
            <div class="segmented">
              <button
                type="button"
                :class="{ active: obsTab === 'all' }"
                @click="obsTab = 'all'"
              >
                全部（{{ observations.length }}）
              </button>
              <button
                type="button"
                :class="{ active: obsTab === 'valid' }"
                @click="obsTab = 'valid'"
              >
                有效区（{{ observations.filter(isValid).length }}）
              </button>
              <button
                type="button"
                :class="{ active: obsTab === 'invalid' }"
                @click="obsTab = 'invalid'"
              >
                无效区（{{ observations.filter(o => !isValid(o)).length }}）
              </button>
            </div>

            <div class="record-grid">
              <div v-if="visibleObservations.length === 0" class="empty">暂无匹配记录</div>
              <article
                v-for="o in visibleObservations"
                :key="o.id"
                class="obs-card"
                :class="{ 'is-invalid': !isValid(o) }"
              >
                <div class="record-head">
                  <p class="record-title">
                    {{ stationName(o.ownStationId) }} · {{ o.fuel }}
                    <span class="rival">→ {{ o.rivalStation }}</span>
                  </p>
                  <span v-if="isValid(o)" class="status st-ok">有效</span>
                  <span v-else class="status st-bad">无效</span>
                </div>
                <div class="details">
                  <span>对方价：<b>¥{{ o.rivalPrice }}</b></span>
                  <span>距离：<b :class="{ 'text-bad': o.distance > 3 }">{{ o.distance }} 公里</b></span>
                  <span>采集人：<b>{{ o.collector }}</b></span>
                  <span>采集时间：{{ fmtFull(o.observedAt) }}（{{ ageLabel(o.observedAt) }}）</span>
                </div>
                <p v-if="!isValid(o)" class="invalid-reason">无效原因：{{ reasonOf(o) }}</p>
                <p v-else-if="o.suggestionId && suggestionMap.get(o.suggestionId)" class="linked">
                  已用于生成建议：{{ stationName(o.ownStationId) }} · {{ o.fuel }}
                  （{{ STATUS_META[suggestionMap.get(o.suggestionId)!.status].text }}）
                </p>
                <p v-else class="linked pending-link">有效观察，等待第二名不同采集人确认低价</p>
              </article>
            </div>
          </div>

          <!-- ---------- 牌价与底线 ---------- -->
          <div v-else class="price-board">
            <p class="board-tip">
              挂牌价只能由已发布的建议替换；此处可维护各油品的进货成本与保底毛利，修改保存后未决建议会重新判定是否触底线。
            </p>
            <div v-for="s in ownStations" :key="s.id" class="price-station">
              <h3>{{ s.name }} <span class="tag">{{ s.area }}</span></h3>
              <div class="price-table">
                <div class="price-row price-head-row">
                  <span>油品</span>
                  <span>当前挂牌价</span>
                  <span>进货成本</span>
                  <span>保底毛利</span>
                  <span>底线价（成本+毛利）</span>
                  <span>最近替换</span>
                </div>
                <div v-for="p in pricesByStation.get(s.id) ?? []" :key="p.fuel" class="price-row">
                  <span class="fuel-name">{{ p.fuel }}</span>
                  <span class="list-price">¥{{ p.listPrice }}</span>
                  <span class="price-edit">
                    <input v-model.number="p.cost" type="number" min="0" step="0.01" />
                  </span>
                  <span class="price-edit">
                    <input v-model.number="p.floorMargin" type="number" min="0" step="0.01" />
                  </span>
                  <span class="floor-price">¥{{ floorOf(p) }}</span>
                  <span class="last-change">
                    <template v-if="latestPublished.get(groupKeyOf(p.stationId, p.fuel))">
                      <del>¥{{ latestPublished.get(groupKeyOf(p.stationId, p.fuel))!.previousPrice }}</del>
                      → ¥{{ latestPublished.get(groupKeyOf(p.stationId, p.fuel))!.publishedPrice }}
                      <small :title="latestPublished.get(groupKeyOf(p.stationId, p.fuel))!.basis">
                        依据已留存
                      </small>
                    </template>
                    <template v-else>—</template>
                  </span>
                </div>
              </div>
              <div class="actions">
                <button type="button" @click="saveFloorSettings(s.id)">保存底线并重算建议</button>
              </div>
            </div>
          </div>
        </section>
      </section>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </main>
</template>
