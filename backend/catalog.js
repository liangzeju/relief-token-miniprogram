const asset = name => `/shared/assets/${name}.png`;

// Prices, inventory, suppliers and project metrics are demonstration data.
const marketplace = [
  { id: "MAT-WATER", name: "瓶装饮用水", category: "饮水食品", priceMon: 12, unit: "箱", stock: 2400, supplier: "演示供水服务站", etaHours: 6, image: asset("water"), description: "安置点饮水补给；价格与库存仅供演示。", specs: ["550ml × 24瓶", "整箱配送"] },
  { id: "MAT-FOOD", name: "应急食品包", category: "饮水食品", priceMon: 28, unit: "包", stock: 1800, supplier: "演示食品保障站", etaHours: 8, image: asset("food"), description: "常温食品补给；价格与库存仅供演示。", specs: ["单人日份", "独立包装"] },
  { id: "MAT-FILTER", name: "便携净水套件", category: "饮水食品", priceMon: 75, unit: "套", stock: 300, supplier: "演示供水服务站", etaHours: 12, image: asset("filter"), description: "饮水保障演练套件；价格与库存仅供演示。", specs: ["滤芯及储水袋", "附使用说明"] },
  { id: "MAT-MEDICAL", name: "基础急救包", category: "医疗物资", priceMon: 45, unit: "套", stock: 600, supplier: "演示医疗物资站", etaHours: 6, image: asset("medical"), description: "基础急救物资保障；价格与库存仅供演示。", specs: ["绷带及敷料", "一次性防护用品"] },
  { id: "MAT-HYGIENE", name: "卫生防护包", category: "医疗物资", priceMon: 18, unit: "包", stock: 1200, supplier: "演示医疗物资站", etaHours: 8, image: asset("hygiene"), description: "安置点卫生用品；价格与库存仅供演示。", specs: ["口罩及手套", "个人清洁用品"] },
  { id: "MAT-TENT", name: "应急安置帐篷", category: "安置装备", priceMon: 320, unit: "顶", stock: 120, supplier: "演示安置装备站", etaHours: 18, image: asset("tent"), description: "临时安置装备；价格与库存仅供演示。", specs: ["家庭型帐篷", "含地钉与防潮底布"] },
  { id: "MAT-BEDDING", name: "保暖寝具包", category: "安置装备", priceMon: 60, unit: "套", stock: 800, supplier: "演示安置装备站", etaHours: 12, image: asset("bedding"), description: "安置点寝具补充；价格与库存仅供演示。", specs: ["棉被及防潮垫", "单人套装"] },
  { id: "SVC-RESCUE", name: "专业救援队支持", category: "救援服务", priceMon: 1800, unit: "队日", stock: 12, supplier: "演示救援协作队", etaHours: 4, image: asset("rescue"), description: "救援队调度演练报价，不代表真实出勤承诺。", specs: ["6人工作组", "1个演练工作日"] },
  { id: "SVC-VOLUNTEER", name: "志愿服务后勤保障", category: "救援服务", priceMon: 80, unit: "人日", stock: 200, supplier: "演示志愿协作站", etaHours: 12, image: asset("rescue"), description: "演示费用为交通、餐食和保险保障，不是志愿劳动报酬。", specs: ["物资分发协助", "单人后勤保障"] },
  { id: "SVC-REBUILD", name: "房屋安全排查", category: "灾后重建", priceMon: 250, unit: "户", stock: 60, supplier: "演示重建服务站", etaHours: 48, image: asset("rebuild"), description: "重建排查流程演练；价格与库存仅供演示。", specs: ["现场记录", "排查意见演示模板"] },
  { id: "MAT-REBUILD", name: "基础修缮工具包", category: "灾后重建", priceMon: 120, unit: "套", stock: 160, supplier: "演示重建服务站", etaHours: 24, image: asset("rebuild"), description: "修缮工具补给；价格与库存仅供演示。", specs: ["常用手动工具", "基础防护装备"] },
  { id: "SVC-CLEANUP", name: "场地清理服务", category: "灾后重建", priceMon: 600, unit: "组日", stock: 30, supplier: "演示重建服务站", etaHours: 24, image: asset("rebuild"), description: "安置点恢复演练；价格与库存仅供演示。", specs: ["4人清理组", "单个工作日"] }
];

const demoTasks = [
  { id: "TASK-001", title: "中国安置点饮水与救援演练", disasterType: "洪涝演练", location: "中国示范安置点（演练）", taskType: "生命救援", severity: "critical", status: "DISPATCHING", verificationStatus: "VERIFIED", requirements: { material: "饮用水与救援队支持（演示需求）" }, monTarget: 100000, monRaised: 45360, participants: 120, participantTarget: 300, image: asset("water"), sections: [{ title: "演练范围", value: "饮水补给、分发登记和救援队协作。" }, { title: "资金说明", value: "目标与进度均为演示数据，不代表真实募资。" }] },
  { id: "TASK-002", title: "尼泊尔灾害准备与安置演练", disasterType: "灾害准备演练", location: "尼泊尔模拟安置点（演练）", taskType: "医疗救助", severity: "high", status: "EXECUTING", verificationStatus: "VERIFIED", requirements: { material: "急救包、卫生用品与安置装备（演示需求）" }, monTarget: 80000, monRaised: 0, participants: 0, participantTarget: 160, image: asset("medical"), sections: [{ title: "演练范围", value: "医疗物资、卫生用品和临时安置准备。" }, { title: "关联说明", value: "独立演示项目，与新闻中机构的实际援助计划无关联。" }] }
];

function enrichTask(task) {
  const defaults = demoTasks.find(item => item.id === task.id && item.location === task.location && item.disasterType === task.disasterType && item.taskType === task.taskType) || {};
  const enriched = {
    ...task,
    title: task.title ?? defaults.title ?? `${task.disasterType ?? "救援"} / ${typeof task.location === "string" ? task.location : "待定地点"}（演示）`,
    monTarget: task.monTarget ?? defaults.monTarget ?? 0,
    monRaised: task.monRaised ?? defaults.monRaised ?? 0,
    participants: task.participants ?? defaults.participants ?? 0,
    participantTarget: task.participantTarget ?? defaults.participantTarget ?? 0,
    articleId: task.articleId ?? null,
    sections: task.sections ?? defaults.sections ?? [{ title: "项目说明", value: "独立演示任务，不代表真实新闻中的救援项目。" }],
    urgencyLabel: task.urgencyLabel ?? ({ critical: "紧急演练", high: "优先演练" }[task.severity] ?? "常规演练"),
    need: task.need ?? task.requirements?.material ?? "待核定演示需求",
    image: task.image ?? defaults.image ?? asset("rescue"),
    dataMode: "demo"
  };
  const sections = [
    { title: "物资目标", value: enriched.need },
    { title: "人力人数", value: `演示参与 ${enriched.participants} 人，参与目标 ${enriched.participantTarget} 人；专业人员配置待调度核定。` },
    { title: "交付验收", value: "演练要求：按批次清点数量、登记签收并提交验收凭证；实际交付与验收以批次记录为准。" },
    { title: "合同进度", value: defaults.id === "TASK-001" ? "初始演示合同 CTR-001 履约中，初始进度 30%；后续进度以关联合同记录为准。" : "按订单审核、合同审批、履约和验收流程推进；当前进度以关联合同记录为准。" }
  ];
  enriched.sections = [...enriched.sections, ...sections.filter(section => !enriched.sections.some(existing => existing.title === section.title))];
  return enriched;
}

const disasterUpdates = [
  {
    id: "NEWS-NP-WVI-20260903", title: "尼泊尔洪灾：世界宣明会发布首期响应报告", region: "尼泊尔", type: "洪灾响应报告", dataMode: "reported", sourceName: "World Vision International",
    sourceUrl: "https://www.wvi.org/publications/report/nepal/situation-report-1-world-vision-international-nepal-nepal-flash-floods",
    publishedAt: "2026-09-03", asOf: "2026-09-02", image: asset("rescue"), imageCaption: "救援主题示意图，非新闻现场照片", relatedTasks: [],
    summary: "据世界宣明会截至9月2日的报告，Rasuwa、Nuwakot、Dhading等地约5万人受灾、逾2.1万人流离失所。该机构计划在90天内援助1万人、覆盖2000户，已向900人提供支持。需求包括食品、住所、饮水卫生、儿童保护与教育。",
    stats: [{ label: "受灾人数", value: "约50,000人" }, { label: "流离失所", value: "逾21,000人" }, { label: "计划援助", value: "10,000人 / 2,000户" }, { label: "已获援助", value: "900人" }, { label: "伤亡", value: "未公布（本来源摘要）" }],
    paragraphs: ["报告描述当地洪灾的基本生活与儿童保护需求，并列出90天应急援助安排。", "以上为来源报告摘要，统计截至2026年9月2日。平台商城价格、项目目标和资金进度均为独立演示数据，不代表该机构募资或实际资金流向。" ]
  },
  {
    id: "NEWS-CN-MEM-20260902", title: "应急管理部发布9月全国自然灾害风险形势", region: "中国", type: "风险研判", dataMode: "reported", sourceName: "中华人民共和国应急管理部",
    sourceUrl: "https://www.mem.gov.cn/xw/yjglbgzdt/202609/t20260902_710211.shtml",
    publishedAt: "2026-09-02", asOf: "2026-09-02", image: asset("tent"), imageCaption: "安置装备示意图，非新闻现场照片", relatedTasks: [],
    summary: "应急管理部会同有关部门研判9月自然灾害风险：部分地区洪涝、风雹及地质灾害风险较高，需关注降雨和台风影响。此信息为月度风险预测，不是已发生灾情通报。",
    stats: [{ label: "研判时段", value: "2026年9月" }, { label: "信息性质", value: "风险预测" }, { label: "伤亡", value: "未公布（风险研判非灾情统计）" }],
    paragraphs: ["会商提示多地应关注阶段性暴雨、河流涨水以及地质灾害风险，具体区域和风险类型以官方原文为准。", "这份研判不证明某安置点已发生灾害；平台演练任务、商品价格及资金指标与新闻独立。" ]
  }
];

module.exports = { marketplace, demoTasks, enrichTask, disasterUpdates };
