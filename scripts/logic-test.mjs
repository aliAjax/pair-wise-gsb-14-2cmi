// 临时验证脚本：编译 src/App.vue 的 <script setup> 并直接执行其中的规则逻辑
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

const src = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const { descriptor } = parse(src);
const tsCode = descriptor.scriptSetup.content;
const { code: js } = transformSync(tsCode, { loader: "ts" });

const mock = `
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); }
};
`;

const asserts = `
// ================= 断言 =================
const assert = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); console.log("ok -", msg); };

// 1. 种子数据应生成 2 条建议：own-1/92 待发布、own-1/95 触底线待审批
assert(suggestions.value.length === 2, "种子生成 2 条建议");
const s92 = suggestions.value.find(s => s.fuel === "92号汽油");
const s95 = suggestions.value.find(s => s.fuel === "95号汽油");
assert(s92 && s92.status === "pending" && s92.proposedPrice === 7.29 && s92.confirmedLow === 7.29, "92号: 待发布, 建议价=确认低价 7.29");
assert(s95 && s95.status === "approval" && s95.hitsFloor && s95.proposedPrice === 7.75 && s95.floorPrice === 7.75, "95号: 触底线待审批, 停在底线价 7.75");

// 2. 无效判定：4.2km 与 30 小时前各一条
const invalids = observations.value.filter(o => !isValid(o));
assert(invalids.length === 2, "无效区 2 条（超距+过期）");
assert(invalids.some(o => reasonOf(o).includes("超过3公里")), "超距原因写明");
assert(invalids.some(o => reasonOf(o).includes("超过24小时")), "过期原因写明");
assert(observations.value.filter(isValid).length === 5, "有效区 5 条");

// 3. 建议必须来自不同采集人
const evi = s92.observationIds.map(id => observations.value.find(o => o.id === id).collector);
assert(new Set(evi).size === 2, "92号建议由两名不同采集人确认");

// 4. 录入一条超距观察 -> 进无效区且不生成建议
form.ownStationId = "own-2"; form.fuel = "柴油"; form.rivalStation = "壳牌北环站";
form.rivalPrice = 6.5; form.distance = 5.0; form.collector = "测试员";
form.observedAt = toLocalInput(new Date());
const beforeSug = suggestions.value.length;
submitObservation();
assert(observations.value.length === 8, "新观察已录入");
assert(!isValid(observations.value[0]) && reasonOf(observations.value[0]).includes("超过3公里"), "新观察因超距进无效区");
assert(suggestions.value.length === beforeSug, "无效观察不生成建议");

// 5. 同一采集人两次低价 -> 不生成建议（需不同采集人）
const fillObs = (price, collector) => {
  form.ownStationId = "own-2"; form.fuel = "柴油"; form.rivalStation = "中石油东站";
  form.rivalPrice = price; form.distance = 1.0; form.collector = collector;
  form.observedAt = toLocalInput(new Date());
  submitObservation();
};
fillObs(6.9, "单人甲");
fillObs(6.88, "单人甲");
assert(!suggestions.value.some(s => s.ownStationId === "own-2" && s.fuel === "柴油"), "同一采集人不生成建议");

// 6. 第二名不同采集人确认低价 -> 生成建议
fillObs(6.89, "单人乙");
const sDiesel = suggestions.value.find(s => s.ownStationId === "own-2" && s.fuel === "柴油");
assert(sDiesel && sDiesel.status === "pending" && sDiesel.proposedPrice === 6.88, "双人确认后生成建议, 取更低确认价 6.88");

// 7. 直接发布替换挂牌价并留痕
operator.value = "调度员小周";
publishDirect(sDiesel);
const entry = prices.value.find(p => p.stationId === "own-2" && p.fuel === "柴油");
assert(entry.listPrice === 6.88, "挂牌价被替换为 6.88");
assert(sDiesel.status === "published" && sDiesel.previousPrice === 7.15 && sDiesel.basis.length > 0, "原价 7.15 与依据保留");

// 8. 触底线建议：未写依据不得发布
const draft = draftFor(s95);
draft.approver = "区域经理"; draft.basis = "";
approveAtFloor(s95);
assert(s95.status === "approval", "缺依据时停留待审批");
draft.basis = "周边三站连续两日同价，片区竞争激烈，按底线价跟价";
approveAtFloor(s95);
const e95 = prices.value.find(p => p.stationId === "own-1" && p.fuel === "95号汽油");
assert(s95.status === "published" && e95.listPrice === 7.75, "审批通过后按底线价 7.75 发布");
assert(s95.previousPrice === 8.18 && s95.approver === "区域经理", "原价与审批人留痕");

// 9. 底线调整 -> 未决建议重算（92号建议 7.29，底线 7.25；把保底毛利调到 0.5 -> 底线 7.40 触发待审批）
const e92 = prices.value.find(p => p.stationId === "own-1" && p.fuel === "92号汽油");
e92.floorMargin = 0.5;
saveFloorSettings("own-1");
assert(s92.status === "approval" && s92.floorPrice === 7.4 && s92.proposedPrice === 7.4, "底线调整后未决建议重算为待审批");

// 10. 驳回需写依据并留痕
const d92 = draftFor(s92);
d92.approver = "区域经理"; d92.basis = "毛利过低，暂不跟价";
rejectSuggestion(s92);
assert(s92.status === "rejected" && s92.basis.includes("毛利过低"), "驳回留痕");

console.log("\\n全部断言通过");
`;

const tmpUrl = new URL("./.logic-test-run.mjs", import.meta.url);
writeFileSync(tmpUrl, mock + js + asserts);
try {
  await import("./.logic-test-run.mjs");
} finally {
  unlinkSync(tmpUrl);
}
process.exit(0);
