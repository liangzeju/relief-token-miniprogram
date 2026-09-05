(function(){
  const fmt=n=>Number(n||0).toLocaleString("zh-CN");
  const $=s=>document.querySelector(s);
  const setText=(s,v)=>{const el=$(s); if(el)el.textContent=v;};
  const setHtml=(s,v)=>{const el=$(s); if(el)el.innerHTML=v;};
  const short=v=>v?String(v).slice(0,12)+"...":"待生成";
  const esc=v=>String(v==null?"":v).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
  let flowState=null;
  let flowBusy=false;
  let authGeneration=0;
  let latestState=ReliefApi.data();
  const terminalChain=["CONFIRMED","REVERTED","TIMEOUT","MANUAL_REVIEW"];
  const actorToken={finance:"demo-finance",compliance:"demo-compliance",verifier:"demo-verifier",approver:"demo-approver",supplier:"demo-supplier",acceptance:"demo-acceptance",dispatcher:"demo-dispatcher"};
  const statusText={PAYMENT_PENDING:"后端回调待入库",PAYMENT_CONFIRMED:"回调已验签",APPROVED:"合规已批准",MON_DEPOSIT_PENDING:"MON 存入待确认",MON_DEPOSIT_CONFIRMED:"MON 已入托管",DISPATCHING:"调度中",EXECUTING:"执行中",VERIFIED:"已核验",IN_PROGRESS:"履约中",FUNDS_RESERVED:"托管已确认",PENDING_SETTLEMENT:"待结算",SETTLEMENT_PENDING:"结算待兑换",SETTLED:"已完成"};
  const idem=label=>`admin-flow-${label}-${crypto.randomUUID()}`;
  const api=(path,actor,body)=>ReliefApi.request(path,{method:"POST",headers:{Authorization:`Bearer ${actorToken[actor]||actorToken.finance}`,"Idempotency-Key":idem(path.replace(/[^a-z0-9]+/gi,"-"))},body:JSON.stringify(body||{})});
  const getData=path=>ReliefApi.request(path).then(r=>r.data||[]);

  function render(state){
    latestState=state;
    setText("#deposited",fmt(state.dashboard.depositedMon)+" MON");
    setText("#available",fmt(state.dashboard.availableMon)+" MON");
    setText("#pending",state.dashboard.pendingReview);
    setText("#events",state.dashboard.chainEvents);
    setText("#participants",fmt(state.dashboard.participantCount||0));
    setText("#participantDelta","已登记救援人员 · 后端同步");
    renderDonations(state);
    renderTasks(state);
    renderContracts(state);
    renderProcess(state);
    renderWatermark(state);
    renderAlgorithm(state);
    renderMarket(state);
    renderMarketOrders(state);
    setHtml("#auditList",(state.traces||[]).slice(0,6).map(event=>`<article class="audit-item"><i aria-hidden="true"></i><div><strong>${esc(event.title)}</strong><p>${esc(event.detail)}</p><small>${esc(event.ref)} · ${esc(event.txHash||"待确认")}</small></div><time>${esc(String(event.time||"").slice(0,10))}</time></article>`).join("")||'<p>暂无链上事件。</p>');
    renderPermissions(state);
    renderPolicyFallbacks(state);
  }

  function renderDonations(s){
    setHtml("#donationRows",s.donations.map(x=>`<tr><td>${esc(x.id)}</td><td>${esc(x.donor)}</td><td>${fmt(x.monAmount??x.monIntentAmount)}</td><td><span class="tag ${x.status==="MON_DEPOSIT_CONFIRMED"?"green":"amber"}">${esc(x.status==="MON_REVIEW_PENDING"?"MON 入账待核验":statusText[x.status]||x.status)}</span></td><td>${esc(x.watermarkId||"待登记")}</td><td><button class="small-button" data-detail="fund-${esc(x.id)}">详情</button></td></tr>`).join(""));
  }
  function renderTasks(s){
    setHtml("#taskRows",s.tasks.map(x=>`<button class="task-row detail-button" data-detail="task-${esc(x.id)}"><div><strong>${esc(x.location||"待补充位置")}</strong><small>${esc(x.id)} · ${esc(x.type||x.taskType)} · ${esc(x.need||(x.requirements&&x.requirements.material)||"需求待补充")}</small></div><span class="tag ${(x.verified||x.verificationStatus==="VERIFIED")?"green":"amber"}">${esc(statusText[x.status]||x.status)}</span></button>`).join(""));
  }
  function renderContracts(s){
    setHtml("#contractRows",s.contracts.map(x=>`<button class="contract-row detail-button" data-detail="contract-${esc(x.id)}"><div><strong>${esc(x.party)}</strong><small>${esc(x.id)} · ${esc(x.subject)}</small><div class="progress"><i style="width:${Math.min(100,Math.max(0,Number(x.progress||0)))}%"></i></div></div><span class="contract-amount">${fmt(x.amountMon)} MON</span></button>`).join(""));
  }
  function renderProcess(s){
    const visuals=s.processVisuals&&s.processVisuals.length?s.processVisuals:[
      {title:"API Gateway",value:"写请求幂等键",detail:"所有管理端动作经角色 token、状态机和审计事件处理。"},
      {title:"Relayer/HSM",value:"只提交已批准交易",detail:"业务审批和链上运营分离，不能改金额或水印关系。"},
      {title:"Indexer",value:`${s.chainTransactions.length} 笔交易`,detail:"监听 Monad receipt、确认数和事件日志。"},
      {title:"Reconciler",value:`${fmt(s.dashboard.availableMon)} MON`,detail:"对账链上托管余额、链下 ledger 和水印 lot。"}
    ];
    setHtml("#processVisuals",visuals.map(x=>`<article class="process-card"><span>${x.value||"OK"}</span><strong>${esc(x.title)}</strong><p>${esc(x.detail||x.signal||"等待后端指标")}</p><small>${esc(x.status||"可观察")}</small></article>`).join(""));
  }
  function renderWatermark(s){
    const d=s.donations[0]||{};
    const c=s.contracts.find(x=>x.watermarkId===d.watermarkId)||s.contracts[0]||{};
    const nodes=[["捐赠 lot",d.watermarkId||"WM-PENDING"],["任务分配",c.taskId||"TASK-PENDING"],["合同托管",c.id||"CTR-PENDING"],["交付验收","DELIVERY"],["兑付完成","FINISHED"]];
    setHtml("#watermarkGraph",nodes.map((x,i)=>`<div class="watermark-node ${i===0?"active":""}"><strong>${x[0]}</strong><span>${x[1]}</span></div>`).join(""));
  }
  function renderAlgorithm(s){
    const plan=(s.allocationPlans||[])[0];
    const steps=plan?plan.steps:[{title:"紧急度",value:35,detail:"生命救援优先"},{title:"位置与时效",value:25,detail:"ETA 和道路可达性"},{title:"资源匹配",value:25,detail:"规格、资质、履约历史"},{title:"资金政策",value:15,detail:"用途限制与可用 MON"}];
    const candidates=plan&&plan.candidates?plan.candidates:[];
    setHtml("#algorithmPanel",`<div class="algorithm-title"><strong>${plan?plan.name:"任务队列推荐算法"}</strong><small>${plan?plan.algorithm:"Urgency x ETA x PolicyFit x CostEfficiency"}</small></div>${steps.map(x=>`<article class="detail-tile"><strong>${x.title}</strong><p>${x.detail}</p><span>${x.value} 分</span></article>`).join("")}${candidates.map(x=>`<div class="ledger-line"><span>${x.name}</span><strong>${fmt(x.costMon)} MON · ${x.score} 分${x.selected?" · 推荐":""}</strong></div>`).join("")}`);
  }
  function renderMarket(s){
    const rows=s.marketplace||[];
    setHtml("#marketRows",rows.map(x=>`<article class="resource-card"><img class="catalog-image" src="${esc(ReliefApi.url(x.image))}" alt="${esc(x.name)}示意图" loading="lazy"><span>${esc(x.category)}</span><strong>${esc(x.name)}</strong><p>${fmt(x.priceMon)} MON / ${esc(x.unit)} · 库存 ${fmt(x.stock)}</p><small>${esc(x.supplier)} · ETA ${fmt(x.etaHours)}h</small></article>`).join(""));
  }
  function renderMarketOrders(s){
    const orders=s.marketOrders||[];
    const labels={PENDING_REVIEW:"待审核",APPROVED:"已批准",REJECTED:"已驳回"};
    setText("#orderCount",`${orders.filter(x=>x.status==="PENDING_REVIEW").length} 笔待审核`);
    setHtml("#marketOrderRows",orders.length?orders.map(x=>`<tr><td>${esc(x.id)}<small class="order-date">${esc(new Date(x.createdAt).toLocaleString("zh-CN"))}</small></td><td>${esc(x.itemName)}</td><td>${esc(x.taskTitle||x.taskId)}</td><td>${fmt(x.quantity)}</td><td>${fmt(x.totalMon)}</td><td>${esc(labels[x.status]||x.status)}${x.contractId?`<br><button class="small-button" data-detail="contract-${esc(x.contractId)}">${esc(x.contractId)}</button>`:""}</td><td>${x.status==="PENDING_REVIEW"?`<button class="small-button" data-order="${esc(x.id)}" data-action="approve">批准并生成合同</button> <button class="small-button" data-order="${esc(x.id)}" data-action="reject">驳回</button>`:"已处理"}</td></tr>`).join(""):'<tr><td colspan="7">暂无物资申请。前台商城提交的申领将在此显示。</td></tr>');
  }
  function renderPermissions(s){
    const rows=s.permissions&&s.permissions.length?s.permissions:[
      {role:"财务",allow:"MON 存入、托管确认、结算复核",deny:"不能代替现场验收"},
      {role:"合规员",allow:"KYC/KYB、AML、冻结/解冻",deny:"不能直接签约"},
      {role:"官方核验员",allow:"灾情核验与任务批准",deny:"不能验收自己批准任务"},
      {role:"链上运营",allow:"提交/重试已批准交易",deny:"不能改变业务审批结论"}
    ];
    setHtml("#permissionPanel",rows.map(x=>`<div class="permission-row"><span>${esc(x.role)}</span><strong>${esc(x.allow||(x.actions||[]).join(" / "))}</strong><small>${esc(x.deny||x.scope||(x.write?"后端写权限":"只读审计"))}</small></div>`).join(""));
  }
  function renderPolicyFallbacks(s){
    setHtml("#fundDetails",[
      ["MON 取得","合规渠道或预存 MON",fmt((s.donations[0]||{}).monAmount)+" MON"],
      ["托管存入","NativeMonEscrow.depositMon",short((s.donations[0]||{}).depositTxHash)],
      ["水印 lot","WatermarkRegistry 登记根水印",(s.donations[0]||{}).watermarkId||"待登记"],
      ["可调度余额","链上确认后进入资金池",fmt(s.dashboard.availableMon)+" MON"]
    ].map((x,i)=>`<div class="process-card"><span>${String(i+1).padStart(2,"0")}</span><strong>${x[0]}</strong><p>${x[1]}</p><small>${x[2]}</small></div>`).join(""));
    setHtml("#chainPolicyDetails",[
      "公开 Monad：MON 存入、预算分配、Escrow、验收哈希、锁定、结算与 FINISHED 水印。",
      "私有层：身份、合同原文、未截止报价、联系方式和原始照片视频。",
      "资金水印：donation -> task -> contract -> delivery -> redemption，子 lot 保留父级血缘。"
    ].map(x=>`<li>${x}</li>`).join(""));
  }

  function showToast(message,error){const t=$("#toast"); if(!t)return; t.textContent=message; t.classList.toggle("error",!!error); t.classList.add("show"); setTimeout(()=>{t.classList.remove("show");t.classList.remove("error")},2600);}
  function openDrawer(title,body){const d=$("#detailDrawer"), b=$("#drawerBody"); if(!d||!b){showToast(title); return;} b.innerHTML=`<span class="kicker">DETAIL</span><h2>${title}</h2>${body}`; d.hidden=false;}
  function bindDetails(){
    document.querySelectorAll("[data-detail]").forEach(btn=>btn.onclick=()=>{
      const id=btn.dataset.detail;
      if(id.startsWith("task-")) return openTaskDetail(id.slice(5));
      if(id.startsWith("contract-")) return openContractDetail(id.slice(9));
      if(id.startsWith("fund-")) return openFundDetail(id.slice(5));
      if(id==="algorithm") return openAlgorithmDetail();
      if(id==="market") return openMarketDetail();
      if(id==="permissions") return openPermissionsDetail();
      if(id==="audit") return openAuditDetail();
      openDrawer("模块详情",`<p>该模块使用公开 Monad 事件和私有业务层哈希做可视化审计。</p>`);
    });
  }
  function kv(rows){return `<div class="drawer-kv">${rows.map(x=>`<span>${esc(x[0])}</span><strong>${esc(x[1])}</strong>`).join("")}</div>`;}
  async function downloadCertificate(id){
    try {
      const response=await fetch(ReliefApi.url(`/v1/donations/${encodeURIComponent(id)}/certificate`),{headers:{Authorization:"Bearer demo-platform-admin"}});
      if(!response.ok){const error=await response.json();throw new Error(error.error?.message||"证书尚未就绪");}
      const link=document.createElement("a");
      const objectUrl=URL.createObjectURL(await response.blob());
      link.href=objectUrl;link.download=`${id}-certificate.pdf`;link.click();
      setTimeout(()=>URL.revokeObjectURL(objectUrl),10000);
      showToast("PDF 演示证书已下载");
    }catch(error){showToast(error.message,true);}
  }
  function openFundDetail(id){
    const d=(latestState.donations||[]).find(x=>x.id===id); if(!d)return;
    const contracts=(latestState.contracts||[]).filter(x=>x.watermarkId===d.watermarkId);
    openDrawer(`资金水印 ${d.watermarkId||d.id}`,
      kv([["捐赠单",d.id],["捐赠方",d.donor],["Monad 入账",`${fmt(d.monAmount)} MON`],["Deposit tx",d.depositTxHash||d.txHash||"待确认"],["用途政策",(d.policy&&d.policy.purpose)||"按灾情优先级调度"],["公开查询",`/v1/public/trace/${d.watermarkId||d.id}`]])+
      `<div class="watermark-chain"><b>donation</b><i></i><b>task</b><i></i><b>contract</b><i></i><b>delivery</b><i></i><b>certificate</b></div>`+
      `<h3>关联合同</h3>${(contracts.length?contracts:[{id:"待分配",subject:"尚未进入具体救灾合同",amountMon:0}]).map(c=>`<p class="drawer-line">${esc(c.id)} · ${esc(c.subject)} · ${fmt(c.amountMon)} MON</p>`).join("")}`+
      `<button class="primary-button drawer-download" id="drawerCertificateBtn">下载 PDF 证书</button>`);
    const cert=$("#drawerCertificateBtn"); if(cert)cert.onclick=()=>downloadCertificate(d.id);
  }
  function openTaskDetail(id){
    const t=(latestState.tasks||[]).find(x=>x.id===id); if(!t)return;
    const target=Number(t.monTarget||t.poolNeedMon||0), raised=Number(t.monRaised||t.allocatedMon||0), gap=Math.max(0,target-raised);
    const sections=t.sections||t.subsections||[];
    openDrawer(`任务子页面 ${t.id}`,
      `<p class="drawer-lead">${esc(t.location)} · ${esc(t.need||(t.requirements&&t.requirements.material)||"需求待补充")}</p>`+
      kv([["紧急度",t.urgency||t.urgencyLabel||t.severity],["资金进度",`${fmt(raised)} / ${fmt(target)} MON`],["资金缺口",`${fmt(gap)} MON`],["参与人数",fmt(t.participants||0)],["伤情/风险",t.injuryEstimate||t.casualties||"待补充"]])+
      sections.map(s=>`<article class="subpage-card"><strong>${esc(s.title)}</strong><p>${esc(s.body||s.value||s.detail)}</p></article>`).join(""));
  }
  function openContractDetail(id){
    const c=(latestState.contracts||[]).find(x=>x.id===id); if(!c)return;
    const milestones=c.milestones||["合同签订","Monad 托管","交付批次","验收结算"];
    openDrawer(`合同履约 ${c.id}`,
      `<p class="drawer-lead">${esc(c.party)} · ${esc(c.subject)}</p>`+
      kv([["托管金额",`${fmt(c.amountMon)} MON`],["状态",c.status],["条款哈希",c.termsHash||"待锚定"],["水印",c.watermarkId||"待登记"],["Escrow tx",c.escrowTxHash||"待确认"]])+
      `<div class="milestone-list">${milestones.map(m=>typeof m==="string"?`<div><b>${esc(m)}</b><p>等待后端履约事件与证据哈希。</p></div>`:`<div class="${esc(m.status||"")}"><b>${esc(m.title)}</b><p>${esc(m.detail)}</p></div>`).join("")}</div>`);
  }
  function openAlgorithmDetail(){
    openDrawer("任务队列算法设计",(latestState.allocationPlans||[]).map(plan=>`<article class="subpage-card"><h3>${esc(plan.name)}</h3><p>${esc(plan.algorithm)}</p>${(plan.steps||[]).map(s=>`<div class="algo-step"><span>${esc(s.title)}</span><div class="metric-bar"><i style="width:${Number(s.value||0)}%"></i></div><small>${esc(s.detail)}</small></div>`).join("")}</article>`).join(""));
  }
  function openMarketDetail(){
    openDrawer("物资、人力与重建费用目录",`<div class="drawer-market">${(latestState.marketplace||[]).map(x=>`<article><span>${esc(x.category)}</span><strong>${esc(x.name)}</strong><p>${fmt(x.priceMon)} MON / ${esc(x.unit)} · 库存 ${fmt(x.stock)} · ETA ${fmt(x.etaHours)}h</p><small>${esc(x.supplier)}</small></article>`).join("")}</div>`);
  }
  function openPermissionsDetail(){
    openDrawer("权限与职责分离",`<div class="drawer-market">${(latestState.permissions||[]).map(x=>`<article><span>${x.write?"可写":"只读"}</span><strong>${esc(x.role)}</strong><p>${esc((x.actions||[]).join(" / "))}</p><small>${esc(x.key)}</small></article>`).join("")}</div><p class="drawer-note">资金写操作由后端角色、状态机、幂等键和审计事件控制；生产环境需接入组织 scope、多签/HSM 与职责分离。</p>`);
  }
  function openAuditDetail(){
    const net=latestState.network||{};
    openDrawer("Monad 链上审计",kv([["网络",net.name||"monad-testnet"],["Chain ID",net.chainId||10143],["Escrow",(net.contracts&&net.contracts.escrow)||net.contractAddress||"demo"],["Watermark",(net.contracts&&net.contracts.watermark)||"demo"]])+((latestState.chainTransactions||[]).map(tx=>`<p class="drawer-line">${esc(tx.action)} · ${esc(tx.businessId)} · ${esc(tx.status)} · ${esc(tx.txHash||"pending")}</p>`).join("")));
  }
  function loadFlow(){
    const ticket=authGeneration;
    return Promise.all([ReliefApi.liveData(),getData("/v1/chain/transactions"),getData("/v1/deliveries"),getData("/v1/settlements"),getData("/v1/redemptions")]).then(([overview,chainTransactions,deliveries,settlements,redemptions])=>{
      if(ticket!==authGeneration)throw Object.assign(new Error("登录状态已变化"),{code:"AUTH_CHANGED"});
      flowState=Object.assign({},overview,{chainTransactions,deliveries,settlements,redemptions});
      setText("#connectionStatus",overview.capabilities?.storage==="write-failed"?"存储故障 · 写入已停止":`已同步 ${new Date().toLocaleTimeString("zh-CN")}${overview.capabilities?.businessWritesEnabled?" · 演示模式":" · 历史记录只读"}`);
      render(flowState); renderFlow(flowState); bindDetails(); return flowState;
    });
  }
  const flowSteps=[
    {id:"compliance",title:"核验 MON 入账资格",actor:"compliance",detail:"核验前台登记的 MON 数量与用途，批准后提交 MON 入账。",candidate:s=>s.donations.find(d=>["MON_REVIEW_PENDING","PAYMENT_CONFIRMED"].includes(d.status)),status:s=>s.donations.some(d=>["MON_REVIEW_PENDING","PAYMENT_CONFIRMED"].includes(d.status))?"ready":(s.donations.some(d=>["APPROVED","MON_DEPOSIT_PENDING","MON_DEPOSIT_CONFIRMED"].includes(d.status))?"done":"waiting"),run:d=>api(`/v1/donations/${d.id}/compliance-review`,"compliance",{decision:"approve",reason:"demo-mon-acquisition-ready"})},
    {id:"deposit",title:"提交 MON 入托管",actor:"finance",detail:"创建 NativeMonEscrow.depositMon 交易与根水印。",candidate:s=>s.donations.find(d=>d.status==="APPROVED"&&!d.monAmount),status:s=>s.donations.some(d=>d.status==="APPROVED"&&!d.monAmount)?"ready":(s.donations.some(d=>d.monAmount)?"done":"waiting"),run:d=>api(`/v1/donations/${d.id}/mon-deposit`,"finance",{amountMon:Number(d.monIntentAmount||d.fiatAmount||0),priceSnapshot:{source:"demo-console",network:"monad-testnet",chainId:10143}})},
    {id:"deposit-chain",title:"确认 MON 入账上链",actor:"finance",detail:"推进 MON_DEPOSIT 到 CONFIRMED，确认后计入可调度余额。",candidate:s=>s.chainTransactions.find(t=>t.action==="MON_DEPOSIT"&&!terminalChain.includes(t.status)),status:s=>s.chainTransactions.some(t=>t.action==="MON_DEPOSIT"&&!terminalChain.includes(t.status))?"ready":(s.donations.some(d=>d.status==="MON_DEPOSIT_CONFIRMED")?"done":"waiting"),run:t=>api(`/v1/chain/transactions/${t.id}/advance`,"finance",{status:"CONFIRMED"})},
    {id:"task-verify",title:"核验灾情任务",actor:"verifier",detail:"确认位置、等级、需求和证据哈希。",candidate:s=>s.tasks.find(t=>t.verificationStatus!=="VERIFIED"),status:s=>s.tasks.some(t=>t.verificationStatus!=="VERIFIED")?"ready":(s.tasks.length?"done":"waiting"),run:t=>api(`/v1/tasks/${t.id}/verify`,"verifier",{})},
    {id:"task-approve",title:"批准任务进入调度",actor:"verifier",detail:"生成 TASK_APPROVED 链上交易，公开脱敏任务摘要。",candidate:s=>s.tasks.find(t=>t.verificationStatus==="VERIFIED"&&!t.approvalTxHash&&!s.chainTransactions.some(x=>x.action==="TASK_APPROVED"&&x.businessId===t.id)),status:s=>s.tasks.some(t=>t.verificationStatus==="VERIFIED"&&!t.approvalTxHash&&!s.chainTransactions.some(x=>x.action==="TASK_APPROVED"&&x.businessId===t.id))?"ready":(s.chainTransactions.some(x=>x.action==="TASK_APPROVED")||s.tasks.some(t=>t.approvalTxHash)?"done":"waiting"),run:t=>api(`/v1/tasks/${t.id}/approve`,"verifier",{})},
    {id:"task-chain",title:"确认任务审批上链",actor:"finance",detail:"确认 TASK_APPROVED，任务进入公开调度队列。",candidate:s=>s.chainTransactions.find(t=>t.action==="TASK_APPROVED"&&!terminalChain.includes(t.status)),status:s=>s.chainTransactions.some(t=>t.action==="TASK_APPROVED"&&!terminalChain.includes(t.status))?"ready":(s.tasks.some(t=>t.approvalTxHash)?"done":"waiting"),run:t=>api(`/v1/chain/transactions/${t.id}/advance`,"finance",{status:"CONFIRMED"})},
    {id:"escrow-submit",title:"提交合同 MON 托管",actor:"approver",detail:"按中选方案创建 ESCROW_CREATED 交易。",candidate:s=>s.contracts.find(c=>c.status==="PENDING_APPROVAL"),status:s=>s.contracts.some(c=>c.status==="PENDING_APPROVAL")?"ready":(s.contracts.some(c=>["FUNDS_RESERVATION_PENDING","FUNDS_RESERVED","IN_PROGRESS","PENDING_SETTLEMENT","SETTLEMENT_PENDING","SETTLED"].includes(c.status))?"done":"waiting"),run:c=>api(`/v1/contracts/${c.id}/approve`,"approver",{})},
    {id:"escrow-chain",title:"确认合同托管上链",actor:"finance",detail:"确认 EscrowCreated 后再做链下分账扣划。",candidate:s=>s.chainTransactions.find(t=>t.action==="ESCROW_CREATED"&&!terminalChain.includes(t.status)),status:s=>s.chainTransactions.some(t=>t.action==="ESCROW_CREATED"&&!terminalChain.includes(t.status))?"ready":(s.contracts.some(c=>["FUNDS_RESERVED","IN_PROGRESS","PENDING_SETTLEMENT","SETTLEMENT_PENDING","SETTLED"].includes(c.status))?"done":"waiting"),run:t=>api(`/v1/chain/transactions/${t.id}/advance`,"finance",{status:"CONFIRMED"})},
    {id:"escrow-confirm",title:"确认托管扣划",actor:"finance",detail:"根水印 lot 拆分为合同 escrow lot。",candidate:s=>s.contracts.find(c=>c.status==="FUNDS_RESERVATION_PENDING"&&c.chainTransactionId&&s.chainTransactions.some(t=>t.id===c.chainTransactionId&&t.status==="CONFIRMED")),status:s=>s.contracts.some(c=>c.status==="FUNDS_RESERVATION_PENDING"&&c.chainTransactionId&&s.chainTransactions.some(t=>t.id===c.chainTransactionId&&t.status==="CONFIRMED"))?"ready":(s.contracts.some(c=>["FUNDS_RESERVED","IN_PROGRESS","PENDING_SETTLEMENT","SETTLEMENT_PENDING","SETTLED"].includes(c.status))?"done":"waiting"),run:c=>api(`/v1/contracts/${c.id}/escrow-confirm`,"finance",{escrowReference:`DEMO-ESCROW-${c.id}`})},
    {id:"delivery",title:"创建履约交付批次",actor:"supplier",detail:"提交物资、救援队或重建工程批次及证据哈希。",candidate:s=>s.contracts.find(c=>["FUNDS_RESERVED","IN_PROGRESS"].includes(c.status)&&!s.deliveries.some(d=>d.contractId===c.id)),status:s=>s.contracts.some(c=>["FUNDS_RESERVED","IN_PROGRESS"].includes(c.status)&&!s.deliveries.some(d=>d.contractId===c.id))?"ready":(s.deliveries.length?"done":"waiting"),run:c=>api(`/v1/contracts/${c.id}/deliveries`,"supplier",{plannedQuantity:Number(c.plannedQuantity||1),evidenceIds:["demo-evidence-001"]})},
    {id:"acceptance",title:"验收交付批次",actor:"acceptance",detail:"验收员确认数量、质量和凭证哈希。",candidate:s=>s.deliveries.find(d=>d.status==="IN_PROGRESS"),status:s=>s.deliveries.some(d=>d.status==="IN_PROGRESS")?"ready":(s.deliveries.some(d=>d.status==="ACCEPTED")?"done":"waiting"),run:d=>api(`/v1/deliveries/${d.id}/accept`,"acceptance",{deliveredQuantity:d.plannedQuantity,acceptedQuantity:d.plannedQuantity,result:"accepted"})},
    {id:"settlement",title:"创建 MON 结算单",actor:"finance",detail:"按验收数量、单价、附加费和扣款生成结算申请。",candidate:s=>s.contracts.find(c=>c.status==="PENDING_SETTLEMENT"),status:s=>s.contracts.some(c=>c.status==="PENDING_SETTLEMENT")?"ready":(s.settlements.length?"done":"waiting"),run:c=>api(`/v1/contracts/${c.id}/settlements`,"finance",{acceptedAmountMon:Number(c.amountMon||0)})},
    {id:"redemption",title:"发起组织兑付申请",actor:"finance",detail:"绑定已验证收款账户与兑换规则版本，提交 MON 锁定申请。",candidate:s=>s.settlements.find(x=>x.status==="SETTLEMENT_PENDING"&&!x.redemptionId),status:s=>s.settlements.some(x=>x.status==="SETTLEMENT_PENDING"&&!x.redemptionId)?"ready":(s.redemptions.length?"done":"waiting"),run:x=>api(`/v1/settlements/${x.id}/redemptions`,"finance",{monAmount:Number(x.acceptedAmountMon||0),fiatAmount:Number(x.acceptedAmountMon||0),payoutAccountId:"demo-payout-account",exchangeRuleVersion:1})},
    {id:"redemption-approve",title:"审批并锁定 MON",actor:"compliance",detail:"复核账户后创建 MON_LOCKED 交易。",candidate:s=>s.redemptions.find(r=>r.status==="REQUESTED"),status:s=>s.redemptions.some(r=>r.status==="REQUESTED")?"ready":(s.redemptions.some(r=>["MON_LOCK_PENDING","MON_LOCKED","PAID","SETTLEMENT_CHAIN_PENDING","SETTLED"].includes(r.status))?"done":"waiting"),run:r=>api(`/v1/redemptions/${r.id}/approve`,"compliance",{})},
    {id:"lock-chain",title:"确认 MON 锁定上链",actor:"finance",detail:"确认锁定交易，防止重复兑付。",candidate:s=>s.chainTransactions.find(t=>t.action==="MON_LOCKED"&&!terminalChain.includes(t.status)),status:s=>s.chainTransactions.some(t=>t.action==="MON_LOCKED"&&!terminalChain.includes(t.status))?"ready":(s.redemptions.some(r=>["MON_LOCKED","PAID","SETTLEMENT_CHAIN_PENDING","SETTLED"].includes(r.status))?"done":"waiting"),run:t=>api(`/v1/chain/transactions/${t.id}/advance`,"finance",{status:"CONFIRMED"})},
    {id:"payout",title:"登记兑付回执",actor:"finance",detail:"记录支付机构回执哈希；原始凭证留在私有层。",candidate:s=>s.redemptions.find(r=>r.status==="MON_LOCKED"),status:s=>s.redemptions.some(r=>r.status==="MON_LOCKED")?"ready":(s.redemptions.some(r=>["PAID","SETTLEMENT_CHAIN_PENDING","SETTLED"].includes(r.status))?"done":"waiting"),run:r=>api(`/v1/redemptions/${r.id}/payout`,"finance",{fiatAmount:Number(r.fiatAmount||r.monAmount||0),payoutReference:`DEMO-PAYOUT-${r.id}`})},
    {id:"settle-submit",title:"提交最终 MON 结算",actor:"finance",detail:"兑付回执可核验后创建 MON_SETTLED 交易。",candidate:s=>s.redemptions.find(r=>r.status==="PAID"),status:s=>s.redemptions.some(r=>r.status==="PAID")?"ready":(s.redemptions.some(r=>["SETTLEMENT_CHAIN_PENDING","SETTLED"].includes(r.status))?"done":"waiting"),run:r=>api(`/v1/redemptions/${r.id}/settle`,"finance",{})},
    {id:"settle-chain",title:"完成水印 FINISHED",actor:"finance",detail:"确认 MON_SETTLED，WatermarkRegistry 标记终态。",candidate:s=>s.chainTransactions.find(t=>t.action==="MON_SETTLED"&&!terminalChain.includes(t.status)),status:s=>s.chainTransactions.some(t=>t.action==="MON_SETTLED"&&!terminalChain.includes(t.status))?"ready":(s.redemptions.some(r=>r.status==="SETTLED")?"done":"waiting"),run:t=>api(`/v1/chain/transactions/${t.id}/advance`,"finance",{status:"CONFIRMED"})}
  ];
  function renderFlow(s){
    if(!s)return;
    if(!s.capabilities?.businessWritesEnabled){
      setText("#flowProgress","只读"); setText("#flowStatus","旧演示流程已停用，正式业务闭环待接入");
      setHtml("#flowSteps",""); if($("#runNextBtn"))$("#runNextBtn").disabled=true; if($("#resetBtn"))$("#resetBtn").disabled=true;
      document.querySelectorAll("[data-order]").forEach(button=>{button.disabled=true;}); return;
    }
    const done=flowSteps.filter(x=>x.status(s)==="done").length;
    setText("#flowProgress",`${done} / ${flowSteps.length}`);
    setHtml("#flowSteps",flowSteps.map((step,index)=>{const st=step.status(s),candidate=step.candidate(s),label=st==="done"?"已完成":st==="ready"?"可执行":"等待前置",ref=candidate?(candidate.id||candidate.businessId):"";return `<article class="flow-step ${st}"><div class="flow-step-index">${String(index+1).padStart(2,"0")}</div><div class="flow-step-body"><div class="flow-step-title"><strong>${step.title}</strong><span class="tag ${st==="done"?"green":st==="ready"?"red":"amber"}">${label}</span></div><p>${step.detail}</p><small>${step.actor} · ${ref||"等待业务对象"}</small></div><button class="small-button flow-action" data-flow-step="${step.id}" ${st!=="ready"||flowBusy?"disabled":""}>${st==="ready"?"执行":"查看"}</button></article>`}).join(""));
    document.querySelectorAll("[data-flow-step]").forEach(btn=>btn.addEventListener("click",()=>runStep(btn.dataset.flowStep)));
  }
  function runStep(id){
    if(flowBusy||!flowState||!flowState.capabilities?.businessWritesEnabled)return;
    const step=flowSteps.find(x=>x.id===id),candidate=step&&step.candidate(flowState);
    if(!step||!candidate)return;
    flowBusy=true; setText("#flowStatus",`正在执行：${step.title}`); const run=$("#runNextBtn"),refresh=$("#refreshFlowBtn"); if(run)run.disabled=true; if(refresh)refresh.disabled=true; renderFlow(flowState);
    Promise.resolve(step.run(candidate)).then(()=>loadFlow()).then(()=>{setText("#flowStatus",`已完成：${step.title}`);showToast(`已完成「${step.title}」`);}).catch(err=>{const message=err&&err.message?err.message:"请求失败";setText("#flowStatus",`执行失败：${message}`);showToast(`执行失败：${message}`,true);}).finally(()=>{flowBusy=false;if(run)run.disabled=false;if(refresh)refresh.disabled=false;renderFlow(flowState);});
  }
  const runNext=$("#runNextBtn"); if(runNext)runNext.addEventListener("click",()=>{if(!flowState)return; const step=flowSteps.find(x=>x.status(flowState)==="ready"); if(step)runStep(step.id); else {setText("#flowStatus","暂无可执行步骤，请检查前置条件或刷新数据");showToast("当前没有可执行步骤",true);}});
  const refresh=$("#refreshFlowBtn"); if(refresh)refresh.addEventListener("click",()=>{if(flowBusy)return;setText("#flowStatus","正在刷新...");loadFlow().then(()=>setText("#flowStatus","流程状态已更新")).catch(()=>{setText("#flowStatus","刷新失败");showToast("刷新失败，请检查后端服务",true);});});
  const close=$("#drawerClose"); if(close)close.addEventListener("click",()=>{$("#detailDrawer").hidden=true;});
  const refreshBtn=$("#refreshBtn"); if(refreshBtn)refreshBtn.addEventListener("click",()=>loadFlow().catch(()=>showToast("刷新失败，请检查后端服务",true)));
  const resetBtn=$("#resetBtn"); if(resetBtn)resetBtn.addEventListener("click",()=>{if(!window.confirm("确定重置演示数据吗？此操作会清除本地 Demo 操作记录。"))return;ReliefApi.request("/v1/demo/reset",{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()}}).then(()=>loadFlow()).then(()=>showToast("演示数据已重置")).catch(()=>showToast("重置失败，请检查后端服务",true));});
  const receipt=$("#receiptBtn"); if(receipt)receipt.addEventListener("click",()=>showToast("PDF 凭证将在 MON 存入并上链确认后生成"));
  document.addEventListener("click",async event=>{
    const button=event.target.closest("[data-order]");
    if(!button||flowBusy)return;
    flowBusy=true;
    button.disabled=true;
    try {
      await ReliefApi.request(`/v1/market-orders/${encodeURIComponent(button.dataset.order)}/${button.dataset.action}`,{method:"POST",headers:{"Idempotency-Key":idem(button.dataset.order+button.dataset.action)},body:JSON.stringify({})});
      await loadFlow();
      showToast(button.dataset.action==="approve"?"申领已批准，合同已生成，等待托管审批":"申领已驳回");
    } catch(error){showToast(error.message,true);} finally {flowBusy=false;button.disabled=false;}
  });
  function refreshLive(){
    if(flowBusy||document.hidden)return;
    return loadFlow().catch(connectionError);
  }
  function clearPrivate(){
    authGeneration++; flowState=null; const empty=ReliefApi.clearData(); render(empty);
    setHtml("#flowSteps",""); if($("#detailDrawer"))$("#detailDrawer").hidden=true;
    if($("#drawerBody"))setHtml("#drawerBody","");
    if($("#runNextBtn"))$("#runNextBtn").disabled=true;
  }
  function connectionError(error){
    if(error.code==="AUTH_CHANGED")return;
    if([401,403].includes(error.status)){clearPrivate();setText("#connectionStatus",error.status===401?"请先验证管理权限":"当前身份无权访问");}
    else setText("#connectionStatus","连接中断 · 数据未更新");
  }
  window.addEventListener("relief:admin-auth",event=>{clearPrivate();if(event.detail?.authenticated)void loadFlow().catch(connectionError);else setText("#connectionStatus","请先验证管理权限");});
  loadFlow().catch(connectionError);
  setInterval(refreshLive,5000);
  window.addEventListener("focus",refreshLive);
}());
